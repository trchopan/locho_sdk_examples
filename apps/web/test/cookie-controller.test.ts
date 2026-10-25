import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, type Transport } from '../src/session.js';
import type { CredentialStore } from '../src/storage.js';

function fixture() {
  let connections = 0;
  let expired = false;
  const calls: { path: string; headers?: Record<string, string> }[] = [];
  const me = {
    user: { id: 'alice', email: 'alice@example.test' },
    expiresAt: '2099-01-01T00:00:00Z',
  };
  const client: Transport = {
    close: async () => {},
    fetch: async (path, options) => {
      calls.push({ path, headers: options?.headers });
      if (path === '/health') return Response.json({ service: 'locho-notes', apiVersion: 1 });
      if (path === '/auth/login' || path === '/api/me') return Response.json(me);
      if (path === '/auth/logout') return new Response(null, { status: 204 });
      if (expired) return new Response(null, { status: 401 });
      return Response.json({ notes: [] });
    },
  };
  const store: CredentialStore = {
    read: async () => {
      throw new Error('Cookie mode must not read bearer storage');
    },
    replace: async () => {
      throw new Error('Cookie mode must not write bearer storage');
    },
  };
  const session = new Session(
    async (key) => ({
      key,
      label: key,
      connect: async () => {
        connections++;
        return client;
      },
    }),
    store,
    {},
    'cookie',
  );
  return {
    session,
    calls,
    connections: () => connections,
    expire: () => {
      expired = true;
    },
  };
}

test('cookie controller uses user/expiry without fake tokens, storage or bearer headers', async () => {
  const f = fixture();
  await f.session.restore();
  await f.session.setRemember(true);
  assert.equal(f.session.state.remember, false);
  await f.session.pair('host');
  await f.session.login('alice@example.test', 'synthetic-password');
  assert.equal(f.session.state.phase, 'notes');
  await f.session.logout();
  assert.equal(f.calls.filter(({ path }) => path === '/auth/logout').length, 1);
  assert.equal(f.session.state.message, 'Logged out. Reconnect to log in.');
  assert.equal(
    f.calls.every(({ headers }) => headers?.Authorization === undefined),
    true,
  );
});

test('cookie recovery preserves surviving owner but explicit reconnect removes local authentication', async () => {
  const f = fixture();
  await f.session.pair('host');
  await f.session.login('alice@example.test', 'synthetic-password');
  await f.session.observeTransport({ state: 'reconnecting' });
  assert.equal(f.session.state.phase, 'disconnected');
  assert.deepEqual(f.session.state.notes, []);
  await f.session.observeTransport({ state: 'connected' });
  assert.equal(f.session.state.phase, 'notes');
  assert.equal(f.connections(), 1);
  f.session.disconnect();
  await f.session.reconnect();
  assert.equal(f.session.state.phase, 'login');
  await f.session.login('alice@example.test', 'synthetic-password');
  f.expire();
  await f.session.refresh();
  assert.equal(f.session.state.phase, 'login');
  assert.equal(f.session.state.user, undefined);
  f.session.workerReset();
  assert.equal(f.session.state.phase, 'unpaired');
  assert.equal(f.session.state.message, 'Service-worker session lost. Pair and log in again.');
});
