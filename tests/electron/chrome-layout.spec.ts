import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * Proves the real WebContentsView sits exactly under the visible chrome and
 * beside the visible side panel — the property the whole layout module exists
 * for — across bookmark bar, side panel, resize, maximize, full screen, menus
 * and permission prompts.
 */

let server: Server;
let origin = '';
let spkiHash = '';
let certificateDirectory = '';

// HTTPS, because permission prompts are only ever offered to exact HTTPS origins.
test.beforeAll(async () => {
  certificateDirectory = mkdtempSync(join(tmpdir(), 'private-browser-layout-cert-'));
  const keyPath = join(certificateDirectory, 'key.pem');
  const certPath = join(certificateDirectory, 'cert.pem');
  const openssl = process.platform === 'win32' ? 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe' : 'openssl';
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=layout.example.test', '-addext', 'subjectAltName=DNS:layout.example.test', '-days', '1'], { encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(`Could not create the HTTPS fixture certificate: ${generated.stderr}`);
  const cert = readFileSync(certPath);
  spkiHash = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  server = createServer({ key: readFileSync(keyPath), cert }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Layout fixture</title><body style="margin:0;background:#22c55e;font:20px system-ui">Layout fixture</body>');
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  origin = `https://layout.example.test:${(server.address() as AddressInfo).port}`;
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
  return [resolve('dist-electron/main.js'), '--host-resolver-rules=MAP layout.example.test 127.0.0.1', '--no-proxy-server', `--ignore-certificate-errors-spki-list=${spkiHash}`];
}

async function measure(app: ElectronApplication, page: Page) {
  const native = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => /index\.html|127\.0\.0\.1:5173/.test(candidate.webContents.getURL()))!;
    const [width, height] = window.getContentSize();
    const views = window.contentView.children.filter((view) => view.getVisible()).map((view) => view.getBounds());
    return { width, height, views, fullscreen: window.isFullScreen() };
  });
  const chrome = await page.evaluate(() => ({
    bottom: Math.round(Math.max(0, ...['.tab-strip', '.toolbar', '.bookmark-bar', '.find-bar'].map((selector) => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0))),
    panel: Math.round(document.querySelector('.side-panel-shell')?.getBoundingClientRect().width ?? 0),
  }));
  return { native, chrome };
}

async function expectPageAligned(app: ElectronApplication, page: Page) {
  await expect.poll(async () => {
    const { native, chrome } = await measure(app, page);
    const view = native.views[0];
    if (native.views.length !== 1 || !view) return `visible views: ${native.views.length}`;
    const expected = { x: 0, y: chrome.bottom, width: native.width - chrome.panel, height: native.height - chrome.bottom };
    return JSON.stringify(view) === JSON.stringify(expected) ? 'aligned' : `${JSON.stringify(view)} != ${JSON.stringify(expected)}`;
  }, { timeout: 8_000 }).toBe('aligned');
}

test('the page view follows the chrome through every layout change', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'private-browser-layout-'));
  let app = await electron.launch({ args: launchArguments(), env: environment(userData) });
  try {
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Private Browser' })).toBeVisible();
    const tabs = page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab');
    await expect(tabs).toHaveCount(1);
    await page.keyboard.press('Control+T');
    await expect(tabs).toHaveCount(2);
    await page.keyboard.press('Control+W');
    await expect(tabs).toHaveCount(1);
    await page.evaluate((url) => window.privateBrowser.navigate(url), `${origin}/`);
    await expect(page.getByRole('tab', { name: /Layout fixture/ })).toBeVisible();
    await expectPageAligned(app, page);
    // A shortcut pressed while the page itself has focus reaches the same dispatcher.
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.getVisible()) as Electron.WebContentsView;
      view.webContents.focus();
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] });
    });
    await expect(page.getByRole('textbox', { name: 'Address and search bar' })).toBeFocused();

    await page.evaluate(() => window.privateBrowser.toggleBookmarkBar());
    await expect(page.getByRole('navigation', { name: 'Bookmarks bar' })).toHaveCount(0);
    await expectPageAligned(app, page);

    await page.getByRole('button', { name: 'Side panel', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Side panel' })).toBeVisible();
    await expectPageAligned(app, page);

    await page.evaluate(() => window.privateBrowser.setUiPreferences({ sidePanelWidth: 480, sidePanelTool: 'privacy' }));
    await expectPageAligned(app, page);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1366, 768));
    await expectPageAligned(app, page);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized())).toBe(true);
    await expectPageAligned(app, page);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize());
    await expectPageAligned(app, page);

    await page.evaluate(() => window.privateBrowser.toggleFullscreen());
    await expect(page.locator('.tab-strip')).toHaveCount(0);
    await expect.poll(async () => {
      const { native } = await measure(app, page);
      return native.fullscreen && native.views.length === 1 && native.views[0].x === 0 && native.views[0].y === 0 && native.views[0].width === native.width && native.views[0].height === native.height;
    }, { timeout: 8_000 }).toBe(true);
    await page.evaluate(() => window.privateBrowser.toggleFullscreen());
    await expect(page.locator('.tab-strip')).toBeVisible();
    await expectPageAligned(app, page);

    // Menus draw over the page: the live view is hidden behind a still image, then restored.
    await page.getByRole('button', { name: 'Browser menu' }).click();
    await expect(page.getByRole('menu', { name: 'Browser menu' })).toBeVisible();
    await expect.poll(async () => (await measure(app, page)).native.views.length).toBe(0);
    await expect(page.locator('img.frozen-frame')).toBeVisible();
    await page.keyboard.press('Escape');
    await expectPageAligned(app, page);

    // A permission prompt hides the page until it is answered.
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.getVisible()) as Electron.WebContentsView;
      // Clipboard reading prompts on any HTTPS origin (notifications and media are limited to Google origins).
      view.webContents.focus();
      void view.webContents.executeJavaScript('navigator.clipboard.readText().catch(() => "")', true);
    });
    const prompt = page.getByRole('alertdialog');
    await expect(prompt).toBeVisible();
    await expect.poll(async () => (await measure(app, page)).native.views.length).toBe(0);
    await prompt.getByRole('button', { name: 'Deny' }).click();
    await expectPageAligned(app, page);

    await page.evaluate(() => window.privateBrowser.setUiPreferences({ theme: 'light' }));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('light');

    // Side panel choice, width and theme survive a restart.
    await app.close();
    app = await electron.launch({ args: launchArguments(), env: environment(userData) });
    page = await app.firstWindow();
    const panel = page.getByRole('complementary', { name: 'Side panel' });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('tab', { name: 'Privacy' })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => Math.round((await panel.boundingBox())?.width ?? 0)).toBe(480);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('navigation', { name: 'Bookmarks bar' })).toHaveCount(0);
  } finally {
    await app.close().catch(() => undefined);
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Ctrl+wheel zooms the page and the magnifier bubble steps and resets it', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'private-browser-zoom-'));
  const app = await electron.launch({ args: launchArguments(), env: environment(userData) });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Private Browser' })).toBeVisible();
    await page.evaluate((url) => window.privateBrowser.navigate(url), `${origin}/`);
    await expect(page.getByRole('tab', { name: /Layout fixture/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Zoom: / })).toHaveCount(0);

    // Electron reports Ctrl+wheel as zoom-changed but leaves applying it to the embedder.
    await app.evaluate(({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.getVisible()) as Electron.WebContentsView;
      view.webContents.sendInputEvent({ type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 120, wheelTicksX: 0, wheelTicksY: 1, canScroll: true, modifiers: ['control'] });
    });
    const magnifier = page.getByRole('button', { name: 'Zoom: 110%' });
    await expect(magnifier).toBeVisible();

    await magnifier.click();
    const bubble = page.getByRole('dialog', { name: 'Page zoom' });
    await bubble.getByRole('button', { name: 'Zoom in' }).click();
    await expect(bubble.getByText('Zoom: 125%')).toBeVisible();
    await bubble.getByRole('button', { name: 'Reset' }).click();
    await expect(bubble.getByText('Zoom: 100%')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /^Zoom: / })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
