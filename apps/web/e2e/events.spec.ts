import { test, expect, type Page, type APIRequestContext } from '@playwright/test';

async function command(request: APIRequestContext, action = 'status') {
  return (await request.post(`${process.env.LOCHO_BROWSER_CONTROL}/${action}`)).json();
}
async function login(page: Page, user = 'alice') {
  await page.goto('/');
  await page.getByLabel('Attachment ticket').evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, process.env.LOCHO_BROWSER_TICKET!);
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 35000 });
  await page.getByLabel('Email', { exact: true }).fill(`${user}@example.test`);
  await page.getByLabel('Password', { exact: true }).fill(`${user}-local-demo-only`);
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByTestId('live-status')).toHaveText('Live updates: live');
}

test('same-user live CRUD, cross-user isolation, reconnect and editor preservation', async ({ page, context, request }) => {
  const peer = await context.newPage(), bob = await context.newPage();
  await login(page); await login(peer); await login(bob, 'bob');
  const title = `Live ${Date.now()}`;
  try {
    await peer.getByLabel('Title', { exact: true }).fill('Unsaved draft');
    await peer.getByLabel('Body', { exact: true }).fill('Keep while refreshing');
    await page.getByLabel('Title', { exact: true }).fill(title);
    await page.getByLabel('Body', { exact: true }).fill('created elsewhere');
    await page.getByRole('button', { name: 'Create note', exact: true }).click();
    await expect(peer.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(bob.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
    await page.getByLabel('Body', { exact: true }).fill('live patched');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(peer.locator('li pre').filter({ hasText: 'live patched' })).toHaveCount(1);
    await command(request, 'events-pause');
    await expect(peer.getByTestId('live-status')).toHaveText('Live updates: reconnecting');
    await expect(peer.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await page.getByLabel('Body', { exact: true }).fill('changed during event outage');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(peer.locator('li pre').filter({ hasText: 'live patched' })).toHaveCount(1);
    await command(request, 'events-resume');
    await expect(peer.getByTestId('live-status')).toHaveText('Live updates: live', { timeout: 20000 });
    await expect(peer.locator('li pre').filter({ hasText: 'changed during event outage' })).toHaveCount(1);
    await expect(peer.getByLabel('Title', { exact: true })).toHaveValue('Unsaved draft');
    await expect(peer.getByLabel('Body', { exact: true })).toHaveValue('Keep while refreshing');
    await page.getByRole('button', { name: `Delete ${title}`, exact: true }).click();
    await expect(peer.getByRole('heading', { name: title, exact: true })).toHaveCount(0);
    await peer.getByRole('button', { name: 'Logout', exact: true }).click();
    await expect(peer.getByRole('heading', { name: /^Notes for/ })).toHaveCount(0);
    await expect.poll(async () => (await command(request)).eventStreams).toBe(2);
  } finally {
    await command(request, 'events-resume');
    for (const owner of [page, peer, bob]) await owner.getByRole('button', { name: 'Forget homelab', exact: true }).click();
    await expect.poll(async () => (await command(request)).eventStreams).toBe(0);
    await peer.close(); await bob.close();
  }
});

test('idle session expiry clears login and saved token while retaining pairing', async ({ page, request }) => {
  await login(page);
  await page.getByLabel('Remember this device').check();
  await expect(page.getByText('Updating saved credentials…', { exact: true })).toHaveCount(0);
  await command(request, 'events-expire');
  await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await command(request)).eventStreams).toBe(0);
  await expect.poll(() => page.evaluate(() => new Promise<boolean>((resolve, reject) => {
    const open = indexedDB.open('locho-notes-v1', 1);
    open.onerror = () => reject(new Error('storage'));
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('credentials', 'readonly');
      const rows = tx.objectStore('credentials').getAll();
      tx.oncomplete = () => { const values = rows.result; db.close(); resolve(values.length === 1 && values[0].auth === undefined); };
      tx.onerror = () => { db.close(); reject(new Error('storage')); };
    };
  }))).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Login', exact: true })).toBeVisible({ timeout: 35000 });
  await page.getByRole('button', { name: 'Forget homelab', exact: true }).click();
});

test('page suspension cancels events and resume revalidates without duplicate streams', async ({ page, request }) => {
  await login(page);
  await expect.poll(async () => (await command(request)).eventStreams).toBe(1);
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    await expect.poll(async () => (await command(request)).eventStreams).toBe(0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
    await expect(page.getByTestId('live-status')).toHaveText('Live updates: live', { timeout: 35000 });
    await expect.poll(async () => (await command(request)).eventStreams).toBe(1);
  }
  await page.getByRole('button', { name: 'Forget homelab', exact: true }).click();
  await expect.poll(async () => (await command(request)).eventStreams).toBe(0);
});
