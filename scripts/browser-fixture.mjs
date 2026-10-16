import { createApp, addUser } from '../apps/api/dist/src/app.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export default async function setup() {
  const binary = process.env.LOCHO_BINARY;
  if (!binary) throw new Error('LOCHO_BINARY must point to the pinned built CLI');
  const directory = await mkdtemp(join(tmpdir(), 'notes-browser-'));
  // One fixture serves all browser projects; avoid exercising the production login
  // limiter accidentally as the UI suite grows (limiter behavior has backend tests).
  const { app, db } = await createApp({ loginAttempts: 1000 });
  let host;
  const cleanup = async () => {
    if (host?.pid && host.exitCode === null && host.signalCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => host.kill('SIGKILL'), 10000);
        host.once('exit', () => { clearTimeout(timer); resolve(); });
        host.kill('SIGTERM');
      });
    }
    await app.close();
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await addUser(db, 'alice@example.test', 'alice-local-demo-only');
    await addUser(db, 'bob@example.test', 'bob-local-demo-only');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const config = join(directory, 'locho.toml');
    await writeFile(config, `[[services]]\nname = "sample-api"\ntype = "tcp"\nendpoint = "127.0.0.1:${new URL(address).port}"\n`);
    const env = { ...process.env, LOCHO_STATE_DIR: join(directory, 'state') };
    host = spawn(binary, ['host', '--config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Host readiness timeout')), 30000);
      let output = '';
      host.on('error', reject);
      host.stdout.on('data', (chunk) => {
        output = (output + chunk.toString()).slice(-8192);
        if (output.includes('- sample-api (tcp)')) { clearTimeout(timer); resolve(); }
      });
      host.stderr.resume();
    });
    const { stdout } = await exec(binary, ['share', 'sample-api', '--config', config, '--ticket'], { env, timeout: 20000 });
    process.env.LOCHO_BROWSER_TICKET = stdout.trim();
    return cleanup;
  } catch (error) { await cleanup(); throw error; }
}
