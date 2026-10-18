import { test, expect } from '@playwright/test';
import { enterTicket } from './support';

test('private deployed API supports packaged browser login and CRUD', async ({ page }) => {
  test.skip(!process.env.LOCHO_DEPLOY_TICKET_FILE, 'Compose deployment acceptance only');
  const wasm: Array<{ status: number; mime: string }> = [];
  page.on('response', (response) => {
    if (new URL(response.url()).pathname.endsWith('.wasm'))
      wasm.push({ status: response.status(), mime: response.headers()['content-type'] ?? '' });
  });
  const document = await page.goto('/');
  if (!document) throw new Error('Deployment page did not respond');
  if (process.env.LOCHO_DEPLOY_URL) {
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    expect(document.headers()['content-security-policy']).toContain("'wasm-unsafe-eval'");
    expect(document.headers()['cache-control']).toBe('no-store');
    expect(document.headers()['x-content-type-options']).toBe('nosniff');
  }
  await enterTicket(page);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 35000 });
  await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await page.getByLabel('Password', { exact: true }).fill('alice-local-demo-only');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible();
  const title = `Container ${Date.now()}`;
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Body', { exact: true }).fill('Private network API');
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Logged out. Reconnect to log in.');
  expect(wasm).toEqual([{ status: 200, mime: 'application/wasm' }]);
});
