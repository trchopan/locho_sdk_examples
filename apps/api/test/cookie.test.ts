import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, addUser, tokenHash } from '../src/app.js';
import { openDatabase } from '../src/database.js';

const marker = { 'x-locho-session-mode': 'cookie' };
const credentials = { email: 'alice@example.test', password: 'cookie-demo-only' };
test('cookie login, CRUD, credential separation, logout and expired deletion', async (t) => {
  let now = Date.parse('2026-10-24T12:00:00Z');
  const { app, db } = await createApp({ clock: () => now, sessionLifetimeMs: 2000 });
  t.after(() => app.close());
  await addUser(db, credentials.email, credentials.password);
  const login = await app.inject({
    method: 'POST',
    url: '/browser/auth/login',
    headers: marker,
    payload: credentials,
  });
  assert.equal(login.statusCode, 200);
  assert.deepEqual(Object.keys(login.json()).sort(), ['expiresAt', 'user']);
  const field = login.headers['set-cookie'] as string;
  assert.match(
    field,
    /Path=\/browser\/; Expires=.*GMT; Max-Age=2; HttpOnly; Secure; SameSite=Strict$/,
  );
  const cookie = field.split(';')[0];
  assert.ok(cookie);
  const token = cookie.split('=')[1];
  assert.ok(token);
  const headers = { ...marker, cookie };
  assert.equal((await app.inject({ url: '/browser/api/me', headers })).statusCode, 200);
  const stored = db.prepare('SELECT token_hash, auth_mode FROM sessions').get();
  assert.equal(stored?.token_hash, tokenHash(token));
  assert.equal(stored?.auth_mode, 'cookie');
  assert.equal(
    (await app.inject({ url: '/api/me', headers: { authorization: `Bearer ${token}` } }))
      .statusCode,
    401,
  );
  const bearer = await app.inject({ method: 'POST', url: '/auth/login', payload: credentials });
  assert.equal(
    (
      await app.inject({
        url: '/browser/api/me',
        headers: { ...marker, cookie: `locho_notes_session=${bearer.json().token}` },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/me',
        headers: { authorization: `Bearer ${bearer.json().token}`, cookie },
      })
    ).statusCode,
    401,
  );
  const created = await app.inject({
    method: 'POST',
    url: '/browser/api/notes',
    headers,
    payload: { title: 'Cookie note', body: 'shared data' },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(
    (
      await app.inject({
        url: '/api/notes',
        headers: { authorization: `Bearer ${bearer.json().token}` },
      })
    ).json().notes[0].id,
    created.json().note.id,
  );
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/browser/api/notes/${created.json().note.id}`,
        headers,
        payload: { title: 'Updated' },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/browser/api/notes/${created.json().note.id}`,
        headers,
      })
    ).statusCode,
    204,
  );
  for (const bad of ['', 'locho_notes_session=bad', `${cookie}; ${cookie}`])
    assert.equal(
      (await app.inject({ url: '/browser/api/me', headers: { ...marker, cookie: bad } }))
        .statusCode,
      401,
    );
  const logout = await app.inject({ method: 'POST', url: '/browser/auth/logout', headers });
  assert.equal(logout.statusCode, 204);
  assert.match(logout.headers['set-cookie'] as string, /Max-Age=0; Expires=Thu, 01 Jan 1970/);
  assert.equal((await app.inject({ url: '/browser/api/me', headers })).statusCode, 401);
  const next = await app.inject({
    method: 'POST',
    url: '/browser/auth/login',
    headers: marker,
    payload: credentials,
  });
  const expired = { ...marker, cookie: (next.headers['set-cookie'] as string).split(';')[0] ?? '' };
  now += 2000;
  assert.equal((await app.inject({ url: '/browser/api/me', headers: expired })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'POST', url: '/browser/auth/logout', headers: expired }))
      .statusCode,
    204,
  );
});

test('cookie namespace rejects ambient/cross-origin/mixed authentication, including login', async (t) => {
  const { app } = await createApp();
  t.after(() => app.close());
  for (const headers of [
    {},
    { ...marker, origin: 'https://other.test' },
    { ...marker, origin: 'null' },
    { ...marker, 'sec-fetch-site': 'cross-site' },
    { ...marker, authorization: 'Bearer forbidden' },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/browser/auth/login',
      headers,
      payload: credentials,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
  }
});

test('v1 database migration preserves users, notes and bearer sessions', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'notes-cookie-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'notes.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT, created_at INTEGER, expires_at INTEGER, revoked_at INTEGER);
    INSERT INTO sessions VALUES ('synthetic-hash', 'alice', 1, 2, NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT, password_hash TEXT);
    INSERT INTO users VALUES ('alice', 'alice@example.test', 'synthetic-argon-hash');
    CREATE TABLE notes(id TEXT PRIMARY KEY, user_id TEXT, title TEXT, body TEXT);
    INSERT INTO notes VALUES ('note', 'alice', 'Preserved', 'Existing data');
    PRAGMA user_version=1;`);
  old.close();
  const migrated = openDatabase(path);
  assert.equal(migrated.prepare('PRAGMA user_version').get()?.user_version, 2);
  assert.equal(migrated.prepare('SELECT auth_mode FROM sessions').get()?.auth_mode, 'bearer');
  assert.equal(
    migrated.prepare('SELECT token_hash FROM sessions').get()?.token_hash,
    'synthetic-hash',
  );
  assert.equal(migrated.prepare('SELECT email FROM users').get()?.email, 'alice@example.test');
  assert.equal(migrated.prepare('SELECT body FROM notes').get()?.body, 'Existing data');
  migrated.close();
  openDatabase(path).close();
});
