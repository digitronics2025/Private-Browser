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

test('bookmark batches reuse tabs only in the active Account Space', async () => {
  const page = await application!.firstWindow();
  const read = () => page.evaluate(() => window.privateBrowser.getState());
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  const account = (await read()).activeAccountSpaceId;
  await page.evaluate((url) => window.privateBrowser.navigate(url), origin + '/fresh');
  await page.evaluate(() => window.privateBrowser.toggleBookmark());
  await page.evaluate((url) => window.privateBrowser.navigate(url), origin + '/already');
  await page.evaluate(() => window.privateBrowser.toggleBookmark());
  const before = await read();
  const ids = before.bookmarks.filter((bookmark) => bookmark.accountSpaceId === account).map((item) => item.id);
  expect(ids).toHaveLength(2);

  const open = () => page.evaluate(({ account, ids }) => window.privateBrowser.openBookmarksInBackground(account, ids), { account, ids });
  await expect(open()).resolves.toEqual({ opened: 1, reused: 1, skipped: 0 });
  const after = await read();
  expect(after.activeTabId).toBe(before.activeTabId);
  expect(after.tabs.filter((tab) => tab.url === origin + '/fresh')).toMatchObject([{ accountSpaceId: account }]);
  await expect(open()).resolves.toEqual({ opened: 0, reused: 2, skipped: 0 });

  await page.evaluate(() => window.privateBrowser.switchWorkspace('digitronics'));
  await expect(open()).rejects.toThrow(/Account Space changed/);
  const other = (await read()).activeAccountSpaceId;
  const scoped = await page.evaluate(({ other, ids }) => window.privateBrowser.openBookmarksInBackground(other, ids), { other, ids });
  expect(scoped).toEqual({ opened: 0, reused: 0, skipped: 2 });
});

test('bookmark edits and undo stay in the owner’s space and preserve intervening edits', async () => {
  const page = await application!.firstWindow();
  const read = () => page.evaluate(() => window.privateBrowser.getState());
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  const account = (await read()).activeAccountSpaceId;
  for (const route of ['/first', '/second']) {
    await page.evaluate((url) => window.privateBrowser.navigate(url), origin + route);
    await page.evaluate(() => window.privateBrowser.toggleBookmark());
  }
  const original = (await read()).bookmarks.filter((bookmark) => bookmark.accountSpaceId === account);
  const ids = original.map((bookmark) => bookmark.id);
  expect(ids).toHaveLength(2);
  const edit = (address: string) => page.evaluate(({ id, address }) => window.privateBrowser.editBookmarkAddress(id, address), { id: ids[0], address });
  const change = (operation: 'move' | 'delete') => page.evaluate(({ account, ids, operation }) =>
    window.privateBrowser.changeBookmarks(account, ids, operation === 'move' ? { location: 'other', path: [] } : undefined), { account, ids, operation });
  const undo = () => page.evaluate((id) => window.privateBrowser.undoBookmarks(id), account);
  await expect(change('move')).resolves.toBe(2);
  await edit(origin + '/edited');
  await expect(undo()).resolves.toBe(2);
  expect((await read()).bookmarks.find((bookmark) => bookmark.id === ids[0])).toMatchObject({ url: origin + '/edited', location: 'bar' });
  await expect(edit('file:///C:/fixture.txt')).rejects.toThrow(/HTTP or HTTPS/);
  await expect(change('delete')).resolves.toBe(2);
  expect((await read()).bookmarks.filter((bookmark) => bookmark.accountSpaceId === account)).toHaveLength(0);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('digitronics'));
  expect((await read()).bookmarkUndo).toBeUndefined();
  await expect(undo()).rejects.toThrow(/Account Space changed/);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await expect(undo()).resolves.toBe(2);
  expect((await read()).bookmarks.filter((bookmark) => bookmark.accountSpaceId === account)).toMatchObject([
    expect.objectContaining({ id: ids[0], url: origin + '/edited' }), expect.objectContaining({ id: ids[1] }),
  ]);
});

test('a bookmark keeps the icon of a site after its tab closes and across a restart', async () => {
  let page = await application!.firstWindow();
  const state = await page.evaluate(() => window.privateBrowser.getState());
  await page.evaluate(
    // No ERR_ABORTED allowance: the double-load race that produced it was fixed
    // (3c60646), so seeing it again is a regression, not noise.
    ({ accountSpaceId, target }) => window.privateBrowser.openInAccountSpace(accountSpaceId, target),
    { accountSpaceId: state.activeAccountSpaceId, target: `${origin}/` },
  );
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.find((tab) => tab.url.startsWith(origin))?.favicon).toMatch(/^data:image\/png;base64,/);

  await page.getByRole('button', { name: 'Bookmark this tab', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Bookmark this tab in a folder' });
  await dialog.getByLabel('Name', { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Save bookmark' }).click();
  await expect(dialog).toBeHidden();
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
  await expect(page.getByRole('navigation', { name: 'Bookmarks bar' }).getByRole('button', { name: '127.0.0.1', exact: true })).toHaveText('');
  // Showing a remembered icon must never contact the site.
  expect(iconRequests).toBe(requestsBeforeRestart);
});
