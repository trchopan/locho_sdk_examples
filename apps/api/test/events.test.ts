import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, addUser } from '../src/app.js';
import { NoteEvents, EVENT_LIMITS } from '../src/events.js';

async function fixture() {
  let now = Date.now();
  const f = await createApp({ clock: () => now, eventsTickMs: 20, sessionLifetimeMs: 10000 });
  await addUser(f.db, 'alice@example.test', 'password');
  await addUser(f.db, 'bob@example.test', 'password');
  const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  async function login(email: string) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'password' },
    });
    return response.json().token as string;
  }
  const headers = (token: string) => ({ authorization: `Bearer ${token}` });
  async function open(token: string) {
    const abort = new AbortController();
    const response = await fetch(`${address}/api/events`, {
      headers: headers(token),
      signal: abort.signal,
    });
    const body = response.body;
    assert.ok(body);
    const reader = body.getReader();
    let buffered = '';
    return {
      response,
      abort,
      reader,
      async frame() {
        while (!buffered.includes('\n\n')) {
          const result = await reader.read();
          if (result.done) return undefined;
          buffered += new TextDecoder().decode(result.value);
        }
        const index = buffered.indexOf('\n\n');
        const value = buffered.slice(0, index);
        buffered = buffered.slice(index + 2);
        return value;
      },
    };
  }
  return {
    ...f,
    address,
    login,
    headers,
    open,
    expire: () => {
      now += 10001;
    },
  };
}

test('live SSE is incremental, scoped and emits committed CRUD invalidations only', {
  timeout: 10000,
}, async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const alice = await f.login('alice@example.test'),
    bob = await f.login('bob@example.test');
  const a = await f.open(alice),
    b = await f.open(bob);
  t.after(() => {
    a.abort.abort();
    b.abort.abort();
  });
  assert.equal(a.response.status, 200);
  const contentType = a.response.headers.get('content-type');
  assert.ok(contentType);
  assert.match(contentType, /^text\/event-stream/);
  assert.equal(a.response.headers.get('cache-control'), 'no-store');
  assert.equal(await a.frame(), ': connected');
  assert.equal(await b.frame(), ': connected');
  const created = await f.app.inject({
    method: 'POST',
    url: '/api/notes',
    headers: f.headers(alice),
    payload: { title: 'private', body: 'not in event' },
  });
  const id = created.json().note.id;
  async function change(operation: string) {
    for (let i = 0; i < 20; i++) {
      const frame = await a.frame();
      if (frame?.startsWith('event:')) {
        assert.equal(
          frame,
          `event: note.changed\ndata: ${JSON.stringify({ operation, noteId: id })}`,
        );
        return;
      }
    }
    assert.fail('No incremental event');
  }
  await change('created');
  // Bob receives only heartbeat comments even after Alice's successful mutation.
  assert.equal(await b.frame(), ': heartbeat');
  const denied = await f.app.inject({
    method: 'PATCH',
    url: `/api/notes/${id}`,
    headers: f.headers(bob),
    payload: { title: 'steal' },
  });
  assert.equal(denied.statusCode, 404);
  assert.equal(await b.frame(), ': heartbeat');
  await f.app.inject({
    method: 'PATCH',
    url: `/api/notes/${id}`,
    headers: f.headers(alice),
    payload: { body: 'edited' },
  });
  await change('updated');
  await f.app.inject({ method: 'DELETE', url: `/api/notes/${id}`, headers: f.headers(alice) });
  await change('deleted');
  await a.reader.cancel();
  const fresh = await f.open(alice);
  t.after(() => fresh.abort.abort());
  assert.equal(await fresh.frame(), ': connected');
  assert.equal(await fresh.frame(), ': heartbeat'); // no history replay
});

test('admission auth/capacity, cancellation, revocation, expiry and active shutdown', {
  timeout: 10000,
}, async () => {
  const f = await fixture();
  const open: Awaited<ReturnType<typeof f.open>>[] = [];
  try {
    const unauthorized = await fetch(`${f.address}/api/events`);
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).error.code, 'invalid_session');
    const token = await f.login('alice@example.test');
    for (let i = 0; i < 4; i++) open.push(await f.open(token));
    const excess = await fetch(`${f.address}/api/events`, { headers: f.headers(token) });
    assert.equal(excess.status, 429);
    assert.equal((await excess.json()).error.code, 'rate_limited');
    assert.equal(excess.headers.get('retry-after'), '30');
    const first = open[0];
    assert.ok(first);
    await first.reader.cancel();
    // Socket close and capacity reclamation are asynchronous.
    let replacement: Awaited<ReturnType<typeof f.open>> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await f.open(token);
      if (response.response.status === 200) {
        replacement = response;
        break;
      }
      await response.reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(replacement);
    open.push(replacement);
    // Keep a different session's stream live through the first session's logout.
    await replacement.reader.cancel();
    const independent = await f.login('alice@example.test');
    let active: Awaited<ReturnType<typeof f.open>> | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await f.open(independent);
      if (response.response.status === 200) {
        active = response;
        break;
      }
      await response.reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(active);
    open.push(active);
    assert.equal(await active.frame(), ': connected');
    await f.app.inject({ method: 'POST', url: '/auth/logout', headers: f.headers(token) });
    for (const connection of open.slice(1, -1)) {
      try {
        while (!(await connection.reader.read()).done) {
          /* drain prior comments */
        }
      } catch {
        /* revoked streams may reset */
      }
    }
    assert.equal(await active.frame(), ': heartbeat');
    f.expire();
    // Recheck timer closes an otherwise idle stream without a new mutation.
    try {
      while (!(await active.reader.read()).done) {
        /* bounded test timeout */
      }
    } catch {
      /* expiry may reset */
    }
    const freshToken = await f.login('bob@example.test');
    open.push(await f.open(freshToken));
    await f.app.close();
  } finally {
    for (const connection of open) connection.abort.abort();
    await f.app.close();
  }
});

test('publication checks authorization immediately and database errors fail closed', () => {
  let valid = true;
  const events = new NoteEvents(() => {
    if (!valid) throw new Error('database unavailable');
    return true;
  });
  try {
    const stream = events.subscribe('user', 'hash');
    assert.ok(stream);
    valid = false;
    events.publish('user', { operation: 'updated', noteId: 'note' });
    assert.equal(stream.destroyed, true);
    assert.equal(events.active, 0);
  } finally {
    events.close();
  }
});

test('slow consumers are disconnected with bounded buffering and aggregate capacity', async () => {
  const events = new NoteEvents(() => true);
  try {
    const slow = events.subscribe('user', 'hash');
    assert.ok(slow);
    for (let i = 0; i < 200; i++)
      events.publish('user', { operation: 'updated', noteId: 'x'.repeat(36) });
    assert.equal(slow.destroyed, true);
    assert.equal(events.active, 0);
    for (let i = 0; i < EVENT_LIMITS.total; i++) assert.ok(events.subscribe(`user-${i}`, 'hash'));
    assert.equal(events.subscribe('other', 'hash'), undefined);
    events.close();
    assert.equal(events.active, 0);
    assert.equal(events.subscribe('late', 'hash'), undefined);
  } finally {
    events.close();
  }
});
