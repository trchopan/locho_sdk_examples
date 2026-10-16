import { mkdtemp, mkdir, copyFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'notes-offline-setup-'));
function run(command, args, env, succeeds = true) {
  const result = spawnSync(command, args, { cwd: temporary, env, encoding: 'utf8' });
  if ((result.status === 0) !== succeeds) throw new Error(`Unexpected setup result: ${result.stderr}`);
}
try {
  await mkdir(join(temporary, 'scripts'));
  await copyFile(join(root, 'scripts/setup-browser-sdk.mjs'), join(temporary, 'scripts/setup-browser-sdk.mjs'));
  const env = { ...process.env, LOCHO_SDK_ARCHIVE: join(root, 'vendor/locho-web-0.1.0-dev.2.tgz') };
  delete env.LOCHO_SDK_URL;
  run('node', ['scripts/setup-browser-sdk.mjs'], env);
  delete env.LOCHO_SDK_ARCHIVE;
  // An invalid gh executable proves the verified cache does not invoke GitHub.
  env.GH_TOKEN = '';
  run('node', ['scripts/setup-browser-sdk.mjs'], env);
  await writeFile(join(temporary, 'vendor/locho-web-0.1.0-dev.2.tgz'), 'corrupted');
  run('node', ['scripts/setup-browser-sdk.mjs'], env, false);
  console.log('Local archive/cache setup and corrupt-cache rejection passed');
} finally { await rm(temporary, { recursive: true, force: true }); }
