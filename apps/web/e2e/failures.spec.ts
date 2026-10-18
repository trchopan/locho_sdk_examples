import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { enterTicket } from './support';

async function command(request: APIRequestContext, action: string) {
  const response = await request.post(`${process.env.LOCHO_BROWSER_CONTROL}/${action}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function login(page: Page) {
  await page.goto('/');
  await enterTicket(page);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 35000 });
  await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await page.getByLabel('Password', { exact: true }).fill('alice-local-demo-only');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible();
}

test('host restart and stopped upstream retain pairing/session without replay', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  await login(page);
  try {
    await command(request, 'host-stop');
    await expect(page.getByRole('heading', { name: /^Notes for/ })).toHaveCount(0, {
      timeout: 35000,
    });
    await command(request, 'host-start');
    // Recovery may reconnect the peer before its fresh API validation succeeds.
    // If validation fails, verify the explicit reconnect path without re-pair/login.
    await expect
      .poll(
        async () => {
          if (await page.getByRole('heading', { name: 'Notes for alice@example.test' }).count())
            return 'ready';
          if (
            (await page.getByRole('alert').allTextContents()).some((text) =>
              text.includes('Connection or API check failed'),
            )
          )
            return 'retry';
          return 'waiting';
        },
        { timeout: 60000 },
      )
      .not.toBe('waiting');
    if (!(await page.getByRole('heading', { name: 'Notes for alice@example.test' }).count())) {
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible({
      timeout: 60000,
    });
    await command(request, 'upstream-stop');
    await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Request failed', { timeout: 20000 });
    await command(request, 'upstream-start');
    await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh notes', exact: true })).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
  } finally {
    await command(request, 'upstream-start');
    await command(request, 'host-start');
  }
});

test('lost mutation responses report unknown outcome and are never replayed', async ({
  page,
  request,
}) => {
  await login(page);
  const title = `Interrupted ${Date.now()}`;
  const before = await command(request, 'status');
  await command(request, 'interrupt-POST');
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Body', { exact: true }).fill('Committed before response loss');
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Write outcome unknown');
  await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
  await page.getByLabel('Body', { exact: true }).fill('Patched before response loss');
  await command(request, 'interrupt-PATCH');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Write outcome unknown');
  await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect(
    page.locator('li pre').filter({ hasText: 'Patched before response loss' }),
  ).toHaveCount(1);
  await command(request, 'interrupt-DELETE');
  await page.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Write outcome unknown');
  await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  const after = await command(request, 'status');
  expect(after.mutations - before.mutations).toBe(3);
  expect(after.dropped - before.dropped).toBe(3);
});

test('new page owner restores saved session after old page closes', async ({ page, context }) => {
  await login(page);
  await page.getByLabel('Remember this device').check();
  await expect(page.getByText('Updating saved credentials…', { exact: true })).toHaveCount(0);
  await page.close();
  const next = await context.newPage();
  await next.goto('/');
  await expect(next.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible({
    timeout: 35000,
  });
  await next.getByRole('button', { name: 'Forget homelab', exact: true }).click();
});
