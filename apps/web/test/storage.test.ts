import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, type Transport, type Pairing } from '../src/session.js';
import type { CredentialStore, SavedSession } from '../src/storage.js';

const auth = {
  token: 'synthetic-token',
  expiresAt: '2099',
  user: { id: 'a', email: 'a@example.test' },
};
function fixture(store: CredentialStore) {
  const calls: string[] = [];
  const client: Transport = {
    close: async () => {},
    fetch: async (path) => {
      calls.push(path);
      if (path === '/health') return Response.json({ service: 'locho-notes', apiVersion: 1 });
      if (path === '/api/me') return Response.json({ user: auth.user, expiresAt: auth.expiresAt });
      if (path === '/auth/login') return Response.json(auth);
      return Response.json({ notes: [] });
    },
  };
  const pairing: Pairing = {
    key: 'full-host/api/tcp',
    label: 'api',
    export: () => 'synthetic-ticket',
    connect: async () => client,
  };
  return { session: new Session(async () => pairing, store), calls };
}
test('restore validates health and me before authenticated content', async () => {
  const record: SavedSession = {
    version: 1,
    key: 'full-host/api/tcp',
    ticket: 'synthetic-ticket',
    auth,
  };
  const { session, calls } = fixture({ read: async () => record, replace: async () => {} });
  await session.restore();
  assert.deepEqual(calls, ['/health', '/api/me', '/api/notes']);
  assert.equal(session.state.phase, 'notes');
  assert.equal(session.state.remember, true);
});
test('forget during an in-flight save wins and cannot resurrect stored credentials', async () => {
  let record: SavedSession | undefined;
  let started!: () => void, release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const begin = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { session } = fixture({
    read: async () => record,
    replace: async (value) => {
      if (value) {
        started();
        await pending;
      }
      record = value;
    },
  });
  await session.pair('ticket');
  const save = session.setRemember(true);
  await begin;
  const forget = session.forget();
  release();
  await Promise.all([save, forget]);
  assert.equal(record, undefined);
  assert.equal(session.state.phase, 'unpaired');
});
test('remember off deletes saved state but retains live authenticated session', async () => {
  let record: SavedSession | undefined;
  const { session } = fixture({
    read: async () => record,
    replace: async (value) => {
      record = value;
    },
  });
  await session.pair('ticket');
  await session.setRemember(true);
  await session.login('a', 'password');
  assert.equal(record?.auth?.token, auth.token);
  await session.setRemember(false);
  assert.equal(record, undefined);
  assert.equal(session.state.phase, 'notes');
});
test('storage failure is visible and restore cannot override a forget', async () => {
  let finish!: (value: SavedSession) => void;
  const { session } = fixture({
    read: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    replace: async () => {
      throw new Error('disk');
    },
  });
  const restore = session.restore();
  await session.forget();
  finish({ version: 1, key: 'full-host/api/tcp', ticket: 'ticket', auth });
  await restore;
  assert.equal(session.state.phase, 'unpaired');
  assert.match(session.state.storageError, /Storage failed/);
});
test('page restoration reconnects only while explicit user intent remains active', async () => {
  const { session, calls } = fixture({ read: async () => undefined, replace: async () => {} });
  await session.pair('ticket');
  await session.login('a', 'password');
  session.suspend();
  await session.resume();
  assert.equal(session.state.phase, 'notes');
  const count = calls.length;
  session.disconnect();
  session.suspend();
  await session.resume();
  assert.equal(calls.length, count);
  assert.equal(session.state.phase, 'disconnected');
});

test('invalid saved session removes only token and persists pairing', async () => {
  let record: SavedSession | undefined = {
    version: 1,
    key: 'scope',
    ticket: 'synthetic-ticket',
    auth,
  };
  const client: Transport = {
    close: async () => {},
    fetch: async (path) =>
      path === '/health'
        ? Response.json({ service: 'locho-notes', apiVersion: 1 })
        : new Response('', { status: 401 }),
  };
  const session = new Session(
    async () => ({
      key: 'scope',
      label: 'api',
      export: () => 'synthetic-ticket',
      connect: async () => client,
    }),
    {
      read: async () => record,
      replace: async (value) => {
        record = value;
      },
    },
  );
  await session.restore();
  assert.equal(record?.ticket, 'synthetic-ticket');
  assert.equal(record?.auth, undefined);
  assert.equal(session.state.phase, 'login');
  assert.equal(session.state.busy, false);
  assert.deepEqual(session.state.notes, []);
});

test('expiry hides private content immediately but exposes login only after token removal settles', async () => {
  let record: SavedSession | undefined = {
    version: 1,
    key: 'scope',
    ticket: 'synthetic-ticket',
    auth,
  };
  let invalid = false,
    blocked = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: Transport = {
    close: async () => {},
    fetch: async (path) => {
      if (path === '/health') return Response.json({ service: 'locho-notes', apiVersion: 1 });
      if (invalid) return new Response(null, { status: 401 });
      return Response.json(
        path === '/api/me' ? { user: auth.user, expiresAt: auth.expiresAt } : { notes: [] },
      );
    },
  };
  const session = new Session(
    async () => ({
      key: 'scope',
      label: 'api',
      export: () => 'synthetic-ticket',
      connect: async () => client,
    }),
    {
      read: async () => record,
      replace: async (value) => {
        if (blocked) await pending;
        record = value;
      },
    },
  );
  await session.restore();
  invalid = true;
  blocked = true;
  const refresh = session.refresh();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.state.user, undefined);
  assert.deepEqual(session.state.notes, []);
  assert.notEqual(session.state.phase, 'login');
  assert.equal(session.state.storageBusy, true);
  release();
  await refresh;
  assert.equal(record?.auth, undefined);
  assert.equal(session.state.phase, 'login');
});

test('transport recovery validates health/session and does not replay writes', async () => {
  let transportState = 'connected';
  let connections = 0,
    writes = 0,
    checks = 0;
  const client: Transport = {
    get status() {
      return { state: transportState };
    },
    close: async () => {},
    fetch: async (path, options) => {
      if (path === '/health') {
        checks++;
        return Response.json({ service: 'locho-notes', apiVersion: 1 });
      }
      if (path === '/api/me') return Response.json({ user: auth.user, expiresAt: auth.expiresAt });
      if (path === '/auth/login') return Response.json(auth);
      if (options?.method === 'POST') {
        writes++;
        throw new Error('transport');
      }
      return Response.json({ notes: [] });
    },
  };
  const session = new Session(async () => ({
    key: 'scope',
    label: 'api',
    connect: async () => {
      connections++;
      return client;
    },
  }));
  await session.pair('ticket');
  await session.login('a', 'b');
  await session.save('title', 'body');
  transportState = 'reconnecting';
  await session.observeTransport();
  assert.equal(session.state.phase, 'disconnected');
  assert.deepEqual(session.state.notes, []);
  transportState = 'connected';
  await session.observeTransport();
  assert.equal(session.state.phase, 'notes');
  assert.equal(connections, 2);
  assert.equal(checks, 2);
  assert.equal(writes, 1);
});
