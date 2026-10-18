import type { Page } from '@playwright/test';

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
