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
  '/notes': '<!doctype html><title>Stand-in Notes</title><body>Notes</body>',
  '/notes/second': '<!doctype html><title>Notes second</title><body>Second notes page</body>',
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
  env.PRIVATE_BROWSER_E2E_NOTES_URL = `${appOrigin}/notes`;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [resolve('dist-electron/main.js'), '--no-proxy-server'], env });
});

test.afterEach(async () => {
  await application?.close();
  application = undefined;
  rmSync(userDataPath, { recursive: true, force: true });
});

/** The side app's native view as the main process sees it. */
function sideView(app: ElectronApplication, origin: string, id: 'claude' | 'easynote' = 'claude') {
  return app.evaluate(({ BrowserWindow }, { prefix, partition }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => /index\.html|127\.0\.0\.1:5173/.test(candidate.webContents.getURL()))!;
    const [width, height] = window.getContentSize();
    const view = window.contentView.children.find((child) => 'webContents' in child && (child as Electron.WebContentsView).webContents.getURL().startsWith(prefix) && (child as Electron.WebContentsView).webContents.session.storagePath?.endsWith(partition)) as Electron.WebContentsView | undefined;
    if (!view) return undefined;
    return { visible: view.getVisible(), bounds: view.getBounds(), url: view.webContents.getURL(), contentWidth: width, contentHeight: height, partition: view.webContents.session.storagePath };
  }, { prefix: `${origin}/${id === 'claude' ? 'app' : 'notes'}`, partition: `private-browser-side-app-${id}` });
}

function runInSideApp<T>(app: ElectronApplication, code: string, id: 'claude' | 'easynote' = 'claude'): Promise<T> {
  return app.evaluate(({ webContents }, { prefix, script, partition }) => {
    const contents = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed() && candidate.getURL().startsWith(prefix) && candidate.session.storagePath?.endsWith(partition))!;
    return contents.executeJavaScript(script, true);
  }, { prefix: `${appOrigin}/${id === 'claude' ? 'app' : 'notes'}`, script: code, partition: `private-browser-side-app-${id}` }) as Promise<T>;
}

async function openSideApp(page: Page, id: 'claude' | 'easynote' = 'claude') {
  await page.evaluate(id => window.privateBrowser.setUiPreferences({ sidePanelOpen: true, sidePanelTool: id }), id);
  await expect(page.locator('.side-app-slot')).toBeVisible();
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.visible).toBe(true);
}

for (const id of ['claude', 'easynote'] as const) {
const name = id === 'claude' ? 'Claude' : 'Notes';
const path = id === 'claude' ? 'app' : 'notes';
test(`${name} opens in the side panel, beside the page and cut off from the browser`, async () => {
  const page = await application!.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await openSideApp(page, id);

  await expect.poll(async () => {
    const view = await sideView(application!, appOrigin, id);
    const slot = await page.locator('.side-app-slot').boundingBox();
    return Boolean(view && slot && Math.abs(view.bounds.x - Math.round(slot.x)) <= 1 && Math.abs(view.bounds.y - Math.round(slot.y)) <= 1);
  }).toBe(true);
  const view = (await sideView(application!, appOrigin, id))!;
  const slot = await page.locator('.side-app-slot').boundingBox();
  // The native view covers exactly the slot the panel drew for it.
  expect(Math.abs(view.bounds.x - Math.round(slot!.x))).toBeLessThanOrEqual(1);
  expect(Math.abs(view.bounds.y - Math.round(slot!.y))).toBeLessThanOrEqual(1);
  expect(view.bounds.x + view.bounds.width).toBeLessThanOrEqual(view.contentWidth);

  // No preload, no Node, no browser bridge; and a session of its own.
  expect(await runInSideApp<string>(application!, '[typeof require, typeof process, typeof window.privateBrowser].join()', id)).toBe('undefined,undefined,undefined');
  const sessions = await application!.evaluate(({ webContents }, prefix) => {
    const all = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed());
    const side = all.find((contents) => contents.getURL().startsWith(prefix))!;
    return { sharedWithTab: all.some((contents) => contents !== side && contents.session === side.session) };
  }, `${appOrigin}/${path}`);
  expect(sessions.sharedWithTab).toBe(false);

  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
});

test(`links out of ${name} open as tabs, and the panel cannot leave its own site`, async () => {
  const page = await application!.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await openSideApp(page, id);
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());

  // Its own pages stay in the panel.
  await runInSideApp(application!, `location.href = '${appOrigin}/${path}/second'; true`, id);
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.url).toBe(`${appOrigin}/${path}/second`);

  // A plain link elsewhere becomes a tab and the panel stays put.
  await runInSideApp(application!, `location.href = '${otherOrigin}/elsewhere'; true`, id);
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.some((tab) => tab.url === `${otherOrigin}/elsewhere`)).toBe(true);
  expect((await sideView(application!, appOrigin, id))?.url).toBe(`${appOrigin}/${path}/second`);

  // So does window.open.
  await runInSideApp(application!, `window.open('${otherOrigin}/elsewhere?opened=1'); true`, id);
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.some((tab) => tab.url === `${otherOrigin}/elsewhere?opened=1`)).toBe(true);

  // And nothing walks it off the web.
  await runInSideApp(application!, `location.href = 'file:///C:/Windows/win.ini'; true`, id);
  await new Promise((settle) => setTimeout(settle, 500));
  expect((await sideView(application!, appOrigin, id))?.url).toBe(`${appOrigin}/${path}/second`);
});

test(`${name} hides in Banking, under menus and in full screen, and signs out cleanly`, async () => {
  const page = await application!.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await openSideApp(page, id);

  // A menu over the chrome hides it, closing the menu shows it again.
  await page.evaluate(() => window.privateBrowser.setOverlayOpen(true));
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.visible).toBe(false);
  await page.evaluate(() => window.privateBrowser.setOverlayOpen(false));
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.visible).toBe(true);

  // Full screen gives the page the whole window.
  await page.evaluate(() => window.privateBrowser.toggleFullscreen());
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.visible).toBe(false);
  await page.evaluate(() => window.privateBrowser.toggleFullscreen());
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.visible).toBe(true);

  // Banking turns it off, and links from it are refused there.
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.visible).toBe(false);
  await expect(page.getByText(`${name} is turned off in Banking`)).toBeVisible();
  const bankingTabs = async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.filter((tab) => tab.workspaceId === 'banking').length;
  const before = await bankingTabs();
  await runInSideApp(application!, `window.open('${otherOrigin}/elsewhere?banking=1'); true`, id);
  await new Promise((settle) => setTimeout(settle, 500));
  expect(await bankingTabs()).toBe(before);

  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.visible).toBe(true);

  // Signing out deletes what the app stored and starts it fresh.
  await runInSideApp(application!, `localStorage.setItem('signed-in', 'yes'); true`, id);
  await page.evaluate(id => window.privateBrowser.clearSideAppData(id), id);
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.visible).toBe(true);
  await expect.poll(() => runInSideApp<string | null>(application!, `localStorage.getItem('signed-in')`, id)).toBeNull();
  const state = await page.evaluate(() => window.privateBrowser.getState());
  expect(state.privacyLog.some((event) => event.title === (id === 'claude' ? 'Claude signed out' : 'Local Notes data cleared'))).toBe(true);

  // Closing the panel hides it.
  await page.evaluate(() => window.privateBrowser.setUiPreferences({ sidePanelOpen: false }));
  await expect.poll(async () => (await sideView(application!, appOrigin, id))?.visible).toBe(false);
});
}

test('switching tools hides stale bounds; Notes survives close and restart, and clearing is partition-local', async () => {
  let page = await application!.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await page.evaluate(url => window.privateBrowser.navigate(url), `${appOrigin}/elsewhere`);
  await openSideApp(page, 'claude');
  await runInSideApp(application!, "localStorage.setItem('keep', 'claude'); true");
  await openSideApp(page, 'easynote');
  await expect.poll(async () => (await sideView(application!, appOrigin, 'claude'))?.visible).toBe(false);
  await runInSideApp(application!, "localStorage.setItem('keep', 'notes'); true", 'easynote');
  await page.evaluate(() => window.privateBrowser.sideAppCommand('easynote', 'open-in-tab'));
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.some(tab => tab.url.endsWith('/notes'))).toBe(true);
  await expect.poll(() => application!.evaluate(({ webContents }) => new Set(webContents.getAllWebContents().filter(c => !c.isDestroyed() && c.getURL().includes('/notes')).map(c => c.session.storagePath)).size)).toBe(2);
  await application!.evaluate(({ webContents }) => webContents.getAllWebContents().find(c => c.getURL().endsWith('/notes') && !c.session.storagePath?.endsWith('private-browser-side-app-easynote'))!.executeJavaScript("localStorage.setItem('keep', 'tab'); true"));
  await page.evaluate(() => window.privateBrowser.setUiPreferences({ sidePanelOpen: false }));
  await expect.poll(async () => (await sideView(application!, appOrigin, 'easynote'))?.visible).toBe(false);
  await openSideApp(page, 'easynote');
  expect(await runInSideApp(application!, "localStorage.getItem('keep')", 'easynote')).toBe('notes');
  await page.evaluate(() => window.privateBrowser.setUiPreferences({ sidePanelWidth: 520 }));
  await application!.close();
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { PRIVATE_BROWSER_E2E_USER_DATA: userDataPath, PRIVATE_BROWSER_E2E_SIDE_APP_URL: `${appOrigin}/app`, PRIVATE_BROWSER_E2E_NOTES_URL: `${appOrigin}/notes` });
  application = await electron.launch({ args: [resolve('dist-electron/main.js'), '--no-proxy-server'], env });
  page = await application.firstWindow();
  await expect.poll(async () => (await sideView(application!, appOrigin, 'easynote'))?.visible).toBe(true);
  expect((await page.evaluate(() => window.privateBrowser.getState())).ui).toMatchObject({ sidePanelTool: 'easynote', sidePanelWidth: 520, sidePanelOpen: true });
  expect(await runInSideApp(application!, "localStorage.getItem('keep')", 'easynote')).toBe('notes');
  // Reopened Notes and an ordinary tab share the URL, but never a partition.
  await page.evaluate(() => window.privateBrowser.clearSideAppData('easynote'));
  await expect.poll(async () => (await sideView(application!, appOrigin, 'easynote'))?.visible).toBe(true);
  await expect.poll(() => runInSideApp(application!, "localStorage.getItem('keep')", 'easynote')).toBeNull();
  expect(await application!.evaluate(({ webContents }) => webContents.getAllWebContents().find(c => c.getURL().endsWith('/notes') && !c.session.storagePath?.endsWith('private-browser-side-app-easynote'))!.executeJavaScript("localStorage.getItem('keep')"))).toBe('tab');
  await openSideApp(page, 'claude');
  expect(await runInSideApp(application!, "localStorage.getItem('keep')")).toBe('claude');
  await page.evaluate(() => window.privateBrowser.setUiPreferences({ sidePanelTool: 'assistant' }));
  await expect.poll(async () => (await sideView(application!, appOrigin, 'claude'))?.visible).toBe(false);
  // A stale renderer report cannot make the wrong side app visible.
  await page.evaluate(() => window.privateBrowser.setSideAppBounds('easynote', { x: 0, y: 0, width: 1600, height: 1000 }));
  expect((await sideView(application!, appOrigin, 'easynote'))?.visible).toBe(false);
});


test('Notes restores chrome focus when hidden and recovers a crashed renderer', async () => {
  const page = await application!.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await openSideApp(page, 'easynote');
  await application!.evaluate(({ BrowserWindow, webContents }) => {
    BrowserWindow.getAllWindows()[0]!.focus();
    webContents.getAllWebContents().find(c => c.session.storagePath?.endsWith('private-browser-side-app-easynote'))!.focus();
  });
  await page.evaluate(() => window.privateBrowser.setUiPreferences({ sidePanelOpen: false }));
  await expect.poll(async () => (await sideView(application!, appOrigin, 'easynote'))?.visible).toBe(false);
  expect(await application!.evaluate(({ webContents }) => webContents.getAllWebContents().find(c => c.session.storagePath?.endsWith('private-browser-side-app-easynote'))!.isFocused())).toBe(false);
  await openSideApp(page, 'easynote');
  await application!.evaluate(({ webContents }) => webContents.getAllWebContents().find(c => c.session.storagePath?.endsWith('private-browser-side-app-easynote'))!.forcefullyCrashRenderer());
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).sideApps.find(app => app.id === 'easynote')?.status).toBe('crashed');
  await expect(page.getByRole('status').filter({ hasText: 'The panel stopped working' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload', exact: true }).last().click();
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).sideApps.find(app => app.id === 'easynote')?.status).toBe('ready');
});
