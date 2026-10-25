import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GatewaySession, upstreamPath, type MetadataClient } from '../src/gateway.js';

const token = 'a'.repeat(43);
const cookie = `locho_notes_session=${token}; Path=/browser/; Max-Age=60; Secure; HttpOnly; SameSite=Strict`;
function fixture() {
  const calls: { path: string; cookie?: string; streaming?: boolean }[] = [];
  let hold: Promise<void> | undefined;
  let cancelled = false;
  const client: MetadataClient = {
    close: async () => {},
    fetchWithMetadata: async (path, options) => {
      calls.push({ path, cookie: options.headers.Cookie });
      if (path.endsWith('/auth/login')) await hold;
      return {
        response: Response.json(
          { ok: true },
          { headers: { 'X-Secret': 'private', 'Content-Type': 'application/json' } },
        ),
        upstreamHeaders: path.endsWith('/auth/login') ? [['set-cookie', cookie]] : [],
      };
    },
    fetchStreamWithMetadata: async (path, options) => {
      calls.push({ path, cookie: options.headers.Cookie, streaming: true });
      return {
        response: new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
        upstreamHeaders: [],
      };
    },
  };
  const gateway = new GatewaySession(client);
  const request = (path: string, method = 'GET', body?: string) =>
    gateway.fetch(
      path,
      new Request('https://notes.test/gateway', {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body,
      }),
    );
  return {
    gateway,
    calls,
    request,
    hold: (value: Promise<void>) => {
      hold = value;
    },
    cancelled: () => cancelled,
  };
}
test('gateway uses metadata, strips secrets, scopes cookies and preserves stream cancellation', async () => {
  const f = fixture();
  const login = await f.request('/auth/login', 'POST', '{}');
  assert.equal(login.headers.get('Set-Cookie'), null);
  assert.equal(login.headers.get('X-Secret'), null);
  assert.equal(login.headers.get('Cache-Control'), 'no-store');
  await f.request('/api/me');
  assert.equal(f.calls.at(-1)?.cookie, `locho_notes_session=${token}`);
  await f.request('/health');
  assert.equal(f.calls.at(-1)?.cookie, undefined);
  const events = await f.request('/api/events');
  assert.equal(f.calls.at(-1)?.streaming, true);
  await events.body?.cancel();
  assert.equal(f.cancelled(), true);
  await f.request('/auth/logout', 'POST');
  assert.equal(f.calls.at(-1)?.cookie, `locho_notes_session=${token}`);
  await f.request('/api/me');
  assert.equal(f.calls.at(-1)?.cookie, undefined);
});

test('logout/close invalidate a late login without replay or resurrection', async () => {
  const f = fixture();
  let release!: () => void;
  f.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = f.request('/auth/login', 'POST', '{}');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.request('/auth/logout', 'POST');
  release();
  await assert.rejects(pending);
  await f.request('/api/me');
  assert.equal(f.calls.at(-1)?.cookie, undefined);
  await f.gateway.close();
  assert.equal((await f.request('/api/me')).status, 503);
  assert.equal(f.calls.filter(({ path }) => path.endsWith('/auth/login')).length, 1);
});

test('gateway rejects arbitrary paths/methods, auth injection and oversized bodies', async () => {
  for (const path of [
    'https://other.test/',
    '//other.test/',
    '/api/notes/../me',
    '/api/notes?x=1',
    '/auth/login/extra',
  ])
    assert.throws(() => upstreamPath(path, 'GET'));
  assert.throws(() => upstreamPath('/api/events', 'POST'));
  const f = fixture();
  assert.equal(
    (
      await f.gateway.fetch(
        '/api/me',
        new Request('https://notes.test/', { headers: { Authorization: 'Bearer forbidden' } }),
      )
    ).status,
    400,
  );
  await assert.rejects(f.request('/auth/login', 'POST', 'x'.repeat(65537)));
  assert.equal(f.calls.length, 0);
});

test('Firefox-style null Request.body still delivers bounded POST bytes', async () => {
  let bytes = '';
  const client: MetadataClient = {
    close: async () => {},
    fetchStreamWithMetadata: async () => {
      throw new Error('Unexpected stream');
    },
    fetchWithMetadata: async (_path, options) => {
      bytes = new TextDecoder().decode(options.body);
      return { response: Response.json({ notes: [] }), upstreamHeaders: [] };
    },
  };
  const gateway = new GatewaySession(client);
  const request = new Request('https://notes.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"title":"hello","body":"world"}',
  });
  Object.defineProperty(request, 'body', { value: null });
  await gateway.fetch('/api/notes', request);
  assert.equal(bytes, '{"title":"hello","body":"world"}');
  const oversized = new Request('https://notes.test/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'x'.repeat(65537),
  });
  Object.defineProperty(oversized, 'body', { value: null });
  await assert.rejects(gateway.fetch('/api/notes', oversized));
});
