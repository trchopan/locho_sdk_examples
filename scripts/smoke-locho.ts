import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import assert from 'node:assert/strict';
import { createApp, addUser } from '../apps/api/src/app.js';

const binary = process.env.LOCHO_BINARY;
if (!binary) throw new Error('Set LOCHO_BINARY to an existing Locho CLI binary');
const lochoBinary: string = binary;
const directory = await mkdtemp(join(tmpdir(), 'locho-examples-smoke-'));
const processes: ChildProcess[] = [];
const { app, db } = await createApp();
const env = { ...process.env, LOCHO_STATE_DIR: join(directory, 'state') };

async function tcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return port;
}
async function udpPort(): Promise<number> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((done) => socket.bind(0, '127.0.0.1', done));
  const port = socket.address().port;
  socket.close();
  return port;
}
async function start(args: string[], ready: RegExp): Promise<void> {
  const child = spawn(resolve(lochoBinary), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(child);
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Locho process startup timed out')), 15000);
    let output = '';
    const data = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16384);
      if (ready.test(output)) {
        clearTimeout(timer);
        done();
      }
    };
    if (!child.stdout || !child.stderr) throw new Error('Could not capture Locho output');
    child.stdout.on('data', data);
    child.stderr.on('data', data);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Could not launch Locho'));
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Locho stopped during startup'));
    });
  });
}
try {
  await addUser(db, 'smoke@example.test', 'disposable-smoke-password');
  const upstream = await app.listen({ host: '127.0.0.1', port: 0 });
  const config = join(directory, 'locho.toml');
  await writeFile(
    config,
    `[[services]]\nname = "sample-api"\ntype = "tcp"\nendpoint = "127.0.0.1:${new URL(upstream).port}"\n`,
  );
  const direct = await udpPort();
  await start(
    ['host', '--config', config, '--bind-address', `127.0.0.1:${direct}`],
    /locho direct-address/,
  );
  const share = spawnSync(resolve(lochoBinary), ['share', 'sample-api', '--config', config], {
    env,
    encoding: 'utf8',
  });
  if (share.status !== 0) throw new Error('Locho share failed');
  const [, , host, capability] = share.stdout.trim().split(/\s+/);
  if (!host || !capability) throw new Error('Unexpected share output');
  const local = await tcpPort();
  await start(
    [
      'attach',
      host,
      capability,
      '--direct-address',
      `127.0.0.1:${direct}`,
      '--listen',
      `127.0.0.1:${local}`,
    ],
    /Local TCP listener/,
  );
  const base = `http://127.0.0.1:${local}`;
  const healthFetch: typeof fetch = (input, options) =>
    fetch(input, { ...options, signal: AbortSignal.timeout(5000) });
  const health = await healthFetch(`${base}/health`);
  if (health.status !== 200 || (await health.json()).apiVersion !== 1)
    throw new Error('Health through tunnel failed');
  const login = await healthFetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@example.test', password: 'disposable-smoke-password' }),
  });
  if (login.status !== 200) throw new Error('Login through tunnel failed');
  const { token } = await login.json();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const events = await healthFetch(`${base}/api/events`, { headers });
  assert.equal(events.status, 200);
  const contentType = events.headers.get('content-type');
  assert.ok(contentType);
  assert.match(contentType, /^text\/event-stream/);
  const body = events.body;
  assert.ok(body);
  const reader = body.getReader();
  let buffered = '';
  async function frame(): Promise<string> {
    while (!buffered.includes('\n\n')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Event stream ended before invalidation');
      buffered += new TextDecoder().decode(value);
    }
    const index = buffered.indexOf('\n\n');
    const result = buffered.slice(0, index);
    buffered = buffered.slice(index + 2);
    return result;
  }
  assert.equal(await frame(), ': connected');
  const created = await healthFetch(`${base}/api/notes`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Tunnel smoke', body: 'Exact body' }),
  });
  if (created.status !== 201) throw new Error('Create through tunnel failed');
  const id = (await created.json()).note.id;
  let event: string;
  do {
    event = await frame();
  } while (event.startsWith(':'));
  assert.equal(
    event,
    `event: note.changed\ndata: ${JSON.stringify({ operation: 'created', noteId: id })}`,
  );
  await reader.cancel();
  const notes = await healthFetch(`${base}/api/notes`, { headers });
  if (notes.status !== 200 || (await notes.json()).notes[0].body !== 'Exact body')
    throw new Error('List through tunnel failed');
  console.log('Real Locho TCP tunnel health/login/notes/incremental SSE smoke passed.');
} finally {
  for (const child of processes.reverse()) {
    if (child.exitCode !== null) continue;
    const stopped = new Promise<void>((done) => child.once('exit', () => done()));
    child.kill('SIGINT');
    const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
    await stopped;
    clearTimeout(timer);
  }
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
