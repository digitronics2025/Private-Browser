import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('sends only reviewed selections from the current Account Space and refuses a changed source', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'private-browser-ai-sources-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.PRIVATE_BROWSER_E2E_USER_DATA = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  const server = createServer((request, response) => {
    const reference = request.url?.startsWith('/reference');
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(reference
      ? '<!doctype html><title>Reference product</title><p id="excerpt">The reference page lists a ceramic mug.</p><p>An unrelated description.</p>'
      : '<!doctype html><title>First product</title><p>The first page lists a brass kettle.</p>');
  });
  await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready); });
  const app = await electron.launch({ args: [resolve('dist-electron/main.js')], env });
  try {
    await app.evaluate(() => {
      const root = globalThis as typeof globalThis & { __pbReviewedSourceRequests?: string[] };
      root.__pbReviewedSourceRequests = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input) !== 'https://ai-fixture.example.com/v1/chat/completions') return original(input, init);
        root.__pbReviewedSourceRequests!.push(String(init?.body ?? ''));
        return Response.json({ choices: [{ message: { content: 'One product is brass and the other is ceramic.' } }] });
      };
    });
    const page = await app.firstWindow();
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await page.evaluate(() => window.privateBrowser.configureAiProvider({ endpoint: 'https://ai-fixture.example.com/v1', model: 'fixture', apiKey: '' }));
    await page.evaluate((target) => window.privateBrowser.navigate(target), `${origin}/first`);
    await expect(page.getByRole('tab', { name: /First product/ })).toBeVisible();
    const tabId = () => page.evaluate(() => window.privateBrowser.getState().then((state) => state.activeTabId));
    const firstId = await tabId();
    await page.evaluate((target) => window.privateBrowser.newTab(undefined, target), `${origin}/reference?sku=synthetic`);
    await expect(page.getByRole('tab', { name: /Reference product/ })).toBeVisible();
    const secondId = await tabId();
    await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.getVisible()) as Electron.WebContentsView;
      await view.webContents.executeJavaScript("const range = document.createRange(); range.selectNodeContents(document.querySelector('#excerpt')); getSelection().addRange(range);");
    });
    await page.evaluate((id) => window.privateBrowser.activateTab(id), firstId);
    const capture = () => page.evaluate(async (id) => {
      const base = await window.privateBrowser.prepareAiPreview();
      return { base, extra: await window.privateBrowser.prepareAssistantSource(base.id, id) };
    }, secondId);
    const prepare = (data: Awaited<ReturnType<typeof capture>>, include: boolean) => page.evaluate(({ base, extra, include }) =>
      window.privateBrowser.reviewAssistantRequest(base.id, base.text, 'Compare the two products.', false, include ? [{ id: extra.id, text: extra.text }] : []),
    { ...data, include });
    const firstRead = await capture();
    expect(firstRead.extra.text).toBe('The reference page lists a ceramic mug.');
    const single = await prepare(firstRead, false);
    expect(single.userPrompt).not.toContain('Reference product');
    const combined = await prepare(firstRead, true);
    expect(combined.userPrompt).toContain(`source="1" title="First product" url="${origin}"`);
    expect(combined.userPrompt).toContain(`source="2" title="Reference product" url="${origin}"`);
    expect(combined.userPrompt).not.toContain('An unrelated description');
    expect(combined.userPrompt).not.toContain('sku=');
    await page.evaluate((id) => window.privateBrowser.sendReviewedAssistant(id), combined.id);

    const secondRead = await capture();
    const stale = await prepare(secondRead, true);
    await page.evaluate((id) => window.privateBrowser.closeTab(id), secondId);
    await expect(page.evaluate((id) => window.privateBrowser.sendReviewedAssistant(id), stale.id)).rejects.toThrow(/added source changed/i);
    const requests = await app.evaluate(() => (globalThis as typeof globalThis & { __pbReviewedSourceRequests?: string[] }).__pbReviewedSourceRequests);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests![0]).messages[1].content).toBe(combined.userPrompt);
  } finally {
    await app.close();
    await new Promise<void>((closed) => {
      server.close(() => closed());
      server.closeAllConnections();
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  }
});
