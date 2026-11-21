import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type Page } from '@playwright/test';

/**
 * The search engine, Home page and startup settings in the real app: the main
 * process builds the search URL, resolves Home (never a web page in Banking) and
 * adds the Home tab at launch without closing the restored ones.
 */

let server: Server;
let origin = '';
let spkiHash = '';
let certificateDirectory = '';

test.beforeAll(async () => {
  certificateDirectory = mkdtempSync(join(tmpdir(), 'private-browser-settings-cert-'));
  const keyPath = join(certificateDirectory, 'key.pem');
  const certPath = join(certificateDirectory, 'cert.pem');
  const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=settings.example.test', '-addext', 'subjectAltName=DNS:settings.example.test', '-days', '1'], { encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(`Could not create the HTTPS fixture certificate: ${generated.stderr}`);
  const cert = readFileSync(certPath);
  spkiHash = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  server = createServer({ key: readFileSync(keyPath), cert }, (request, response) => {
    const url = new URL(request.url ?? '/', 'https://settings.example.test');
    const title = url.pathname === '/search' ? `Results for ${url.searchParams.get('q')}` : 'Settings home fixture';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${title.replace(/[<>&]/g, '')}</title><body>${title.replace(/[<>&]/g, '')}</body>`);
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  origin = `https://settings.example.test:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((done) => server.close(done));
  rmSync(certificateDirectory, { recursive: true, force: true });
});

function environment(userData: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.PRIVATE_BROWSER_E2E_USER_DATA = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function launchArguments(): string[] {
  return [resolve('dist-electron/main.js'), '--host-resolver-rules=MAP settings.example.test 127.0.0.1', '--no-proxy-server', `--ignore-certificate-errors-spki-list=${spkiHash}`];
}

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menu', { name: 'Browser menu' }).getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await expect(panel.getByText('Search engine', { exact: true })).toBeVisible();
  return panel;
}

test('New Tab shortcut order and the recent-visit preference survive a restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'private-browser-ntp-'));
  let app = await electron.launch({ args: launchArguments(), env: environment(userData) });
  try {
    let page = await app.firstWindow();
    await page.evaluate(async (fixture) => {
      const api = window.privateBrowser;
      const { activeAccountSpaceId } = await api.getState();
      await api.navigate(fixture + '/shortcut');
      await api.setShortcutTiles(activeAccountSpaceId, [
        { id: 'second', title: 'Second', url: fixture + '/second' },
        { id: 'first', title: 'First', url: fixture + '/shortcut' },
      ]);
      await api.setUiPreferences({ showRecentOnNewTab: false });
      await api.newTab();
    }, origin);

    await app.close();
    app = await electron.launch({ args: launchArguments(), env: environment(userData) });
    page = await app.firstWindow();
    const newTab = page.getByRole('main', { name: 'New Tab' });
    const shortcuts = newTab.getByRole('region', { name: 'Shortcuts' });
    await expect(shortcuts.getByRole('button', { name: /Edit shortcut/ }).first()).toHaveAccessibleName('Edit shortcut Second');
    await expect(shortcuts.getByRole('button', { name: 'First', exact: true })).toBeVisible();
    await expect(newTab.getByRole('heading', { name: 'Recently visited' })).toHaveCount(0);
    await newTab.getByRole('button', { name: 'Customize' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Show recently visited pages' }).click();
    await expect(newTab.getByRole('heading', { name: 'Recently visited' })).toBeVisible();
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true, maxRetries: 4 });
  }
});

test('keeps Home, site keywords and startup pages in the chosen workspace after restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'private-browser-workspace-settings-'));
  let app = await electron.launch({ args: launchArguments(), env: environment(userData) });
  try {
    let page = await app.firstWindow();
    const before = await page.evaluate(async (url) => {
      const api = window.privateBrowser;
      await api.switchWorkspace('personal');
      await api.setBrowserSettings({ homePage: 'url', homePageUrl: url + '/personal' }, 'personal');
      await api.setBrowserSettings({ startup: 'pages', startupPages: [url + '/one', url + '/two'], siteKeywords: [
        { keyword: 'gh', template: url + '/search?q=%s' },
      ] }, 'personal');
      await api.goHome();
      return api.getState();
    }, origin);
    expect(before.tabs.find((tab) => tab.id === before.activeTabId)?.url).toBe(origin + '/personal');
    await page.evaluate(() => window.privateBrowser.navigate('gh daily tabs'));
    await expect(page.getByRole('tab', { name: 'Results for daily tabs' })).toBeVisible();
    await page.evaluate(async (url) => {
      const api = window.privateBrowser;
      await api.switchWorkspace('tenten');
      await api.setBrowserSettings({ homePage: 'url', homePageUrl: url + '/tenten' }, 'tenten');
      await api.goHome();
    }, origin);
    await expect(page.evaluate(() => window.privateBrowser.setBrowserSettings({ startup: 'home' }, 'personal'))).rejects.toThrow(/workspace changed/i);
    await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then((state) =>
      state.tabs.find((tab) => tab.id === state.activeTabId)?.url))).toBe(origin + '/tenten');
    const restored = await page.evaluate(async (url) => {
      const api = window.privateBrowser;
      await api.switchWorkspace('personal');
      await api.navigate(url + '/one');
      return api.getState();
    }, origin);
    expect(restored.tabs.filter((tab) => tab.accountSpaceId === restored.activeAccountSpaceId && tab.url === origin + '/one')).toHaveLength(1);
    expect(restored.tabs.some((tab) => tab.accountSpaceId === restored.activeAccountSpaceId && tab.url === origin + '/two')).toBe(false);
    await app.close();
    app = await electron.launch({ args: launchArguments(), env: environment(userData) });
    page = await app.firstWindow();
    await expect.poll(() => page.evaluate(async (url) => {
      const state = await window.privateBrowser.getState();
      return state.tabs.some((tab) => tab.accountSpaceId === state.activeAccountSpaceId && tab.url === url + '/two');
    }, origin)).toBe(true);
    const after = await page.evaluate(() => window.privateBrowser.getState());
    expect(after.activeTabId).toBe(restored.activeTabId);
    expect(after.tabs.filter((tab) => tab.accountSpaceId === after.activeAccountSpaceId && tab.url === origin + '/one')).toHaveLength(1);
    await page.evaluate(() => window.privateBrowser.switchWorkspace('tenten'));
    const tenten = await page.evaluate(() => window.privateBrowser.getState());
    expect(tenten.tabs.some((tab) => tab.url === origin + '/two')).toBe(false);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true, maxRetries: 4 });
  }
});

test('search engine, Home page and startup settings work in the real app and survive a restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'private-browser-settings-'));
  let app = await electron.launch({ args: launchArguments(), env: environment(userData) });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Private Browser' })).toBeVisible();
    const address = () => page.getByRole('combobox', { name: 'Address and search bar' });
    const tabs = () => page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab');

    // A custom template is refused over plain HTTP, then accepted over HTTPS and used for typed text.
    let panel = await openSettings(page);
    await panel.getByLabel('Search engine').selectOption('custom');
    const custom = panel.getByRole('textbox', { name: 'Custom search address' });
    await custom.fill(`${origin.replace('https:', 'http:')}/search?q=%s`);
    await panel.getByRole('button', { name: 'Save search address' }).click();
    await expect(page.getByRole('status')).toContainText('https://');
    await custom.fill(`${origin}/search?q=%s`);
    await panel.getByRole('button', { name: 'Save search address' }).click();
    await expect(page.getByRole('status')).toContainText('Search engine saved');
    await address().fill('hello world');
    await address().press('Enter');
    await expect(page.getByRole('tab', { name: /Results for hello world/ })).toBeVisible();
    await expect(address()).toHaveValue(`${origin}/search?q=hello%20world`);

    // Home goes to the chosen address, from the button and from Alt+Home.
    const home = panel.getByRole('radiogroup', { name: 'Home page' });
    await home.getByRole('radio', { name: 'Web address' }).click();
    await panel.getByRole('textbox', { name: 'Home page address' }).fill(`${origin}/home`);
    await panel.getByRole('button', { name: 'Save Home page' }).click();
    await expect(page.getByRole('status')).toContainText('Home page saved');
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(address()).toHaveValue(`${origin}/home`);
    await expect(page.getByRole('tab', { name: /Settings home fixture/ })).toBeVisible();
    await address().fill('private://home');
    await address().press('Enter');
    await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();
    await address().press('Alt+Home');
    await expect(address()).toHaveValue(`${origin}/home`);

    // Ctrl+T still opens the New Tab page, not the Home address.
    await address().press('Control+t');
    await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();

    const startup = panel.getByRole('radiogroup', { name: 'On startup' });
    await startup.getByRole('radio', { name: 'Also open Home page' }).click();
    await expect(startup.getByRole('radio', { name: 'Also open Home page' })).toHaveAttribute('aria-checked', 'true');
    const before = await tabs().count();

    await app.close();
    app = await electron.launch({ args: launchArguments(), env: environment(userData) });
    page = await app.firstWindow();
    // Every restored tab is kept and exactly one Home tab is added and active.
    await expect(tabs()).toHaveCount(before + 1);
    await expect(address()).toHaveValue(`${origin}/home`);
    panel = await openSettings(page);
    await expect(panel.getByLabel('Search engine')).toHaveValue('custom');
    await expect(panel.getByRole('textbox', { name: 'Custom search address' })).toHaveValue(`${origin}/search?q=%s`);
    await expect(panel.getByRole('textbox', { name: 'Home page address' })).toHaveValue(`${origin}/home`);

    // Banking never opens a web page for Home.
    await page.getByRole('button', { name: /^Account Space: / }).click();
    await page.getByRole('menu', { name: 'Account Spaces' }).getByRole('menuitemradio', { name: 'Switch to Banking' }).click();
    await expect(page.getByRole('button', { name: /^Account Space: .*Bank/ })).toBeVisible();
    await address().fill(`${origin}/elsewhere`);
    await address().press('Enter');
    await expect(address()).toHaveValue(`${origin}/elsewhere`);
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();
  } finally {
    await app.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('opens the reviewed reference only for the current Account Space and saved URL', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'private-browser-reference-search-'));
  const app = await electron.launch({ args: launchArguments(), env: environment(userData) });
  try {
    const page = await app.firstWindow();
    const input = await page.evaluate(async (origin) => {
      const api = window.privateBrowser;
      const { activeAccountSpaceId: accountSpaceId } = await api.getState();
      await api.setBrowserSettings({ siteKeywords: [{ keyword: 'stock', template: origin + '/search?q=%s' }] });
      return { accountSpaceId, keyword: 'stock', reference: 'LX 34', reviewedUrl: origin + '/search?q=LX%2034' };
    }, origin);
    const open = (decision = input) => page.evaluate((value) => window.privateBrowser.openReferenceSearch(value), decision);
    await expect(open({ ...input, reviewedUrl: origin + '/other?q=LX%2034' })).rejects.toThrow(/Review the current search address/);
    await open();
    await expect(page.getByRole('tab', { name: 'Results for LX 34' })).toBeVisible();
    await page.evaluate((origin) => window.privateBrowser.setBrowserSettings({
      siteKeywords: [{ keyword: 'stock', template: origin + '/search?q=%s&country=ma' }],
    }), origin);
    await expect(open()).rejects.toThrow(/Review the current search address/);
    const workspace = await page.evaluate(() => window.privateBrowser.getState().then((state) => state.activeWorkspaceId));
    await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
    await expect(open()).rejects.toThrow(/original regular Account Space/);
    const banking = await page.evaluate(() => window.privateBrowser.getState());
    expect(banking.tabs.some((tab) => tab.url === input.reviewedUrl)).toBe(false);
    await page.evaluate((id) => window.privateBrowser.switchWorkspace(id), workspace);
    const state = await page.evaluate(() => window.privateBrowser.getState());
    expect(state.tabs.filter((tab) => tab.url === input.reviewedUrl).map((tab) => tab.accountSpaceId)).toEqual([input.accountSpaceId]);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true, maxRetries: 4 });
  }
});
