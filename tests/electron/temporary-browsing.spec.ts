import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('isolates guest data, keeps only an approved bookmark, and starts clean after a native exit', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'private-browser-temporary-'));
  const server = createServer((request, response) => {
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="sample.txt"' });
      response.end('sample');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Temporary reference</title><p>Local fixture</p>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bound = server.address();
  if (!bound || typeof bound === 'string') throw new Error('Temporary browsing fixture did not bind to TCP.');
  const base = `http://127.0.0.1:${bound.port}`;
  const destination = base + '/temporary-reference';
  const pageUrl = destination + '?local=fixture-volatile#sample';
  let application: ElectronApplication | undefined;
  const launch = () => {
    const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    return electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${profile}`], env });
  };
  const open = async (chrome: Page) => {
    await chrome.getByRole('button', { name: 'Browser menu', exact: true }).click();
    await chrome.getByRole('menuitem', { name: 'New temporary browsing window', exact: true }).click();
    const findGuest = () => application!.windows().find((window) => window.url().startsWith('data:text/html;charset=utf-8,'));
    await expect.poll(() => Boolean(findGuest())).toBe(true);
    const guest = findGuest()!;
    await expect(guest.getByRole('heading', { name: 'Temporary browsing' })).toBeVisible();
    return guest;
  };
  const visit = async (guest: Page, url: string) => {
    const input = guest.getByRole('textbox', { name: 'Address' });
    await input.fill(url);
    await input.press('Enter');
    await expect(input).toHaveValue(url);
    await expect.poll(() => application!.evaluate(({ webContents }, target) => webContents.getAllWebContents()
      .some((contents) => contents.getURL() === target && !contents.isLoading()), url)).toBe(true);
  };
  const guestState = (store: boolean) => application!.evaluate(async ({ webContents }, { url, store }) => {
    const contents = webContents.getAllWebContents().find((view) => view.getURL() === url)!;
    const state = await contents.executeJavaScript(store
      ? `document.cookie = 'guest_fixture=present'; localStorage.setItem('fixture', 'present'); ({ cookie: document.cookie, local: localStorage.getItem('fixture'), node: typeof require, bridge: typeof temporaryChrome })`
      : `({ cookie: document.cookie, local: localStorage.getItem('fixture'), node: typeof require, bridge: typeof temporaryChrome })`);
    return { ...state, persistent: contents.session.isPersistent() };
  }, { url: pageUrl, store });

  try {
    application = await launch();
    let chrome = await application.firstWindow();
    await chrome.evaluate((url) => window.privateBrowser.navigate(url), base + '/regular');
    await application.evaluate(async ({ webContents }, url) => {
      const regular = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
      await regular.session.cookies.set({ url, name: 'regular_fixture', value: 'present' });
    }, base + '/regular');

    let guest = await open(chrome);
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => window.getTitle().startsWith('Temporary browsing'))!.setContentSize(530, 580);
    });
    await expect.poll(() => guest.evaluate(() => document.documentElement.scrollWidth === innerWidth)).toBe(true);
    await visit(guest, pageUrl);
    expect(await guestState(false)).toEqual({ cookie: '', local: null, node: 'undefined', bridge: 'undefined', persistent: false });
    expect(await guestState(true)).toMatchObject({ cookie: 'guest_fixture=present', local: 'present' });
    const state = () => chrome.evaluate(() => window.privateBrowser.getState());
    expect((await state()).history.some((item) => item.url.startsWith(destination))).toBe(false);
    expect((await state()).bookmarks.some((item) => item.url.startsWith(destination))).toBe(false);

    await application.evaluate(({ webContents }, { url, download }) => {
      webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.downloadURL(download);
    }, { url: pageUrl, download: base + '/download' });
    await expect(guest.getByRole('status')).toContainText('Downloads are blocked');
    await application.evaluate(({ dialog }) => {
      const show = dialog.showMessageBox;
      dialog.showMessageBox = async (windowOrOptions: Electron.BaseWindow | Electron.MessageBoxOptions, details?: Electron.MessageBoxOptions) => {
        dialog.showMessageBox = show;
        const options = details ?? windowOrOptions as Electron.MessageBoxOptions;
        if (options.message !== 'Keep this bookmark?' || options.detail?.includes('fixture-volatile')) throw new Error('Bookmark review changed.');
        return { response: 1, checkboxChecked: false };
      };
    });
    await guest.getByRole('button', { name: 'Keep bookmark', exact: true }).click();
    await expect(guest.getByRole('status')).toContainText('Bookmark saved');
    expect((await state()).bookmarks.filter((item) => item.url.startsWith(destination)).map((item) => item.url)).toEqual([destination]);

    await guest.getByRole('button', { name: 'Close window' }).click();
    await expect.poll(() => guest.isClosed()).toBe(true);
    guest = await open(chrome);
    await visit(guest, pageUrl);
    expect(await guestState(false)).toMatchObject({ cookie: '', local: null, persistent: false });
    await guestState(true);

    // Terminate the app without closing the temporary view through its toolbar.
    await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await application.close().catch(() => undefined);
    application = await launch();
    chrome = await application.firstWindow();
    expect(application.windows()).toHaveLength(1);
    expect((await state()).bookmarks.filter((item) => item.url.startsWith(destination)).map((item) => item.url)).toEqual([destination]);
    expect((await state()).history.some((item) => item.url.startsWith(destination))).toBe(false);
    expect(readdirSync(profile).some((entry) => entry.startsWith('temporary-page-'))).toBe(false);
    guest = await open(chrome);
    await visit(guest, pageUrl);
    expect(await guestState(false)).toMatchObject({ cookie: '', local: null, persistent: false });
    await chrome.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
    await expect.poll(() => guest.isClosed()).toBe(true);
    await expect(chrome.evaluate(async () => window.privateBrowser.openTemporaryBrowsing((await window.privateBrowser.getState()).activeAccountSpaceId)))
      .rejects.toThrow(/unlocked regular Account Space/);
  } finally {
    await application?.close().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(profile, { recursive: true, force: true, maxRetries: 4 });
  }
});
