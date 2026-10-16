import { createApp, addUser } from '../apps/api/dist/src/app.js';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    const error = (value) => { server.off('listening', ready); reject(value); };
    const ready = () => { server.off('error', error); resolve(); };
    server.once('error', error); server.once('listening', ready); server.listen(port, '127.0.0.1');
  });
  return server.address().port;
}
async function stop(server) {
  const closing = new Promise((resolve) => server.close(resolve));
  server.closeAllConnections(); await closing;
}

/** Test-only response fault boundary: forwards to the real API and never stores request data. */
export async function acceptanceFixture(binary) {
  if (!binary) throw new Error('LOCHO_BINARY must point to the pinned built CLI');
  const directory = await mkdtemp(join(tmpdir(), 'notes-acceptance-'));
  const { app, db } = await createApp({ loginAttempts: 1000, eventsTickMs: 100 });
  let host, apiPort, proxyPort, interrupt;
  let mutations = 0, dropped = 0;
  const eventResponses = new Set();
  let eventsPaused = false;
  const forwarded = new Set();
  const proxy = createServer((incoming, outgoing) => {
    if (incoming.url === '/api/events') {
      if (eventsPaused) { outgoing.writeHead(503).end(); return; }
      eventResponses.add(outgoing);
      outgoing.once('close', () => eventResponses.delete(outgoing));
    }
    const mutation = incoming.url.startsWith('/api/notes') && ['POST', 'PATCH', 'DELETE'].includes(incoming.method);
    if (mutation) mutations++;
    const loseResponse = mutation && interrupt === incoming.method;
    if (loseResponse) interrupt = undefined;
    const upstream = httpRequest({ hostname: '127.0.0.1', port: apiPort, method: incoming.method, path: incoming.url,
      headers: { ...incoming.headers, connection: 'close' } }, (response) => {
      if (loseResponse) {
        // Wait until the actual backend has produced a successful mutation response.
        response.resume();
        response.once('end', () => { if (response.statusCode >= 200 && response.statusCode < 300) dropped++; outgoing.destroy(); });
      } else {
        outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
      }
      response.on('error', () => outgoing.destroy());
    });
    forwarded.add(upstream);
    upstream.on('close', () => forwarded.delete(upstream));
    upstream.on('error', () => outgoing.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  const config = join(directory, 'locho.toml');
  const env = { ...process.env, LOCHO_STATE_DIR: join(directory, 'state') };
  async function startHost() {
    host = spawn(binary, ['host', '--config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      let output = '';
      const finish = (error) => {
        clearTimeout(timer); host.off('error', onError); host.off('exit', onExit); host.stdout.off('data', onData);
        host.stdout.resume(); error ? reject(error) : resolve();
      };
      const onError = () => finish(new Error('Host failed to start'));
      const onExit = () => finish(new Error('Host exited before readiness'));
      const onData = (chunk) => { output = (output + chunk).slice(-8192); if (output.includes('- sample-api (tcp)')) finish(); };
      const timer = setTimeout(() => finish(new Error('Host readiness timeout')), 30000);
      host.once('error', onError); host.once('exit', onExit); host.stdout.on('data', onData); host.stderr.resume();
    });
  }
  async function stopHost() {
    if (!host?.pid || host.exitCode !== null || host.signalCode !== null) return;
    const child = host;
    await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    });
  }
  async function operation(action) {
    if (action === 'host-stop') await stopHost();
    else if (action === 'host-start') { if (!host || host.exitCode !== null || host.signalCode !== null) await startHost(); }
    else if (action === 'upstream-stop') await stop(proxy);
    else if (action === 'upstream-start') { if (!proxy.listening) await listen(proxy, proxyPort); }
    else if (['interrupt-POST', 'interrupt-PATCH', 'interrupt-DELETE'].includes(action)) interrupt = action.slice(10);
    else if (action === 'events-stop') { for (const response of eventResponses) response.destroy(); }
    else if (action === 'events-pause') { eventsPaused = true; for (const response of eventResponses) response.destroy(); }
    else if (action === 'events-resume') eventsPaused = false;
    else if (action === 'events-expire') db.prepare('UPDATE sessions SET expires_at = 0').run();
    else if (action !== 'status') throw new Error('Unknown fixture action');
    return { mutations, dropped, eventStreams: eventResponses.size, upstream: proxy.listening, host: Boolean(host?.pid && host.exitCode === null && host.signalCode === null) };
  }
  let queue = Promise.resolve();
  const control = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    const action = new URL(request.url, 'http://localhost').pathname.slice(1);
    queue = queue.then(async () => {
      try { const state = await operation(action); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(state)); }
      catch { response.writeHead(500).end(); }
    });
  });
  const cleanup = async () => {
    await stop(control); await queue;
    await stopHost(); await stop(proxy);
    for (const request of forwarded) request.destroy();
    await app.close(); await rm(directory, { recursive: true, force: true });
  };
  try {
    await addUser(db, 'alice@example.test', 'alice-local-demo-only');
    await addUser(db, 'bob@example.test', 'bob-local-demo-only');
    const address = await app.listen({ host: '127.0.0.1', port: 0 }); apiPort = Number(new URL(address).port);
    proxyPort = await listen(proxy);
    await writeFile(config, `[[services]]\nname = "sample-api"\ntype = "tcp"\nendpoint = "127.0.0.1:${proxyPort}"\n`);
    await startHost();
    const { stdout } = await exec(binary, ['share', 'sample-api', '--config', config, '--ticket'], { env, timeout: 20000 });
    const controlPort = await listen(control);
    return { ticket: stdout.trim(), controlUrl: `http://127.0.0.1:${controlPort}`, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
