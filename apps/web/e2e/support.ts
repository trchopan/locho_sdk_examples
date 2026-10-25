import { expect, type APIRequestContext, type Page } from '@playwright/test';

/** Fixture control only: never use this for application requests. */
export async function fixtureCommand(
  request: APIRequestContext,
  action = 'status',
  controlUrl = process.env.LOCHO_BROWSER_CONTROL,
) {
  if (!controlUrl) throw new Error('LOCHO_BROWSER_CONTROL is required');
  const response = await request.post(`${controlUrl}/${action}`, {
    // Status is a side-effect-free snapshot despite the fixture's POST protocol.
    // Playwright retries only ECONNRESET, once; HTTP errors still fail immediately.
    // Fault injection, revocation and host operations must never be replayed.
    maxRetries: action === 'status' ? 1 : 0,
  });
  expect(response.ok()).toBe(true);
  return response.json();
}

export async function enterTicket(page: Page): Promise<void> {
  const ticket = process.env.LOCHO_BROWSER_TICKET;
  if (!ticket) throw new Error('LOCHO_BROWSER_TICKET is required');
  await page.getByLabel('Attachment ticket').evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Input value setter is unavailable');
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, ticket);
}
