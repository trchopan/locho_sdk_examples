import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acceptanceFixture } from './acceptance-fixture.mjs';
import { crossBrowser } from './cross-browser.mjs';

const previous = process.env.LOCHO_PREVIOUS_BINARY;
const current = process.env.LOCHO_BINARY;
if (!previous || !current || previous === current)
  throw new Error('Set distinct LOCHO_PREVIOUS_BINARY and LOCHO_BINARY paths');
if (process.env.LOCHO_CROSS_BROWSER_AUTH && process.env.LOCHO_CROSS_BROWSER_AUTH !== 'cookie')
  throw new Error('Host migration probe requires browser cookie mode');

const exec = promisify(execFile);
for (const [binary, expected] of [
  [previous, 'locho 1.3.0-beta.1 (commit 3786da3127338b2530e0cd8cea8ef23bc6d55dfd, clean)'],
  [current, 'locho 1.3.0-beta.3 (commit 0c8ad57cc91af30144138bd324aeca86604f48dd, clean)'],
]) {
  const { stdout } = await exec(binary, ['--version'], { timeout: 10000 });
  assert.equal(
    stdout.trim() === expected,
    true,
    'Migration probe requires the clean pinned CLI versions',
  );
}

// Only the first fixture setup generates a ticket. The same ticket, state
// directory, service config and live API/database survive every executable swap.
const fixture = await acceptanceFixture(previous);
let peer;
async function status() {
  const response = await fetch(`${fixture.controlUrl}/status`, { method: 'POST' });
  assert.equal(response.status, 200);
  return response.json();
}
async function drained() {
  const deadline = Date.now() + 10000;
  while ((await status()).eventStreams !== 0) {
    if (Date.now() >= deadline) throw new Error('Migration owner did not release its event stream');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
try {
  peer = await crossBrowser(fixture);
  assert.equal(await peer.noteCount(), 0);
  await peer.createNote();
  assert.equal(await peer.noteCount(), 1);
  assert.equal((await status()).mutations, 1);
  await peer.forget();
  await drained();

  await fixture.replaceHost(current);
  await peer.pair();
  assert.equal(await peer.noteCount(), 1);
  assert.equal((await status()).mutations, 1, 'Upgrade must not replay the prior write');
  await peer.editNote('Updated after host upgrade');
  assert.equal((await status()).mutations, 2);
  await peer.forget();
  await drained();

  await fixture.replaceHost(previous);
  await peer.pair();
  assert.equal(await peer.noteCount(), 1);
  assert.equal((await status()).mutations, 2, 'Rollback must not replay application writes');
  console.log(
    'Existing ticket and notes survive beta.1 → beta.3 → beta.1 host replacement; writes are not replayed.',
  );
} finally {
  await peer?.cleanup();
  await fixture.cleanup();
}
