import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const destination = new URL('vendor/', root);
await mkdir(destination, { recursive: true });
const filename = 'locho-web-0.1.0-dev.1.tgz';
if (process.env.LOCHO_SDK_ARCHIVE) {
  await copyFile(process.env.LOCHO_SDK_ARCHIVE, new URL(filename, destination));
} else {
  const result = spawnSync('gh', ['run', 'download', '38776038252', '--repo', 'trchopan/locho', '--name', 'locho-web-npm-package', '--dir', fileURLToPath(destination)], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('SDK download failed; configure gh or provide LOCHO_SDK_ARCHIVE');
}
const hash = createHash('sha256').update(await readFile(new URL(filename, destination))).digest('hex');
if (hash !== '5f4c1c87c34240567e8b9cd1d2472cc1b689e343089ebb17168d596b4df2cc7a') throw new Error('SDK archive SHA-256 mismatch');
console.log('Verified @locho/web 0.1.0-dev.1 from Locho 4f8aa20c3bcbabb667ef2354510bdb101d690fa6');
