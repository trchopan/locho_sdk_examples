import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const destination = new URL('vendor/', root);
await mkdir(destination, { recursive: true });
const filename = 'locho-web-0.1.0-dev.2.tgz';
if (process.env.LOCHO_SDK_ARCHIVE) {
  await copyFile(process.env.LOCHO_SDK_ARCHIVE, new URL(filename, destination));
} else {
  const result = spawnSync('gh', ['run', 'download', '38877468606', '--repo', 'trchopan/locho', '--name', 'locho-web-npm-package', '--dir', fileURLToPath(destination)], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('SDK download failed; configure gh or provide LOCHO_SDK_ARCHIVE');
}
const hash = createHash('sha256').update(await readFile(new URL(filename, destination))).digest('hex');
if (hash !== '88695d87443770c391463799ba00f6a09068fdb0b749b1b0a614f72b74ed797e') throw new Error('SDK archive SHA-256 mismatch');
console.log('Verified @locho/web 0.1.0-dev.2 from Locho a509cca');
