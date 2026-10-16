import { createApp, addUser } from '../apps/api/dist/src/app.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const binary = process.env.LOCHO_BINARY;
if (!binary) throw new Error('LOCHO_BINARY is required');
const directory = await mkdtemp(join(tmpdir(), 'notes-flutter-'));
const { app, db } = await createApp({ loginAttempts: 1000 });
let host;
try {
  await addUser(db, 'alice@example.test', 'alice-local-demo-only');
  await addUser(db, 'bob@example.test', 'bob-local-demo-only');
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const config = join(directory, 'locho.toml');
  await writeFile(config, `[[services]]\nname = "sample-api"\ntype = "tcp"\nendpoint = "127.0.0.1:${new URL(address).port}"\n`);
  const env = { ...process.env, LOCHO_STATE_DIR: join(directory, 'state') };
  host = spawn(binary, ['host', '--config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('host startup timeout')), 30000);
    let output = '';
    host.once('error', reject);
    host.stdout.on('data', (chunk) => { output = (output + chunk).slice(-8192); if (output.includes('- sample-api (tcp)')) { clearTimeout(timer); resolve(); } });
    host.stderr.resume();
  });
  const { stdout } = await exec(binary, ['share', 'sample-api', '--config', config, '--ticket'], { env });
  const defines = join(directory, 'defines.json');
  await writeFile(defines, JSON.stringify({ LOCHO_TICKET: stdout.trim() }), { mode: 0o600 });
  const release = process.argv.includes('--release');
  const command = release
    ? ['build', 'apk', '--release', '--target-platform=android-arm64', '--target', 'lib/release_acceptance.dart']
    : ['test', 'integration_test/notes_test.dart'];
  const device = process.env.LOCHO_DEVICE ?? 'emulator-5554';
  const child = spawn('flutter', [...command, ...(release ? [] : ['-d', device]), `--dart-define-from-file=${defines}`], { cwd: join(root, 'apps/flutter'), stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Flutter acceptance build timeout')); }, 600000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  if (code !== 0) throw new Error('Flutter notes acceptance failed');
  if (release) {
    const adb = join(process.env.ANDROID_HOME ?? join(process.env.HOME, 'Library/Android/sdk'), 'platform-tools/adb');
    const android = (...args) => exec(adb, ['-s', device, ...args], { timeout: 30000 });
    const packageName = 'dev.chop.locho_notes';
    await android('install', '-r', join(root, 'apps/flutter/build/app/outputs/flutter-apk/app-release.apk'));
    await android('shell', 'am', 'force-stop', packageName);
    await android('logcat', '-c');
    await android('shell', 'am', 'start', '-n', `${packageName}/.MainActivity`);
    try {
      let passed = false;
      for (let attempt = 0; attempt < 180; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const { stdout: pid } = await android('shell', 'pidof', packageName);
        const { stdout: logs } = await android('logcat', '-d', `--pid=${pid.trim()}`, '-s', 'flutter:I');
        if (logs.includes('NOTES_ACCEPTANCE_FAIL')) throw new Error('Release notes acceptance failed');
        if (logs.includes('NOTES_ACCEPTANCE_PASS')) { passed = true; break; }
      }
      if (!passed) throw new Error('Release notes acceptance timed out');
      console.log('Flutter notes release acceptance passed');
    } finally { await android('shell', 'am', 'force-stop', packageName); }
  }
} finally {
  if (host?.pid && host.exitCode === null && host.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => host.kill('SIGKILL'), 10000);
      host.once('exit', () => { clearTimeout(timer); resolve(); }); host.kill('SIGTERM');
    });
  }
  await app.close(); await rm(directory, { recursive: true, force: true });
}
