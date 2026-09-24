import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let application: ElectronApplication | undefined;
let userDataPath: string;
let origin: string;
let server: Server;
let iconRequests = 0;

async function launch(): Promise<ElectronApplication> {
  const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userDataPath}`], env });
}

test.beforeEach(async () => {
  iconRequests = 0;
  server = createServer((request, response) => {
    if (request.url === '/icon.png') {
      iconRequests += 1;
      response.setHeader('Content-Type', 'image/png');
      response.end(ICON);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Icon fixture</title><link rel="icon" href="/icon.png">');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP');
  origin = `http://127.0.0.1:${address.port}`;
  userDataPath = mkdtempSync(join(tmpdir(), 'private-browser-electron-'));
  application = await launch();
});

test.afterEach(async () => {
  await application?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(userDataPath, { recursive: true, force: true });
});

test('a bookmark keeps the icon of a site after its tab closes and across a restart', async () => {
  let page = await application!.firstWindow();
  const state = await page.evaluate(() => window.privateBrowser.getState());
  await page.evaluate(
    // The first load can be superseded and report ERR_ABORTED; the tab still opens.
    ({ accountSpaceId, target }) => window.privateBrowser.openInAccountSpace(accountSpaceId, target)
      .catch((error) => {
        if (!(error instanceof Error) || !error.message.includes('ERR_ABORTED')) throw error;
      }),
    { accountSpaceId: state.activeAccountSpaceId, target: `${origin}/` },
  );
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.find((tab) => tab.url.startsWith(origin))?.favicon).toMatch(/^data:image\/png;base64,/);

  await page.evaluate(() => window.privateBrowser.toggleBookmark());
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).bookmarkIcons['127.0.0.1']).toMatch(/^data:image\/png;base64,/);

  const tabId = (await page.evaluate(() => window.privateBrowser.getState())).tabs.find((tab) => tab.url.startsWith(origin))!.id;
  await page.evaluate((id) => window.privateBrowser.closeTab(id), tabId);
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.some((tab) => tab.url.startsWith(origin))).toBe(false);
  await expect(page.locator('.bookmark-bar .bookmark-item img').first()).toHaveAttribute('src', /^data:image\/png;base64,/);

  await application!.close();
  const requestsBeforeRestart = iconRequests;
  application = await launch();
  page = await application.firstWindow();
  await expect(page.locator('.bookmark-bar .bookmark-item img').first()).toHaveAttribute('src', /^data:image\/png;base64,/);
  // Showing a remembered icon must never contact the site.
  expect(iconRequests).toBe(requestsBeforeRestart);
});
