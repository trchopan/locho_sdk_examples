import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { enterTicket } from './support';

async function pair(page: Page, mode = 'cookie') {
  await page.goto(`/?auth=${mode}`);
  await enterTicket(page);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible({
    timeout: 35000,
  });
}
async function login(page: Page, user = 'alice') {
  await page.getByLabel('Email', { exact: true }).fill(`${user}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(`${user}-local-demo-only`);
  const loginResponse =
    (await page.getByLabel('Authentication mode').inputValue()) === 'cookie'
      ? page.waitForResponse((response) => response.url().endsWith('/__locho_notes__/auth/login'))
      : undefined;
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  const response = await loginResponse;
  if (response)
    expect(
      response.status(),
      `Login rejection: ${response.headers()['x-locho-notes-rejection'] ?? 'backend'}`,
    ).toBe(200);
  await expect(page.getByRole('heading', { name: `Notes for ${user}@example.test` })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByTestId('live-status')).toHaveText('Live updates: live');
}
async function command(request: APIRequestContext, action: string) {
  const response = await request.post(`${process.env.LOCHO_BROWSER_CONTROL}/${action}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
test.beforeEach(async ({ request }) => {
  // The fixture is shared across engines/legacy tests. Revoke prior disposable
  // sessions before measuring this journey's cleanup; never reset user deployments.
  await command(request, 'events-expire');
  await expect.poll(async () => (await command(request, 'status')).eventStreams).toBe(0);
});
test.afterEach(async ({ context, request }) => {
  // Service workers outlive pages. Explicitly release owners before context
  // teardown rather than depending on unload delivery to a terminating worker.
  for (const page of context.pages()) {
    const forget = page.getByRole('button', { name: 'Forget homelab', exact: true });
    if (await forget.count()) await forget.click();
  }
  await expect.poll(async () => (await command(request, 'status')).eventStreams).toBe(0);
});

test('cookie worker session completes CRUD/logout without native cookies or persistence', async ({
  page,
  context,
}) => {
  const headers: Record<string, string>[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/__locho_notes__/')) headers.push(response.headers());
  });
  await pair(page);
  await expect(page.getByLabel('Remember this device')).toHaveCount(0);
  await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
  await page.getByLabel('Password', { exact: true }).fill('wrong-disposable-password');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Login required or credentials rejected.');
  await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible();
  await login(page);
  const title = `Cookie ${Date.now()}`;
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Body', { exact: true }).fill('Worker-owned session');
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
  await page.getByLabel('Body', { exact: true }).fill('Updated cookie note');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Updated cookie note', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  expect((await context.cookies()).filter(({ name }) => name === 'locho_notes_session')).toEqual(
    [],
  );
  expect(
    await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      databases: (await indexedDB.databases()).map(({ name }) => name),
      caches: await caches.keys(),
    })),
  ).toEqual({ local: 0, session: 0, databases: [], caches: [] });
  expect(headers.length).toBeGreaterThan(0);
  expect(headers.every((value) => !('set-cookie' in value))).toBe(true);
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Logged out. Reconnect to log in.');
  await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible({
    timeout: 35000,
  });
});

test('tabs own independent sessions; cookie and bearer clients share live notes', async ({
  page,
  context,
}) => {
  const other = await context.newPage();
  const bearer = await context.newPage();
  let pageOwner = '';
  page.on('request', (request) => {
    pageOwner = request.headers()['x-locho-notes-owner'] ?? pageOwner;
  });
  await pair(page);
  await login(page);
  await pair(other);
  await login(other, 'bob');
  expect(Boolean(pageOwner)).toBe(true);
  const forged = await other.evaluate(
    async (id) =>
      (
        await fetch('/__locho_notes__/api/me', {
          headers: { 'X-Locho-Notes-Owner': id },
          credentials: 'omit',
        })
      ).status,
    pageOwner,
  );
  expect(forged).toBe(409);
  await pair(bearer, 'bearer');
  await login(bearer);
  const title = `Mixed ${Date.now()}`;
  await bearer.getByLabel('Title', { exact: true }).fill(title);
  await bearer.getByLabel('Body', { exact: true }).fill('Mixed auth live updates');
  await bearer.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(other.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
  await page.getByLabel('Body', { exact: true }).fill('Changed in cookie mode');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(bearer.locator('li pre').filter({ hasText: 'Changed in cookie mode' })).toHaveCount(
    1,
  );
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Logged out. Reconnect to log in.');
  await other.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect(other.getByRole('heading', { name: 'Notes for bob@example.test' })).toBeVisible();
  await bearer.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
  await expect(bearer.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  await other.getByRole('button', { name: 'Forget homelab', exact: true }).click();
  await bearer.getByRole('button', { name: 'Forget homelab', exact: true }).click();
  await other.close();
  await bearer.close();
});

test('fresh page ownership and ticket replacement never restore the old cookie', async ({
  page,
}) => {
  await pair(page);
  await login(page);
  // Even replacing the ticket with the same capability clears authentication.
  await enterTicket(page);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible({
    timeout: 35000,
  });
  await login(page);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('unpaired');
  await expect(page.getByRole('heading', { name: /^Notes for/ })).toHaveCount(0);
  await enterTicket(page);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible({
    timeout: 35000,
  });
});

test('cookie expiry clears protected content and permits a new login', async ({
  page,
  request,
}) => {
  await pair(page);
  await login(page);
  await command(request, 'events-expire');
  await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Notes for/ })).toHaveCount(0);
  await login(page);
});

test('cookie owner survives host restart without replaying mutations', async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  await pair(page);
  await login(page);
  const before = await command(request, 'status');
  try {
    await command(request, 'host-stop');
    await expect(page.getByRole('heading', { name: /^Notes for/ })).toHaveCount(0, {
      timeout: 35000,
    });
    await command(request, 'host-start');
    await expect(page.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible({
      timeout: 60000,
    });
    await expect(page.getByTestId('live-status')).toHaveText('Live updates: live');
    expect((await command(request, 'status')).mutations).toBe(before.mutations);
  } finally {
    await command(request, 'host-start');
  }
});

test('cookie writes lost after commit are unknown and never replayed', async ({
  page,
  request,
}) => {
  await pair(page);
  await login(page);
  const before = await command(request, 'status');
  const title = `Cookie interrupted ${Date.now()}`;
  await command(request, 'interrupt-POST');
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByLabel('Body', { exact: true }).fill('Committed before response loss');
  await page.getByRole('button', { name: 'Create note', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Write outcome unknown');
  await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
  const after = await command(request, 'status');
  expect(after.mutations - before.mutations).toBe(2);
  expect(after.dropped - before.dropped).toBe(1);
});

test('worker termination requires pairing rather than restoring a cookie', async ({
  page,
  context,
  browserName,
  request,
}) => {
  test.skip(browserName !== 'chromium', 'CDP provides actual worker termination only in Chromium');
  await pair(page);
  await login(page);
  const cdp = await context.newCDPSession(page);
  const version = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
      const active = versions.find(
        (value) =>
          value.scriptURL.endsWith('/locho-notes-sw.js') &&
          value.runningStatus === 'running' &&
          value.status === 'activated',
      );
      if (active) resolve(active.versionId);
    });
  });
  await cdp.send('ServiceWorker.enable');
  const versionId = await version;
  await cdp.send('ServiceWorker.stopWorker', { versionId });
  // Trigger a foreground request if the interrupted SSE has not retried yet.
  if (await page.getByRole('button', { name: 'Refresh notes', exact: true }).count())
    await page.getByRole('button', { name: 'Refresh notes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('unpaired', { timeout: 20000 });
  await expect(page.getByRole('alert')).toHaveText(
    'Service-worker session lost. Pair and log in again.',
  );
  await enterTicket(page);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible({
    timeout: 35000,
  });
  await cdp.detach();
  // A killed worker cannot send protocol cleanup. Revoke disposable fixture
  // sessions explicitly; do not claim immediate upstream reclamation on eviction.
  await command(request, 'events-expire');
});
