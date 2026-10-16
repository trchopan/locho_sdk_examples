import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, type Transport } from '../src/session.js';

test('late connect is closed and cannot resurrect forgotten pairing', async () => {
  let resolve!: (value: Transport) => void;
  let closed = 0;
  const connection = new Promise<Transport>((done) => { resolve = done; });
  const session = new Session(async () => ({ key: 'host/api/tcp', label: 'api', connect: () => connection }));
  const pairing = session.pair('synthetic');
  await new Promise((done) => setTimeout(done, 0));
  session.forget();
  resolve({ fetch: async () => new Response(), close: async () => { closed++; } });
  await pairing;
  assert.equal(closed, 1); assert.equal(session.state.phase, 'unpaired');
});

test('authenticated 401 clears login while failed login preserves pairing', async () => {
  let authorized = false;
  const client: Transport = { close: async () => {}, fetch: async (path) => {
    if (path === '/health') return Response.json({ service: 'locho-notes', apiVersion: 1 });
    if (path === '/auth/login') { authorized = true; return Response.json({ token: 'synthetic', expiresAt: '2099', user: { id: '1', email: 'a' } }); }
    return authorized ? Response.json({ notes: [] }) : new Response('not JSON', { status: 401 });
  } };
  const session = new Session(async () => ({ key: 'scope', label: 'api', connect: async () => client }));
  await session.pair('synthetic'); await session.login('a', 'b');
  authorized = false; await session.refresh();
  assert.equal(session.state.phase, 'login'); assert.equal(session.state.user, undefined);
  assert.deepEqual(session.state.notes, []);
  session.disconnect(); await session.reconnect(); assert.equal(session.state.phase, 'login');
});

test('switching host never forwards the old application token', async () => {
  let leaked = false;
  const session = new Session(async (key) => ({ key, label: key, connect: async () => ({ close: async () => {}, fetch: async (path, options) => {
    if (key === 'second' && options?.headers?.Authorization) leaked = true;
    if (path === '/health') return Response.json({ service: 'locho-notes', apiVersion: 1 });
    if (path === '/auth/login') return Response.json({ token: 'old-token', expiresAt: '2099', user: { id: '1', email: 'a' } });
    return Response.json({ notes: [] });
  } }) }));
  await session.pair('first'); await session.login('a', 'password'); await session.pair('second');
  assert.equal(session.state.phase, 'login'); assert.equal(leaked, false);
});

test('interrupted mutation is never replayed and logout clears local auth', async () => {
  let writes = 0;
  const client: Transport = { close: async () => {}, fetch: async (path, options) => {
    if (path === '/health') return Response.json({ service: 'locho-notes', apiVersion: 1 });
    if (path === '/auth/login') return Response.json({ token: 'synthetic', expiresAt: '2099', user: { id: '1', email: 'a@example.test' } });
    if (path === '/api/notes' && options?.method === 'POST') { writes++; throw new Error('interrupted'); }
    return Response.json({ notes: [] });
  } };
  const session = new Session(async () => ({ key: 'key', label: 'api', connect: async () => client }));
  await session.pair('synthetic'); await session.login('a', 'password');
  await session.save('title', 'body');
  assert.equal(writes, 1); assert.match(session.state.message, /outcome unknown/);
  session.disconnect(); await session.logout(); await session.reconnect();
  assert.equal(session.state.phase, 'login');
});
