import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, addUser, tokenHash } from '../src/app.js';
import { Ajv } from 'ajv';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

const schemas = JSON.parse(
  readFileSync(new URL('../../../contracts/schemas.json', import.meta.url), 'utf8'),
);
const ajv = new Ajv();
ajv.addSchema(schemas, 'notes');
function conforms(name: string, value: unknown) {
  const validate = ajv.compile({ $ref: `notes#/definitions/${name}` });
  assert.equal(validate(value), true, ajv.errorsText(validate.errors));
}
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
async function fixture(options: Parameters<typeof createApp>[0] = {}) {
  const server = await createApp(options);
  const alice = await addUser(server.db, 'alice@example.test', ' alice-password ');
  const bob = await addUser(server.db, 'bob@example.test', 'bob-password');
  async function login(email = alice.email, password = ' alice-password ') {
    const response = await server.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    });
    assert.equal(response.statusCode, 200, response.body);
    conforms('Login', response.json());
    return response.json().token as string;
  }
  return { ...server, alice, bob, login };
}

test('health, contract-conforming login, normalization and password/token hashes', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const health = await f.app.inject('/health');
  conforms('Health', health.json());
  const token = await f.login(' ALICE@EXAMPLE.TEST ');
  const row = f.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(f.alice.id) as {
    password_hash: string;
  };
  assert.match(row.password_hash, /^\$argon2id\$v=19\$/);
  const parameters = row.password_hash.split('$')[3];
  assert.ok(parameters);
  assert.deepEqual(parameters.split(',').sort(), ['m=65536', 'p=1', 't=3']);
  const stored = f.db.prepare('SELECT token_hash FROM sessions').get() as { token_hash: string };
  assert.equal(stored.token_hash, tokenHash(token));
  assert.notEqual(stored.token_hash, token);
  const me = await f.app.inject({ url: '/api/me', headers: auth(token) });
  conforms('Me', me.json());
  assert.equal(me.json().user.id, f.alice.id);
  assert.equal(me.headers['cache-control'], 'no-store');
  const wrong = await f.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: f.alice.email, password: 'alice-password' },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json().error.code, 'invalid_credentials');
  const missing = await f.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: 'nobody@example.test', password: 'wrong' },
  });
  assert.deepEqual(missing.json(), wrong.json());
});

test('independent sessions, expiry boundary, logout revocation and missing auth', async (t) => {
  let now = Date.parse('2026-10-14T00:00:00Z');
  const f = await fixture({ clock: () => now, sessionLifetimeMs: 1000 });
  t.after(() => f.app.close());
  const first = await f.login();
  const second = await f.login();
  assert.notEqual(first, second);
  const logout = await f.app.inject({ method: 'POST', url: '/auth/logout', headers: auth(first) });
  assert.equal(logout.statusCode, 204);
  assert.equal(logout.body, '');
  assert.equal((await f.app.inject({ url: '/api/me', headers: auth(first) })).statusCode, 401);
  assert.equal((await f.app.inject({ url: '/api/me', headers: auth(second) })).statusCode, 200);
  now += 1000;
  const expired = await f.app.inject({ url: '/api/me', headers: auth(second) });
  assert.equal(expired.statusCode, 401);
  conforms('ApiError', expired.json());
  for (const headers of [{}, auth('invalid')]) {
    assert.equal((await f.app.inject({ url: '/api/notes', headers })).statusCode, 401);
  }
});

test('CRUD ownership, creation timestamps, sort tie break and bodyless deletion', async (t) => {
  let now = Date.parse('2026-10-14T00:00:00Z');
  const f = await fixture({ clock: () => now });
  t.after(() => f.app.close());
  const alice = await f.login();
  const bob = await f.login(f.bob.email, 'bob-password');
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers: auth(alice),
    payload: { title: ' First ', body: 'hello\nworld' },
  });
  assert.equal(created.statusCode, 201);
  conforms('NoteResult', created.json());
  const note = created.json().note;
  assert.equal(note.title, 'First');
  const second = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers: auth(alice),
    payload: { title: 'Second', body: '' },
  });
  const tied = await f.app.inject({ url: '/api/notes', headers: auth(alice) });
  conforms('Notes', tied.json());
  assert.deepEqual(
    tied.json().notes.map((n: { id: string }) => n.id),
    [note.id, second.json().note.id].sort(),
  );
  assert.deepEqual((await f.app.inject({ url: '/api/notes', headers: auth(bob) })).json(), {
    notes: [],
  });
  for (const method of ['PATCH', 'DELETE'] as const) {
    const response = await f.app.inject({
      method,
      url: `/api/notes/${note.id}`,
      headers: auth(bob),
      ...(method === 'PATCH' ? { payload: { title: 'steal' } } : {}),
    });
    assert.equal(response.statusCode, 404);
    conforms('ApiError', response.json());
  }
  now += 100;
  const updated = await f.app.inject({
    method: 'PATCH',
    url: `/api/notes/${note.id}`,
    headers: auth(alice),
    payload: { body: 'edited' },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().note.createdAt, note.createdAt);
  assert.notEqual(updated.json().note.updatedAt, note.updatedAt);
  assert.equal(
    (await f.app.inject({ url: '/api/notes', headers: auth(alice) })).json().notes[0].id,
    note.id,
  );
  const deleted = await f.app.inject({
    method: 'DELETE',
    url: `/api/notes/${note.id}`,
    headers: auth(alice),
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, '');
  assert.equal(
    (await f.app.inject({ method: 'DELETE', url: `/api/notes/${note.id}`, headers: auth(alice) }))
      .statusCode,
    404,
  );
});

test('strict fields, byte/scalar limits, malformed JSON, controls and payload limit', async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const token = await f.login();
  for (const payload of [
    { title: 'ok', body: '', extra: true },
    { title: '   ', body: '' },
    { title: 'ok', body: '💡'.repeat(4001) },
    { title: 'ok', body: '\u0000' },
    { title: '\uD800', body: '' },
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: auth(token),
      payload,
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    conforms('ApiError', response.json());
  }
  const unicode = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers: auth(token),
    payload: { title: '💡'.repeat(200), body: '💡'.repeat(4000) },
  });
  assert.equal(unicode.statusCode, 201);
  const emptyPatch = await f.app.inject({
    method: 'PATCH',
    url: `/api/notes/${unicode.json().note.id}`,
    headers: auth(token),
    payload: {},
  });
  assert.equal(emptyPatch.statusCode, 400);
  const malformed = await f.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: '{"password":"private-secret"',
  });
  assert.equal(malformed.statusCode, 400);
  assert.ok(!malformed.body.includes('private-secret'));
  const extraLogin = await f.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: f.alice.email, password: 'x', remember: true },
  });
  assert.equal(extraLogin.statusCode, 400);
  const huge = await f.app.inject({
    method: 'POST',
    url: '/auth/login',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: f.alice.email, password: 'x'.repeat(65536) }),
  });
  assert.equal(huge.statusCode, 413);
  conforms('ApiError', huge.json());
  const wrongType = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers: { ...auth(token), 'content-type': 'text/plain' },
    payload: 'hello',
  });
  assert.equal(wrongType.statusCode, 400);
});

test('note cap and per-normalized-email attempt limits with clock recovery', async (t) => {
  let now = 10000;
  const f = await fixture({ clock: () => now, loginAttempts: 2, loginWindowMs: 1000 });
  t.after(() => f.app.close());
  const token = await f.login();
  await f.login(' ALICE@EXAMPLE.TEST ');
  const limited = await f.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: f.alice.email, password: ' alice-password ' },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['retry-after'], '1');
  assert.equal(limited.json().error.code, 'rate_limited');
  await f.login(f.bob.email, 'bob-password'); // Not limited by a shared tunneled IP.
  now += 1000;
  await f.login();
  for (let i = 0; i < 100; i++) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: auth(token),
      payload: { title: `Note ${i}`, body: '' },
    });
    assert.equal(response.statusCode, 201);
  }
  const excess = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers: auth(token),
    payload: { title: 'Excess', body: '' },
  });
  assert.equal(excess.statusCode, 409);
  assert.equal(excess.json().error.code, 'note_limit');
});

test('SQLite persistence survives reopen and migration is idempotent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'locho-notes-'));
  const path = join(directory, 'notes.sqlite');
  try {
    const f = await fixture({ databasePath: path });
    const token = await f.login();
    const note = await f.app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: auth(token),
      payload: { title: 'Persistent', body: 'saved' },
    });
    assert.equal(note.statusCode, 201);
    await f.app.close();
    const reopened = await createApp({ databasePath: path });
    try {
      assert.equal(
        (await reopened.app.inject({ url: '/api/me', headers: auth(token) })).statusCode,
        200,
      );
      assert.equal(
        (await reopened.app.inject({ url: '/api/notes', headers: auth(token) })).json().notes[0]
          .body,
        'saved',
      );
    } finally {
      await reopened.app.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('logs/errors never expose passwords, bearer tokens or request URLs', async (t) => {
  let logs = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs += chunk.toString();
      callback();
    },
  });
  const f = await fixture({ logger: { level: 'info', stream } });
  t.after(() => f.app.close());
  const token = await f.login();
  await f.app.inject({ url: '/api/me?ticket=private-ticket', headers: auth(token) });
  await f.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email: f.alice.email, password: 'private-password' },
  });
  // Force a database error to prove the generic failure path is also sanitized.
  f.db.exec('DROP TABLE notes');
  const failure = await f.app.inject({ url: '/api/notes', headers: auth(token) });
  assert.equal(failure.statusCode, 500);
  conforms('ApiError', failure.json());
  for (const value of [
    token,
    'private-password',
    'private-ticket',
    'password_hash',
    'no such table',
  ]) {
    assert.ok(!logs.includes(value), `log contains ${value}`);
    assert.ok(!failure.body.includes(value));
  }
});

test('real localhost HTTP server serves health and closes cleanly', async () => {
  const { app } = await createApp();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/health`);
    assert.equal(response.status, 200);
    conforms('Health', await response.json());
  } finally {
    await app.close();
  }
});
