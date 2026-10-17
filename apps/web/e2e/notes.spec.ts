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

async function savedCount(page: Page) {
  return page.evaluate(async () => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('locho-notes-v1', 1);
    open.onerror = () => reject(new Error('storage'));
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('credentials', 'readonly');
      const count = tx.objectStore('credentials').count();
      tx.oncomplete = () => { const value = count.result; db.close(); resolve(value); };
      tx.onerror = () => { db.close(); reject(new Error('storage')); };
    };
  }));
}

test('remembered login restores, remember off deletes and forget stays forgotten', async ({ page }) => {
  await pair(page);
  await page.getByLabel('Remember this device').check();
  await login(page, 'alice');
  await expect.poll(() => savedCount(page)).toBe(1);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible({ timeout: 35000 });
  await expect(page.getByLabel('Remember this device')).toBeChecked();
  // Real page events exercise ownership restoration, without relying on BFCache availability.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.getByRole('heading', { name: /^Notes for/ })).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible({ timeout: 35000 });
  await page.getByLabel('Remember this device').uncheck();
  await expect.poll(() => savedCount(page)).toBe(0);
  await expect(page.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('status')).toHaveText('unpaired');
  await pair(page); await page.getByLabel('Remember this device').check(); await login(page, 'alice');
  await page.getByRole('button', { name: 'Forget homelab', exact: true }).click();
  await expect.poll(() => savedCount(page)).toBe(0);
  await page.reload(); await expect(page.getByRole('status')).toHaveText('unpaired');
});

test('remembered logout removes token but retains pairing', async ({ page }) => {
  await pair(page); await page.getByLabel('Remember this device').check(); await login(page, 'bob');
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Logged out. Reconnect to log in.');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 35000 });
  await expect(page.getByLabel('Remember this device')).toBeChecked();
  await expect.poll(() => savedCount(page)).toBe(1);
});

test('blocked IndexedDB reports failure without breaking memory login', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, 'open', { value: () => { throw new Error('Storage unavailable'); } });
  });
  await pair(page); await page.getByLabel('Remember this device').check(); await login(page, 'alice');
  await expect(page.getByRole('alert')).toContainText('Storage failed.');
  await expect(page.getByRole('heading', { name: 'Notes for alice@example.test' })).toBeVisible();
});

test('revoked remembered token returns to login and retains pairing', async ({ page }) => {
  await pair(page); await page.getByLabel('Remember this device').check(); await login(page, 'alice');
  // Keep a copy entirely in the browser to simulate a revoked saved token on next launch.
  await page.evaluate(async () => {
    (window as any).savedRecord = await new Promise((resolve) => {
      const open = indexedDB.open('locho-notes-v1', 1);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('credentials', 'readonly');
        const rows = tx.objectStore('credentials').getAll();
        tx.oncomplete = () => { db.close(); resolve(rows.result[0]); };
      };
    });
  });
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Logged out. Reconnect to log in.');
  await page.evaluate(async () => new Promise<void>((resolve) => {
    const open = indexedDB.open('locho-notes-v1', 1);
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction('credentials', 'readwrite');
      tx.objectStore('credentials').put((window as any).savedRecord);
      delete (window as any).savedRecord;
      tx.oncomplete = () => { db.close(); resolve(); };
    };
  }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible({ timeout: 35000 });
  await expect.poll(() => savedCount(page)).toBe(1);
});

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
  await expect(page.locator('li').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).locator('pre')).toContainText('Edited body');
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
