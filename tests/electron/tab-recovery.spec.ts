import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let application: ElectronApplication | undefined;
let profile: string;
let server: Server;
let origin: string;
let breakPage: boolean;

async function launch(): Promise<ElectronApplication> {
  const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), '--user-data-dir=' + profile], env });
}

test.beforeEach(async () => {
  breakPage = false;
  profile = mkdtempSync(join(tmpdir(), 'private-browser-tab-recovery-'));
  server = createServer((request, response) => {
    if (request.url === '/recover' && breakPage) { request.socket.destroy(); return; }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/html');
    const title = request.url === '/recover' ? 'Recovery test page' : 'Earlier page';
    response.end('<!doctype html><title>' + title + '</title><h1>' + title + '</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fixture server did not listen');
  origin = 'http://127.0.0.1:' + address.port;
  application = await launch();
});

test.afterEach(async () => {
  await application?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(profile, { recursive: true, force: true });
});

test('offers Back after a failed load and reloads a crashed page on request', async () => {
  const page = await application!.firstWindow();
  const activeTitle = () => page.evaluate(async () => {
    const state = await window.privateBrowser.getState();
    return state.tabs.find((tab) => tab.id === state.activeTabId)?.title;
  });
  await page.evaluate((url) => window.privateBrowser.navigate(url), origin);
  await expect.poll(activeTitle).toBe('Earlier page');
  breakPage = true;
  await page.evaluate((url) => window.privateBrowser.navigate(url).catch(() => undefined), origin + '/recover');
  await expect(page.getByRole('heading', { name: 'Page could not load' })).toBeVisible();
  await page.locator('.recovery-card').getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Page could not load' })).toHaveCount(0);
  await expect.poll(activeTitle).toBe('Earlier page');
  breakPage = false;
  await page.evaluate((url) => window.privateBrowser.navigate(url), origin + '/recover');
  await application!.evaluate(({ webContents }, url) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
    if (!target) throw new Error('The fixture page view is missing');
    target.forcefullyCrashRenderer();
  }, origin + '/recover');
  await expect(page.getByRole('heading', { name: 'Page crashed' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload page' }).click();
  await expect(page.getByRole('heading', { name: 'Page crashed' })).toHaveCount(0);
  await expect.poll(activeTitle).toBe('Recovery test page');
});

test('stops repeated startup attempts and preserves a paused tab across restart', async () => {
  let page = await application!.firstWindow();
  await page.evaluate((url) => window.privateBrowser.navigate(url), origin);
  await page.evaluate((url) => window.privateBrowser.newTab(undefined, url), origin + '/recover');
  await expect(page.getByRole('tab', { name: 'Recovery test page' })).toBeVisible();
  breakPage = true;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await application!.close();
    application = await launch();
    page = await application.firstWindow();
    await expect(page.getByRole('heading', { name: 'Page could not load' })).toBeVisible();
  }
  await application!.close();
  application = await launch();
  page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: 'Choose which tabs to restore' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /startup failed/ })).not.toBeChecked();
  await page.getByRole('button', { name: 'Restore selected tabs' }).click();
  await expect(page.getByRole('tab', { name: 'Earlier page', selected: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Recovery test page' }).click();
  await expect(page.getByRole('heading', { name: 'Tab restore paused' })).toBeVisible();
  await application!.close();
  application = await launch();
  page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: 'Tab restore paused' })).toBeVisible();
  breakPage = false;
  await page.getByRole('button', { name: 'Resume tab' }).click();
  await expect(page.getByRole('heading', { name: 'Tab restore paused' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Recovery test page', selected: true })).toBeVisible();
});

test('persists pins, tab group order, and collapsed state in the owning Account Space', async () => {
  let page = await application!.firstWindow();
  const owner = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Organized tabs', 'sky'));
  const active = () => page.evaluate(() => window.privateBrowser.getState().then((state) => state.activeTabId));
  await page.evaluate((url) => window.privateBrowser.navigate(url), origin);
  const pinned = await active();
  await page.evaluate((id) => window.privateBrowser.organizeTab({ kind: 'pin', tabId: id, pinned: true }), pinned);
  await page.evaluate((url) => window.privateBrowser.newTab(undefined, url), origin + '/recover');
  const grouped = await active();
  await page.evaluate((id) => window.privateBrowser.organizeTab({ kind: 'create-group', tabId: id, name: 'Research' }), grouped);
  const group = await page.evaluate(() => window.privateBrowser.getState().then((state) => state.tabGroups![0]));
  await page.evaluate(async ({ grouped, id }) => {
    await window.privateBrowser.organizeTab({ kind: 'collapse-group', groupId: id, collapsed: true });
    await window.privateBrowser.addLocalAccountSpace('personal', 'Other account', 'indigo');
    await window.privateBrowser.organizeTab({ kind: 'pin', tabId: grouped, pinned: true }).then(
      () => { throw new Error('A tab from another Account Space could be changed'); },
      () => undefined,
    );
  }, { grouped, id: group.id });
  expect(await page.evaluate(() => window.privateBrowser.getState().then((state) => state.tabGroups))).toEqual([]);
  await page.evaluate(async ({ owner, pinned }) => {
    await window.privateBrowser.switchAccountSpace(owner);
    await window.privateBrowser.activateTab(pinned);
  }, { owner, pinned });
  await application!.close();
  application = await launch();
  page = await application.firstWindow();
  const restored = await page.evaluate(() => window.privateBrowser.getState());
  expect(restored.tabs.filter((tab) => tab.accountSpaceId === owner).map((tab) => tab.id)).toEqual([pinned, grouped]);
  expect(restored.tabs.find((tab) => tab.id === pinned)).toHaveProperty('pinned', true);
  expect(restored.tabGroups).toEqual([{ id: group.id, name: 'Research', collapsed: true }]);
  await expect(page.getByRole('button', { name: 'Research', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('tab', { name: 'Recovery test page' })).toHaveCount(0);
});

test('checks both Windows link associations and opens fixed settings and test links', async () => {
  test.skip(process.platform !== 'win32');
  const page = await application!.firstWindow();
  await application!.evaluate(({ app, shell }) => {
    const stub = { calls: [] as string[], httpsDefault: false };
    (globalThis as typeof globalThis & { defaultBrowserFixture: typeof stub }).defaultBrowserFixture = stub;
    app.isDefaultProtocolClient = (scheme) => scheme === 'http' || stub.httpsDefault;
    shell.openExternal = async (url) => { stub.calls.push(url); };
  });
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByText('Windows uses another browser for web links.')).toBeVisible();
  await page.getByRole('button', { name: 'Open Windows Default Apps' }).click();
  await application!.evaluate(() => {
    (globalThis as typeof globalThis & { defaultBrowserFixture: { httpsDefault: boolean } }).defaultBrowserFixture.httpsDefault = true;
  });
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
  await expect(page.getByText('Private Browser opens web links.')).toBeVisible();
  await page.getByRole('button', { name: 'Test with a link' }).click();
  const requests = await application!.evaluate(() =>
    (globalThis as typeof globalThis & { defaultBrowserFixture: { calls: string[] } }).defaultBrowserFixture.calls);
  expect(requests).toEqual(['ms-settings:defaultapps', 'https://example.com/']);
});

test('rejects stale bulk close selections and restores a closed group with its members', async () => {
  const page = await application!.firstWindow();
  await page.evaluate((url) => window.privateBrowser.navigate(url), origin);
  const pinned = await page.evaluate(() => window.privateBrowser.getState().then((state) => state.activeTabId));
  await page.evaluate((id) => window.privateBrowser.organizeTab({ kind: 'pin', tabId: id, pinned: true }), pinned);
  const { group, first, second } = await page.evaluate(async (url) => {
    await window.privateBrowser.newTab(undefined, url + '/recover');
    const first = (await window.privateBrowser.getState()).activeTabId;
    await window.privateBrowser.organizeTab({ kind: 'create-group', tabId: first, name: 'Review' });
    const group = (await window.privateBrowser.getState()).tabGroups![0];
    await window.privateBrowser.newTab(undefined, url + '/second');
    const second = (await window.privateBrowser.getState()).activeTabId;
    await window.privateBrowser.organizeTab({ kind: 'move-to-group', tabId: second, groupId: group.id });
    return { group, first, second };
  }, origin);
  await page.evaluate((first) => window.privateBrowser.closeTabBatch(first, 'group', [first]).then(
    () => { throw new Error('A partial confirmation closed the group'); },
    () => undefined,
  ), first);
  await page.evaluate(({ first, second }) => window.privateBrowser.closeTabBatch(first, 'group', [first, second]), { first, second });
  const closed = await page.evaluate(() => window.privateBrowser.getState());
  expect(closed.activeTabId).toBe(pinned);
  expect(closed.closedTabBatch).toEqual({ count: 2, groupName: 'Review' });
  expect(closed.tabs.some((tab) => tab.id === first || tab.id === second)).toBe(false);
  await page.evaluate(() => window.privateBrowser.undoTabBatch());
  const restored = await page.evaluate(() => window.privateBrowser.getState());
  expect(restored.activeTabId).toBe(pinned);
  expect(restored.tabGroups).toEqual([group]);
  expect(restored.tabs.filter((tab) => [first, second].includes(tab.id)).map((tab) => tab.groupId)).toEqual([group.id, group.id]);
});
