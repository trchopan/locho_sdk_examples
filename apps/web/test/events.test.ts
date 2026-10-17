import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoteEventParser, NoteEventWatch } from '../src/events.js';
import { Session, type Transport } from '../src/session.js';

const encode = (value: string) => new TextEncoder().encode(value);
const event = (noteId = 'note') => `event: note.changed\ndata: ${JSON.stringify({ operation: 'updated', noteId })}\n\n`;
const auth = { token: 'synthetic', expiresAt: '2099', user: { id: 'alice', email: 'alice@example.test' } };
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await turn(); }
  assert.fail('Condition not reached');
}

test('SSE parses split UTF-8, CR/LF, multiline data, comments and ignores unknown events/id/retry', () => {
  const changes: unknown[] = [];
  const parser = new NoteEventParser((change) => changes.push(change));
  const bytes = encode(': connected\r\n\r\nevent: other\ndata: ignored\n\nid: no-replay\nretry: 0\nevent: note.changed\rdata: {"operation":"created",\rdata: "noteId":"🌍"}\r\r');
  for (const byte of bytes) parser.push(new Uint8Array([byte]));
  parser.push(encode('event: note.changed\ndata: {"operation":"deleted","noteId":"incomplete"}'));
  parser.end();
  assert.deepEqual(changes, [{ operation: 'created', noteId: '🌍' }]);
});

test('malformed UTF-8/schema/JSON and oversized unterminated or repeated fields fail bounded', () => {
  for (const value of [
    'data: ' + 'x'.repeat(4096),
    'data:\n'.repeat(1000),
    'event: note.changed\ndata: invalid\n\n',
    'event: note.changed\ndata: {"operation":"other","noteId":"x"}\n\n',
    'event: note.changed\ndata: {"operation":"created","noteId":"x","token":"bad"}\n\n',
  ]) assert.throws(() => new NoteEventParser(() => {}).push(encode(value)));
  assert.throws(() => new NoteEventParser(() => {}).push(new Uint8Array([255])));
  const partial = new NoteEventParser(() => {}); partial.push(new Uint8Array([240])); assert.throws(() => partial.end());
});

function fixture() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const calls: string[] = [];
  let cancelled = 0, lists = 0, writes = 0, allow = true;
  let hold: Promise<void> | undefined;
  const client: Transport = {
    close: async () => {},
    fetch: async (path, options) => {
      calls.push(path);
      if (path === '/health') return Response.json({ service: 'locho-notes', apiVersion: 1 });
      if (path === '/auth/login') return Response.json(auth);
      if (!allow) return new Response(null, { status: 401 });
      if (path === '/api/me') return Response.json({ user: auth.user, expiresAt: auth.expiresAt });
      if (options?.method === 'POST') { writes++; throw new Error('lost write response'); }
      lists++; await hold; return Response.json({ notes: [] });
    },
    fetchStream: async (_path, options) => {
      calls.push('/api/events');
      if (!allow) return new Response(null, { status: 401 });
      assert.equal(options.headers.Authorization, `Bearer ${auth.token}`);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { streams.push(controller); }, cancel() { cancelled++; },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  };
  const session = new Session(async (key) => ({ key, label: key, connect: async () => client }), undefined, { retryBaseMs: 1, random: () => 0 });
  return { session, streams, calls, get cancelled() { return cancelled; }, get lists() { return lists; }, get writes() { return writes; },
    hold: (promise?: Promise<void>) => { hold = promise; }, revoke: () => { allow = false; } };
}

test('subscribe before canonical list; bursts coalesce with one follow-up while loading', async () => {
  const f = fixture();
  try {
    await f.session.pair('ticket'); await f.session.login('a', 'b');
    assert.ok(f.calls.indexOf('/api/events') < f.calls.indexOf('/api/notes'));
    let release!: () => void;
    f.hold(new Promise((resolve) => { release = resolve; }));
    f.streams[0]!.enqueue(encode(event().repeat(20)));
    await until(() => f.lists === 2);
    f.streams[0]!.enqueue(encode(event().repeat(20))); await turn();
    assert.equal(f.lists, 2);
    f.hold(); release();
    await until(() => f.lists === 3); await turn();
    assert.equal(f.lists, 3);
  } finally { await f.session.forget(); }
});

test('stream loss validates health/me, subscribes then refreshes; write outcome stays visible', async () => {
  const f = fixture();
  try {
    await f.session.pair('ticket'); await f.session.login('a', 'b');
    await f.session.save('title', 'body');
    assert.equal(f.writes, 1); assert.match(f.session.state.message, /outcome unknown/);
    const offset = f.calls.length;
    f.streams[0]!.close();
    await until(() => f.streams.length === 2 && f.lists >= 2);
    assert.deepEqual(f.calls.slice(offset), ['/health', '/api/me', '/api/events', '/api/notes']);
    assert.match(f.session.state.message, /outcome unknown/);
    assert.equal(f.writes, 1); assert.equal(f.session.state.live, 'live');
  } finally { await f.session.forget(); }
});

test('revocation, suspension and forget stop streams/retries; stale frames cannot resurrect state', async () => {
  const f = fixture();
  await f.session.pair('ticket'); await f.session.login('a', 'b');
  f.session.suspend(); await until(() => f.cancelled === 1);
  await f.session.resume(); assert.equal(f.streams.length, 2);
  f.revoke(); f.streams[1]!.close();
  await until(() => f.session.state.phase === 'login');
  assert.equal(f.session.state.live, 'off'); assert.deepEqual(f.session.state.notes, []);
  await f.session.forget(); await turn();
  assert.equal(f.session.state.phase, 'unpaired'); assert.equal(f.streams.length, 2);
});

test('429 honors Retry-After and stopping cancels retry without another admission', async () => {
  let admissions = 0;
  const states: string[] = [];
  const watch = new NoteEventWatch({ fetchStream: async () => {
    admissions++; return new Response(null, { status: 429, headers: { 'Retry-After': '30' } });
  } }, 'synthetic', { validate: async () => {}, refresh() {}, unauthorized: async () => {}, state: (s) => states.push(s) }, { retryBaseMs: 1 });
  await watch.start(); await turn();
  assert.equal(admissions, 1); assert.equal(states.at(-1), 'reconnecting');
  await watch.stop(); assert.equal(admissions, 1);
});

test('late stream admission after forget is cancelled and cannot update UI', async () => {
  let finish!: (response: Response) => void, cancelled = 0;
  // A separate controlled transport leaves admission in flight during teardown.
  const session = new Session(async () => ({ key: 'scope', label: 'scope', connect: async () => ({
    close: async () => {}, fetch: async (path) => path === '/health' ? Response.json({ service: 'locho-notes', apiVersion: 1 }) : Response.json(auth),
    fetchStream: () => new Promise((resolve) => { finish = resolve; }),
  }) }));
  await session.pair('ticket'); const login = session.login('a', 'b');
  await until(() => Boolean(finish)); await session.forget();
  finish(new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await login; await turn();
  assert.equal(cancelled, 1); assert.equal(session.state.phase, 'unpaired');
});

test('expiry during list fetch rejects stale authenticated response', async () => {
  const f = fixture();
  try {
    await f.session.pair('ticket'); await f.session.login('a', 'b');
    let release!: () => void;
    f.hold(new Promise((resolve) => { release = resolve; }));
    f.streams[0]!.enqueue(encode(event())); await until(() => f.lists === 2);
    f.revoke(); f.streams[0]!.close();
    await until(() => f.session.state.phase === 'login');
    f.hold(); release(); await turn();
    assert.equal(f.session.state.phase, 'login'); assert.deepEqual(f.session.state.notes, []);
  } finally { await f.session.forget(); }
});
