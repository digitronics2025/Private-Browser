import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let application: ElectronApplication | undefined;
let userDataPath: string;
let port: number;
let server: Server;

test.beforeEach(async () => {
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Containment fixture</title><p>fixture</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP');
  port = address.port;
  userDataPath = mkdtempSync(join(tmpdir(), 'private-browser-containment-'));
  const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userDataPath}`], env });
});

test.afterEach(async () => {
  await application?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(userDataPath, { recursive: true, force: true });
});

async function openFromPage(pageUrlPrefix: string, target: string): Promise<void> {
  await application!.evaluate(async ({ webContents }, { prefix, url }) => {
    const source = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(prefix));
    if (!source) throw new Error(`No page view for ${prefix}`);
    await source.executeJavaScript(`window.open(${JSON.stringify(url)})`);
  }, { prefix: pageUrlPrefix, url: target });
}

async function windowCount(): Promise<number> {
  return application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
}

// F-28: a punycode first address used to throw inside view creation, leaving
// the view with no popup, navigation or tab-tracking handlers.
test('a tab opened on an internationalised domain keeps every page guard', async () => {
  const page = await application!.firstWindow();
  const idn = `http://xn--80ak6aa92e.localhost:${port}`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), `${idn}/`);
  await expect.poll(async () => application!.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().some((contents) => contents.getURL().startsWith(prefix)), idn)).toBe(true);
  const windowsBefore = await windowCount();

  // The popup becomes a tab in the model, not a free-floating window.
  await openFromPage(idn, `http://127.0.0.1:${port}/popup`);
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.some((tab) => tab.url === `http://127.0.0.1:${port}/popup`)).toBe(true);
  expect(await windowCount()).toBe(windowsBefore);

  // In-page navigation is tracked, so the tab's recorded address follows the page.
  await application!.evaluate(async ({ webContents }, prefix) => {
    const source = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(prefix));
    await source!.executeJavaScript(`history.pushState({}, '', '/moved')`);
  }, idn);
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.some((tab) => tab.url === `${idn}/moved`)).toBe(true);
});

// F-31: a background page used to pull the user out of the workspace they
// were in, including Banking, and could open tabs without limit.
test('a hidden tab cannot take the foreground or open unlimited tabs', async () => {
  const page = await application!.firstWindow();
  const origin = `http://127.0.0.1:${port}`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), `${origin}/source`);
  await expect.poll(async () => application!.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL() === url), `${origin}/source`)).toBe(true);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).activeWorkspaceId).toBe('banking');

  for (let index = 0; index < 8; index += 1) await openFromPage(`${origin}/source`, `${origin}/background-${index}`);
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.filter((tab) => tab.url.startsWith(`${origin}/background-`)).length).toBe(5);

  const state = await page.evaluate(() => window.privateBrowser.getState());
  expect(state.activeWorkspaceId).toBe('banking');
  expect(state.privacyLog.some((event) => event.title === 'Popups blocked')).toBe(true);
});

// F-30: locking the account in use used to leave the workspace pointing at it,
// so the next menu close rebuilt its page in the locked partition.
test('locking the active Account Space closes its page and it stays closed', async () => {
  const page = await application!.firstWindow();
  const origin = `http://127.0.0.1:${port}`;
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  const locked = (await page.evaluate(() => window.privateBrowser.getState())).activeAccountSpaceId;
  await page.evaluate((target) => window.privateBrowser.navigate(target), `${origin}/locked-account`);
  const hasView = () => application!.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => !contents.isDestroyed() && contents.getURL() === url), `${origin}/locked-account`);
  await expect.poll(hasView).toBe(true);
  await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Second', 'emerald'));
  await page.evaluate((id) => window.privateBrowser.switchAccountSpace(id), locked);

  await page.evaluate((id) => window.privateBrowser.setAccountSpaceLocked(id, true), locked);
  await page.evaluate(() => window.privateBrowser.setOverlayOpen(true));
  await page.evaluate(() => window.privateBrowser.setOverlayOpen(false));

  const state = await page.evaluate(() => window.privateBrowser.getState());
  expect(state.activeWorkspaceId).toBe('personal');
  expect(state.activeAccountSpaceId).not.toBe(locked);
  await expect.poll(hasView).toBe(false);
});
