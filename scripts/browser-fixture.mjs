import { acceptanceFixture } from './acceptance-fixture.mjs';

export default async function setup() {
  const fixture = await acceptanceFixture(process.env.LOCHO_BINARY);
  process.env.LOCHO_BROWSER_TICKET = fixture.ticket;
  process.env.LOCHO_BROWSER_CONTROL = fixture.controlUrl;
  return fixture.cleanup;
}
