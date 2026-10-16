import { acceptanceFixture } from './acceptance-fixture.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);
const fixture = await acceptanceFixture(process.env.LOCHO_BINARY);
const directory = await mkdtemp(join(tmpdir(), 'notes-flutter-input-'));
const device = process.env.LOCHO_DEVICE ?? 'emulator-5554';
const restart = process.argv.includes('--process-restart');
const release = process.argv.includes('--release') || restart;
const ui = process.argv.includes('--ui');
const failures = process.argv.includes('--failures');
const packageName = 'dev.chop.locho_notes';
const adb = join(process.env.ANDROID_HOME ?? join(process.env.HOME, 'Library/Android/sdk'), 'platform-tools/adb');
const android = (...args) => exec(adb, ['-s', device, ...args], { timeout: 30000 });
async function marker(pass, fail) {
  for (let attempt = 0; attempt < 180; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { stdout: pid } = await android('shell', 'pidof', packageName);
    if (!pid.trim()) throw new Error('Acceptance app exited');
    const { stdout: logs } = await android('logcat', '-d', `--pid=${pid.trim()}`, '-s', 'flutter:I');
    if (logs.includes(fail)) throw new Error('Release notes acceptance failed');
    if (logs.includes(pass)) return;
  }
  throw new Error('Release notes acceptance timed out');
}
async function launch() {
  await android('shell', 'am', 'force-stop', packageName);
  await android('logcat', '-c');
  await android('shell', 'am', 'start', '-W', '-n', `${packageName}/.MainActivity`);
}
try {
  const defines = join(directory, 'defines.json');
  const controlPort = new URL(fixture.controlUrl).port;
  if (failures) await android('reverse', `tcp:${controlPort}`, `tcp:${controlPort}`);
  await writeFile(defines, JSON.stringify({ LOCHO_TICKET: fixture.ticket, LOCHO_CONTROL: fixture.controlUrl }), { mode: 0o600 });
  const command = release
    ? ['build', 'apk', '--release', '--target-platform=android-arm64', '--target', restart ? 'lib/restart_acceptance.dart' : 'lib/release_acceptance.dart']
    : ['test', failures ? 'integration_test/failures_test.dart' : ui ? 'integration_test/ui_test.dart' : 'integration_test/notes_test.dart', '-d', device];
  const child = spawn('flutter', [...command, `--dart-define-from-file=${defines}`], { cwd: join(root, 'apps/flutter'), stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Flutter acceptance timeout')); }, 600000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  if (code !== 0) throw new Error('Flutter notes acceptance failed');
  if (release) {
    await android('install', '-r', join(root, 'apps/flutter/build/app/outputs/flutter-apk/app-release.apk'));
    try {
      if (restart) {
        // Explicitly reset this disposable app only; never clear another application's storage.
        await android('shell', 'am', 'force-stop', packageName);
        await android('shell', 'pm', 'clear', packageName);
        await launch(); await marker('NOTES_RESTART_SEEDED', 'NOTES_RESTART_FAIL');
        const { stdout: previous } = await android('shell', 'pidof', packageName);
        await launch();
        const { stdout: current } = await android('shell', 'pidof', packageName);
        if (previous.trim() === current.trim()) throw new Error('Process was not replaced');
        await marker('NOTES_RESTART_PASS', 'NOTES_RESTART_FAIL');
        console.log('Flutter secure session restored after real Android process restart');
      } else {
        await launch(); await marker('NOTES_ACCEPTANCE_PASS', 'NOTES_ACCEPTANCE_FAIL');
        console.log('Flutter notes release acceptance passed');
      }
    } finally { await android('shell', 'am', 'force-stop', packageName); }
  }
} finally {
  if (failures) await android('reverse', '--remove', `tcp:${new URL(fixture.controlUrl).port}`).catch(() => {});
  await fixture.cleanup(); await rm(directory, { recursive: true, force: true });
}
