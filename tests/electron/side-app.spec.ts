import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * The Claude side panel, against a local stand-in for claude.ai: the app lives
 * on 127.0.0.1 and "the rest of the web" on localhost, the same server under a
 * host name the app does not own.
 */

let server: Server;
let appOrigin = '';
let otherOrigin = '';
let application: ElectronApplication | undefined;
let userDataPath = '';

const PAGES: Record<string, string> = {
  '/app': '<!doctype html><title>Stand-in Claude</title><body style="margin:0;background:#f59e0b">Side app</body>',
  '/app/second': '<!doctype html><title>Second</title><body>Second page</body>',
  '/elsewhere': '<!doctype html><title>Elsewhere</title><body>Elsewhere</body>',
};

test.beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(PAGES[new URL(request.url ?? '/', 'http://localhost').pathname] ?? '<!doctype html><title>Other</title>');
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  appOrigin = `http://127.0.0.1:${port}`;
  otherOrigin = `http://localhost:${port}`;
});

test.afterAll(async () => {
  await new Promise((done) => server.close(done));
});

test.beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'private-browser-side-app-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.PRIVATE_BROWSER_E2E_USER_DATA = userDataPath;
  env.PRIVATE_BROWSER_E2E_SIDE_APP_URL = `${appOrigin}/app`;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [resolve('dist-electron/main.js'), '--no-proxy-server'], env });
});

test.afterEach(async () => {
  await application?.close();
  application = undefined;
  rmSync(userDataPath, { recursive: true, force: true });
});

/** The side app's native view as the main process sees it. */
function sideView(app: ElectronApplication, origin: string) {
  return app.evaluate(({ BrowserWindow }, prefix) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => /index\.html|127\.0\.0\.1:5173/.test(candidate.webContents.getURL()))!;
    const [width, height] = window.getContentSize();
    const view = window.contentView.children.find((child) => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().startsWith(prefix)) as Electron.WebContentsView | undefined;
    if (!view) return undefined;
    return { visible: view.getVisible(), bounds: view.getBounds(), url: view.webContents.getURL(), contentWidth: width, contentHeight: height, partition: view.webContents.session.storagePath };
  }, `${origin}/app`);
}

function runInSideApp<T>(app: ElectronApplication, code: string): Promise<T> {
  return app.evaluate(({ webContents }, { prefix, script }) => {
    const contents = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(prefix))!;
    return contents.executeJavaScript(script, true);
  }, { prefix: `${appOrigin}/app`, script: code }) as Promise<T>;
}

async function openClaude(page: Page) {
  await page.evaluate(() => window.privateBrowser.setUiPreferences({ sidePanelOpen: true, sidePanelTool: 'claude' }));
  await expect(page.locator('.side-app-slot')).toBeVisible();
  await expect.poll(async () => (await sideView(application!, appOrigin))?.visible).toBe(true);
}

test('Claude opens in the side panel, beside the page and cut off from the browser', async () => {
  const page = await application!.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await openClaude(page);

  const view = (await sideView(application!, appOrigin))!;
  const slot = await page.locator('.side-app-slot').boundingBox();
  // The native view covers exactly the slot the panel drew for it.
  expect(Math.abs(view.bounds.x - Math.round(slot!.x))).toBeLessThanOrEqual(1);
  expect(Math.abs(view.bounds.y - Math.round(slot!.y))).toBeLessThanOrEqual(1);
  expect(view.bounds.x + view.bounds.width).toBeLessThanOrEqual(view.contentWidth);

  // No preload, no Node, no browser bridge; and a session of its own.
  expect(await runInSideApp<string>(application!, '[typeof require, typeof process, typeof window.privateBrowser].join()')).toBe('undefined,undefined,undefined');
  const sessions = await application!.evaluate(({ webContents }, prefix) => {
    const all = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed());
    const side = all.find((contents) => contents.getURL().startsWith(prefix))!;
    return { sharedWithTab: all.some((contents) => contents !== side && contents.session === side.session) };
  }, `${appOrigin}/app`);
  expect(sessions.sharedWithTab).toBe(false);

  // The toolbar button shows it as open.
  await expect(page.getByRole('button', { name: 'Claude', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('links out of Claude open as tabs, and the panel cannot leave its own site', async () => {
  const page = await application!.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await openClaude(page);
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());

  // Its own pages stay in the panel.
  await runInSideApp(application!, `location.href = '${appOrigin}/app/second'; true`);
  await expect.poll(async () => (await sideView(application!, appOrigin))?.url).toBe(`${appOrigin}/app/second`);

  // A plain link elsewhere becomes a tab and the panel stays put.
  await runInSideApp(application!, `location.href = '${otherOrigin}/elsewhere'; true`);
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.some((tab) => tab.url === `${otherOrigin}/elsewhere`)).toBe(true);
  expect((await sideView(application!, appOrigin))?.url).toBe(`${appOrigin}/app/second`);

  // So does window.open.
  await runInSideApp(application!, `window.open('${otherOrigin}/elsewhere?opened=1'); true`);
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.some((tab) => tab.url === `${otherOrigin}/elsewhere?opened=1`)).toBe(true);

  // And nothing walks it off the web.
  await runInSideApp(application!, `location.href = 'file:///C:/Windows/win.ini'; true`);
  await new Promise((settle) => setTimeout(settle, 500));
  expect((await sideView(application!, appOrigin))?.url).toBe(`${appOrigin}/app/second`);
});

test('Claude hides in Banking, under menus and in full screen, and signs out cleanly', async () => {
  const page = await application!.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await openClaude(page);

  // A menu over the chrome hides it, closing the menu shows it again.
  await page.evaluate(() => window.privateBrowser.setOverlayOpen(true));
  await expect.poll(async () => (await sideView(application!, appOrigin))?.visible).toBe(false);
  await page.evaluate(() => window.privateBrowser.setOverlayOpen(false));
  await expect.poll(async () => (await sideView(application!, appOrigin))?.visible).toBe(true);

  // Full screen gives the page the whole window.
  await page.evaluate(() => window.privateBrowser.toggleFullscreen());
  await expect.poll(async () => (await sideView(application!, appOrigin))?.visible).toBe(false);
  await page.evaluate(() => window.privateBrowser.toggleFullscreen());
  await expect.poll(async () => (await sideView(application!, appOrigin))?.visible).toBe(true);

  // Banking turns it off, and links from it are refused there.
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect.poll(async () => (await sideView(application!, appOrigin))?.visible).toBe(false);
  await expect(page.getByText('Claude is turned off in Banking')).toBeVisible();
  const bankingTabs = async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.filter((tab) => tab.workspaceId === 'banking').length;
  const before = await bankingTabs();
  await runInSideApp(application!, `window.open('${otherOrigin}/elsewhere?banking=1'); true`);
  await new Promise((settle) => setTimeout(settle, 500));
  expect(await bankingTabs()).toBe(before);

  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await expect.poll(async () => (await sideView(application!, appOrigin))?.visible).toBe(true);

  // Signing out deletes what the app stored and starts it fresh.
  await runInSideApp(application!, `localStorage.setItem('signed-in', 'yes'); true`);
  await page.evaluate(() => window.privateBrowser.clearSideAppData('claude'));
  await expect.poll(async () => (await sideView(application!, appOrigin))?.visible).toBe(true);
  await expect.poll(() => runInSideApp<string | null>(application!, `localStorage.getItem('signed-in')`)).toBeNull();
  const state = await page.evaluate(() => window.privateBrowser.getState());
  expect(state.privacyLog.some((event) => event.title === 'Claude signed out')).toBe(true);

  // Closing the panel hides it.
  await page.evaluate(() => window.privateBrowser.setUiPreferences({ sidePanelOpen: false }));
  await expect.poll(async () => (await sideView(application!, appOrigin))?.visible).toBe(false);
});
