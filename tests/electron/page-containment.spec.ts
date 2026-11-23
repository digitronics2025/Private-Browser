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
    response.end('<!doctype html><title>Containment fixture</title><p>fixture</p><a href="/background-menu">Background link</a><input aria-label="Message" value="Sample text">');
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

test('page context menu responds to mouse and keyboard, with commands scoped to the active page', async () => {
  const page = await application!.firstWindow();
  const origin = `http://127.0.0.1:${port}`;
  const url = origin + '/context';
  type Capture = { labels: string[]; source?: string; calls: number; copies: number; open?: () => void; foreground?: () => void; copy?: () => void };
  await application!.evaluate(({ Menu, BrowserWindow }) => {
    const capture: Capture = { labels: [], calls: 0, copies: 0 };
    Object.assign(globalThis, { pageMenuCapture: capture });
    Menu.prototype.popup = function (options) {
      capture.calls += 1;
      capture.source = options?.sourceType;
      capture.labels = this.items.map((item) => item.label);
      const foreground = this.items.find((item) => item.label === 'Open link in new tab');
      if (foreground) capture.foreground = () => Reflect.apply(foreground.click, foreground, [foreground, BrowserWindow.getAllWindows()[0], {}]);
      const open = this.items.find((item) => item.label === 'Open link in background tab');
      if (open) capture.open = () => Reflect.apply(open.click, open, [open, BrowserWindow.getAllWindows()[0], {}]);
      const copy = this.items.find((item) => item.label === 'Copy selected text');
      if (copy) capture.copy = () => Reflect.apply(copy.click, copy, [copy, BrowserWindow.getAllWindows()[0], {}]);
    };
  });
  const capture = () => application!.evaluate(() => {
    const { labels, source, calls, copies } = (globalThis as unknown as { pageMenuCapture: Capture }).pageMenuCapture;
    return { labels, source, calls, copies };
  });
  const openAt = (target: string, command: 'mouse' | 'keyboard') => application!.evaluate(async ({ webContents }, { target, command }) => {
    const contents = webContents.getAllWebContents().find((item) => item.getURL() === target)!;
    contents.focus();
    const delivered = new Promise<string>((resolve) => contents.once('context-menu', (_event, params) => resolve(params.menuSourceType)));
    if (command === 'mouse') {
      const point = await contents.executeJavaScript(`(() => {
        const rect = document.querySelector('a').getBoundingClientRect();
        return { x: Math.round(rect.x + 4), y: Math.round(rect.y + rect.height / 2) };
      })()`);
      contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'right', clickCount: 1 });
      contents.sendInputEvent({ type: 'mouseUp', ...point, button: 'right', clickCount: 1 });
    } else {
      contents.copy = () => { (globalThis as unknown as { pageMenuCapture: Capture }).pageMenuCapture.copies += 1; };
      await contents.executeJavaScript("const field = document.querySelector('input'); field.focus(); field.select()");
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'F10', modifiers: ['shift'] });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'F10', modifiers: ['shift'] });
    }
    return delivered;
  }, { target, command });
  const invoke = (command: 'open' | 'foreground' | 'copy') => application!.evaluate((_electron, action) => {
    (globalThis as unknown as { pageMenuCapture: Capture }).pageMenuCapture[action]?.();
  }, command);
  const getState = () => page.evaluate(() => window.privateBrowser.getState());

  await page.evaluate((target) => window.privateBrowser.navigate(target), url);
  const active = (await getState()).activeTabId;
  expect(await openAt(url, 'mouse')).toBe('mouse');
  await expect.poll(capture).toMatchObject({ source: 'mouse', labels: ['Open link in new tab', 'Open link in background tab', 'Copy link address'] });
  await invoke('foreground');
  const openedForeground = await getState();
  expect(openedForeground.activeTabId).not.toBe(active);
  expect(openedForeground.tabs.filter((tab) => tab.url === origin + '/background-menu')).toHaveLength(1);
  await page.evaluate((tabId) => window.privateBrowser.activateTab(tabId), active);
  await invoke('open');
  const opened = await getState();
  expect(opened.activeTabId).toBe(active);
  const openedLinks = opened.tabs.filter((tab) => tab.url === origin + '/background-menu');
  expect(openedLinks).toHaveLength(2);
  expect(openedLinks.every((tab) => tab.accountSpaceId === opened.activeAccountSpaceId)).toBe(true);

  expect(await openAt(url, 'keyboard')).toBe('keyboard');
  await expect.poll(capture).toMatchObject({ source: 'keyboard', labels: ['Copy selected text', 'Paste'] });
  await invoke('copy');
  expect((await capture()).copies).toBe(1);

  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  const bankingUrl = origin + '/private-space-fixture';
  await page.evaluate((target) => window.privateBrowser.navigate(target), bankingUrl);
  const before = (await capture()).calls;
  expect(await openAt(bankingUrl, 'mouse')).toBe('mouse');
  await invoke('open');
  expect((await capture()).calls).toBe(before);
  expect((await getState()).tabs.filter((tab) => tab.url === origin + '/background-menu')).toHaveLength(0);
  await page.evaluate((workspaceId) => window.privateBrowser.switchWorkspace(workspaceId), opened.activeWorkspaceId);
  expect((await getState()).tabs.filter((tab) => tab.url === origin + '/background-menu')).toHaveLength(2);
});

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
  const workspace = await page.evaluate(() => window.privateBrowser.getState().then((state) => state.activeWorkspaceId));
  await expect.poll(async () => application!.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL() === url), `${origin}/source`)).toBe(true);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).activeWorkspaceId).toBe('banking');

  for (let index = 0; index < 8; index += 1) await openFromPage(`${origin}/source`, `${origin}/background-${index}`);
  const banking = await page.evaluate(() => window.privateBrowser.getState());
  expect(banking.activeWorkspaceId).toBe('banking');
  expect(banking.tabs.some((tab) => tab.url.startsWith(`${origin}/background-`))).toBe(false);
  expect(banking.privacyLog.some((event) => event.title === 'Popups blocked')).toBe(false);
  await page.evaluate((id) => window.privateBrowser.switchWorkspace(id), workspace);
  const original = await page.evaluate(() => window.privateBrowser.getState());
  expect(original.tabs.filter((tab) => tab.url.startsWith(`${origin}/background-`))).toHaveLength(5);
  expect(original.privacyLog.some((event) => event.title === 'Popups blocked')).toBe(true);
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

// F-54: the partition-isolation spec builds its own sessions; this one checks
// the sessions the app itself gives two Account Spaces' page views.
test("two Account Spaces' own page views do not share cookies or storage", async () => {
  const page = await application!.firstWindow();
  const origin = `http://127.0.0.1:${port}`;
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await page.evaluate((target) => window.privateBrowser.navigate(target), `${origin}/first-account`);
  const contentsFor = (url: string) => application!.evaluate(async ({ webContents }, value) => {
    const contents = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed() && candidate.getURL() === value);
    return contents ? { storage: contents.session.getStoragePath(), id: contents.id } : null;
  }, url);
  await expect.poll(() => contentsFor(`${origin}/first-account`)).not.toBeNull();
  await application!.evaluate(async ({ webContents }, value) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === value)!;
    await contents.executeJavaScript(`document.cookie = 'space=first; path=/'; localStorage.setItem('space', 'first'); true`);
  }, `${origin}/first-account`);

  await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Second', 'emerald'));
  await page.evaluate((target) => window.privateBrowser.navigate(target), `${origin}/second-account`);
  await expect.poll(() => contentsFor(`${origin}/second-account`)).not.toBeNull();

  const first = (await contentsFor(`${origin}/first-account`))!;
  const second = (await contentsFor(`${origin}/second-account`))!;
  expect(first.storage).toBeTruthy();
  expect(second.storage).not.toBe(first.storage);
  const seen = await application!.evaluate(async ({ webContents }, value) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === value)!;
    return contents.executeJavaScript(`({ cookie: document.cookie, stored: localStorage.getItem('space') })`) as Promise<{ cookie: string; stored: string | null }>;
  }, `${origin}/second-account`);
  expect(seen).toEqual({ cookie: '', stored: null });
});
