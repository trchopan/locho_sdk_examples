import { mkdir, readFile, copyFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const destination = new URL('vendor/', root);
await mkdir(destination, { recursive: true });
const filename = 'locho-web-0.1.0-dev.3.tgz';
if (process.env.LOCHO_SDK_ARCHIVE) {
  await copyFile(process.env.LOCHO_SDK_ARCHIVE, new URL(filename, destination));
} else {
  let cached = false;
  try { await access(new URL(filename, destination)); cached = true; } catch {}
  if (!cached && process.env.LOCHO_SDK_URL) {
    const url = new URL(process.env.LOCHO_SDK_URL);
    if (url.protocol !== 'https:') throw new Error('SDK mirror must use HTTPS');
    const response = await fetch(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 16 * 1024 * 1024) throw new Error('SDK mirror download failed');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) throw new Error('SDK archive exceeds limit');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    await writeFile(new URL(filename, destination), bytes);
    cached = true;
  }
  if (!cached) {
  const result = spawnSync('gh', ['run', 'download', '38932541782', '--repo', 'trchopan/locho', '--name', 'locho-web-npm-package', '--dir', fileURLToPath(destination)], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('SDK download failed; configure gh or provide LOCHO_SDK_ARCHIVE');
  }
}
const hash = createHash('sha256').update(await readFile(new URL(filename, destination))).digest('hex');
if (hash !== '83ea65e191af93a40cc1b652642e4335ef044ebb39fa31b64488ef736d5e091c') throw new Error('SDK archive SHA-256 mismatch');
console.log('Verified @locho/web 0.1.0-dev.3 from Locho PR #98 (e5faa3f; CI merge 8a9e67e)');
