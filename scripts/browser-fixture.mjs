import { acceptanceFixture } from './acceptance-fixture.mjs';
import { readFile } from 'node:fs/promises';

export default async function setup() {
  if (process.env.LOCHO_DEPLOY_TICKET_FILE) {
    process.env.LOCHO_BROWSER_TICKET = (
      await readFile(process.env.LOCHO_DEPLOY_TICKET_FILE, 'utf8')
    ).trim();
    return;
  }
  const fixture = await acceptanceFixture(process.env.LOCHO_BINARY);
  process.env.LOCHO_BROWSER_TICKET = fixture.ticket;
  process.env.LOCHO_BROWSER_CONTROL = fixture.controlUrl;
  return fixture.cleanup;
}
