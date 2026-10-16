import { test, expect, type Page } from '@playwright/test';

async function pair(page: Page) {
  await page.goto('/');
  // Assign through DOM rather than including credential values in Playwright action logs.
  await page.getByLabel('Attachment ticket').evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }));
  }, process.env.LOCHO_BROWSER_TICKET!);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 35000 });
}
async function login(page: Page, user: 'alice' | 'bob') {
  await page.getByLabel('Email', { exact: true }).fill(`${user}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(`${user}-local-demo-only`);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Notes for ${user}@example.test` })).toBeVisible();
}

test('packaged SDK pairing login CRUD isolation reconnect logout and forget', async ({ page, browser }) => {
  await pair(page); await login(page, 'alice');
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  const title = `Private ${Date.now()}`;
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Body', { exact: true }).fill('Private UTF-8 🌍');
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const other = await browser.newContext(); const bob = await other.newPage();
  await pair(bob); await login(bob, 'bob');
  await expect(bob.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await other.close();
  await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
  await page.getByLabel('Body', { exact: true }).fill('Edited body');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('li pre')).toContainText('Edited body');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Notes for/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible({ timeout: 35000 });
  await page.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Logged out. Reconnect to log in.');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 35000 });
  await page.getByRole('button', { name: 'Forget homelab', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('unpaired');
  await page.reload(); await expect(page.getByRole('status')).toHaveText('unpaired');
});

test('invalid ticket and failed login remain safe', async ({ page }) => {
  await page.goto('/'); await page.getByLabel('Attachment ticket').fill('invalid-sensitive-ticket');
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Connection or API check failed. Check ticket, service and network.');
  await expect(page.getByLabel('Attachment ticket')).toHaveValue('');
  await pair(page);
  await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await page.getByLabel('Password', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Login required or credentials rejected.');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
});
