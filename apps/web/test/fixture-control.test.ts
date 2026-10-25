import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as apiRequest } from '@playwright/test';
import { fixtureCommand } from '../e2e/support.js';

async function control(
  t: TestContext,
  handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const request = await apiRequest.newContext();
  t.after(() => request.dispose());
  return { request, url: `http://127.0.0.1:${address.port}` };
}

test('read-only fixture status recovers from one socket reset', async (t) => {
  let calls = 0;
  const f = await control(t, (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/status');
    if (++calls === 1) {
      request.socket.destroy();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ eventStreams: 0 }));
  });
  assert.deepEqual(await fixtureCommand(f.request, 'status', f.url), { eventStreams: 0 });
  assert.equal(calls, 2);
});

test('repeated status resets exhaust the bounded retry and still fail', async (t) => {
  let calls = 0;
  const f = await control(t, (request) => {
    calls++;
    request.socket.destroy();
  });
  await assert.rejects(fixtureCommand(f.request, 'status', f.url), /ECONNRESET/);
  assert.equal(calls, 2);
});

test('state-changing fixture commands are never replayed after a reset', async (t) => {
  const calls = new Map<string, number>();
  const f = await control(t, (request) => {
    const path = request.url ?? '';
    calls.set(path, (calls.get(path) ?? 0) + 1);
    // Simulate a command taking effect before its response is lost.
    request.socket.destroy();
  });
  for (const action of [
    'host-stop',
    'host-start',
    'upstream-stop',
    'upstream-start',
    'events-stop',
    'events-pause',
    'events-resume',
    'events-expire',
    'interrupt-POST',
    'interrupt-PATCH',
    'interrupt-DELETE',
  ]) {
    await assert.rejects(fixtureCommand(f.request, action, f.url), /ECONNRESET/);
    assert.equal(calls.get(`/${action}`), 1);
  }
});

test('HTTP errors are not retried and nonzero stream counts are not hidden', async (t) => {
  let calls = 0;
  const f = await control(t, (_request, response) => {
    calls++;
    if (calls === 1) {
      response.writeHead(500).end();
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ eventStreams: 1 }));
  });
  await assert.rejects(fixtureCommand(f.request, 'status', f.url));
  assert.equal(calls, 1);
  assert.deepEqual(await fixtureCommand(f.request, 'status', f.url), { eventStreams: 1 });
  assert.equal(calls, 2);
});
