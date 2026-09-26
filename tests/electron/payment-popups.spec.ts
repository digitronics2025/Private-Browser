import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let application: ElectronApplication | undefined;
let userDataPath: string;
let origin: string;
let server: Server;

// A checkout page and a wallet popup that reports back to its opener, the way
// Google Pay does. Without `window.opener` it fails with OR_BIBED_15.
const PAGES: Record<string, string> = {
  '/checkout': `<!doctype html><title>Checkout</title><script>
    window.received = [];
    addEventListener('message', (event) => window.received.push(event.data));
  </script>`,
  '/wallet': `<!doctype html><title>Wallet</title><script>
    if (window.opener) window.opener.postMessage('wallet-ready', '*');
  </script>`,
};

test.beforeEach(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(PAGES[new URL(request.url ?? '/', 'http://localhost').pathname] ?? '<!doctype html><title>Other</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP');
  origin = `http://127.0.0.1:${address.port}`;
  userDataPath = mkdtempSync(join(tmpdir(), 'private-browser-popups-'));
  const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userDataPath}`], env });
});

test.afterEach(async () => {
  await application?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(userDataPath, { recursive: true, force: true });
});

const windowCount = () => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

async function openCheckout(workspace: 'personal' | 'banking') {
  const page = await application!.firstWindow();
  await page.evaluate((id) => window.privateBrowser.switchWorkspace(id), workspace);
  await page.evaluate((target) => window.privateBrowser.navigate(target), `${origin}/checkout`);
  await expect.poll(() => application!.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((contents) => contents.getURL() === url), `${origin}/checkout`)).toBe(true);
  await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
  return page;
}

function runInCheckout<T>(script: string): Promise<T> {
  return application!.evaluate(async ({ webContents }, { url, code }) => {
    const checkout = webContents.getAllWebContents().find((contents) => !contents.isDestroyed() && contents.getURL() === url)!;
    return checkout.executeJavaScript(code, true);
  }, { url: `${origin}/checkout`, code: script }) as Promise<T>;
}

test('a payment popup opens as a real window that can talk to the checkout page', async () => {
  const page = await openCheckout('personal');
  const windowsBefore = await windowCount();

  expect(await runInCheckout<boolean>(`window.wallet = window.open('/wallet', 'wallet', 'popup,width=420,height=560'); Boolean(window.wallet)`)).toBe(true);
  await expect.poll(windowCount).toBe(windowsBefore + 1);
  await expect.poll(() => runInCheckout<string[]>('window.received')).toEqual(['wallet-ready']);

  // Same Account Space session, hardened, and titled with its host.
  const popup = await application!.evaluate(async ({ BrowserWindow, webContents }, url) => {
    const checkout = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    const child = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/wallet'))!;
    return {
      sameSession: child.webContents.session === checkout.session,
      title: child.getTitle(),
      pageReach: await child.webContents.executeJavaScript(`[typeof require, typeof process, typeof window.privateBrowser].join()`),
    };
  }, `${origin}/checkout`);
  expect(popup).toEqual({ sameSession: true, title: `${new URL(origin).host} — Wallet`, pageReach: 'undefined,undefined,undefined' });

  // The popup is not a tab, and a plain window.open still is.
  const tabs = (await page.evaluate(() => window.privateBrowser.getState())).tabs;
  expect(tabs.some((tab) => tab.url.endsWith('/wallet'))).toBe(false);

  // A popup cannot walk itself off the web.
  await application!.evaluate(async ({ BrowserWindow }) => {
    const child = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/wallet'))!;
    await child.webContents.executeJavaScript(`location.href = 'file:///C:/Windows/win.ini'; true`);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.webContents.getURL().startsWith('file:') && window.webContents.getURL().includes('win.ini')))).toBe(false);

  // Closing the tab closes its popup.
  const checkoutTab = tabs.find((tab) => tab.url === `${origin}/checkout`)!;
  await page.evaluate((id) => window.privateBrowser.closeTab(id), checkoutTab.id);
  await expect.poll(windowCount).toBe(windowsBefore);
});

test('Banking still refuses payment popups', async () => {
  await openCheckout('banking');
  const windowsBefore = await windowCount();
  expect(await runInCheckout<boolean>(`Boolean(window.open('/wallet', 'wallet', 'popup,width=420,height=560'))`)).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await windowCount()).toBe(windowsBefore);
});
