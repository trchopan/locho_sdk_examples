import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { preview as vitePreview } from 'vite';
import { fileURLToPath } from 'node:url';

/** Disposable production browser peer for native Flutter integration acceptance. */
export async function crossBrowser(fixture) {
  const preview = await vitePreview({
    root: fileURLToPath(new URL('../apps/web', import.meta.url)),
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  });
  const closePreview = async () => {
    preview.httpServer.closeAllConnections();
    await new Promise((resolve, reject) =>
      preview.httpServer.close((error) => (error ? reject(error) : resolve())),
    );
  };
  let browser;
  const control = createServer();
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const mode = process.env.LOCHO_CROSS_BROWSER_AUTH ?? 'cookie';
    if (!['cookie', 'bearer'].includes(mode)) throw new Error('Invalid browser auth mode');
    async function pair() {
      await page.goto(`http://127.0.0.1:4173/?auth=${mode}`);
      await page.getByLabel('Attachment ticket').evaluate((element, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
          element,
          value,
        );
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }, fixture.ticket);
      await page.getByRole('button', { name: 'Pair', exact: true }).click();
      await page.getByRole('heading', { name: 'Login', exact: true }).waitFor({ timeout: 35000 });
      await page.getByLabel('Email', { exact: true }).fill('alice@example.test');
      await page.getByLabel('Password', { exact: true }).fill('alice-local-demo-only');
      await page.getByRole('button', { name: 'Login', exact: true }).click();
      await page.getByTestId('live-status').filter({ hasText: 'Live updates: live' }).waitFor();
    }
    await pair();
    const title = `Cross-platform ${Date.now()}`;
    const note = () =>
      page.locator('li').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    async function create() {
      await page.getByRole('button', { name: 'Clear editor', exact: true }).click();
      await page.getByLabel('Title', { exact: true }).fill(title);
      await page.getByLabel('Body', { exact: true }).fill('Created in packaged browser');
      await page.getByRole('button', { name: 'Create note', exact: true }).click();
      await note().waitFor();
    }
    async function edit(body) {
      await note()
        .getByRole('button', { name: `Edit ${title}`, exact: true })
        .click();
      await page.getByLabel('Body', { exact: true }).fill(body);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await page.getByRole('button', { name: 'Save changes', exact: true }).waitFor();
      // Wait for the canonical response rather than assuming a click committed.
      await page.waitForFunction(
        (body) => [...document.querySelectorAll('li pre')].some((p) => p.textContent === body),
        body,
      );
    }
    control.on('request', async (request, response) => {
      try {
        const action = new URL(request.url, 'http://localhost').pathname.slice(1);
        if (action === 'browser-live') {
          if ((await page.getByTestId('live-status').textContent()) !== 'Live updates: live')
            throw new Error('Browser event stream not live');
        } else if (action === 'browser-create') await create();
        else if (action === 'browser-check-flutter')
          await note()
            .locator('pre')
            .filter({ hasText: 'Updated in Flutter' })
            .waitFor({ timeout: 20000 });
        else if (action === 'browser-delete') {
          await note()
            .getByRole('button', { name: `Delete ${title}`, exact: true })
            .click();
          await note().waitFor({ state: 'detached' });
        } else if (action === 'browser-check-create')
          await page
            .getByRole('heading', { name: 'Created in Flutter', exact: true })
            .waitFor({ timeout: 20000 });
        else if (action === 'browser-check-delete')
          await page
            .getByRole('heading', { name: 'Created in Flutter', exact: true })
            .waitFor({ state: 'detached', timeout: 20000 });
        else if (action === 'browser-edit-offline')
          await edit('Changed while Flutter events offline');
        else if (action === 'browser-edit-suspended') await edit('Changed while Flutter suspended');
        else {
          const upstream = await fetch(`${fixture.controlUrl}/${action}`, { method: 'POST' });
          if (!upstream.ok) throw new Error('Fixture operation rejected');
          response.setHeader('Content-Type', 'application/json');
          response.end(await upstream.text());
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ title }));
      } catch {
        response.writeHead(500).end();
      }
    });
    await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
    return {
      controlUrl: `http://127.0.0.1:${control.address().port}`,
      pair,
      forget: () => page.getByRole('button', { name: 'Forget homelab', exact: true }).click(),
      noteCount: () => page.locator('li').count(),
      createNote: create,
      editNote: edit,
      cleanup: async () => {
        await page
          .getByRole('button', { name: 'Forget homelab', exact: true })
          .click()
          .catch(() => {});
        await browser.close();
        control.closeAllConnections();
        await new Promise((resolve) => control.close(resolve));
        await closePreview();
      },
    };
  } catch (error) {
    await browser?.close();
    await closePreview();
    control.close();
    throw error;
  }
}
