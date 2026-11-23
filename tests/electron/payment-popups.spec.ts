import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let application: ElectronApplication | undefined;
let userDataPath: string;
let origin: string;
let server: Server;
let walletRequests: number;

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
  '/blank-result': `<!doctype html><title>Verification result</title><script>
    if (window.opener) window.opener.postMessage('verification-result', location.origin);
  </script>`,
};

test.beforeEach(async () => {
  walletRequests = 0;
  server = createServer((request, response) => {
    if (request.url === '/wallet') walletRequests++;
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

async function popupPrompt() {
  const page = await application!.firstWindow();
  return {
    state: () => page.evaluate(async () => (await window.privateBrowser.getState()).pendingPermission),
    answer: async (decision: 'allow-once' | 'deny' | 'allow-always') => page.getByRole('button', {
      name: decision === 'allow-once' ? 'Allow once' : decision === 'allow-always' ? 'Always allow for this site' : 'Block',
    }).click(),
  };
}

test('a payment popup opens as a real window that can talk to the checkout page', async () => {
  const page = await openCheckout('personal');
  const checkoutId = await page.evaluate(async () => {
    const { activeTabId } = await window.privateBrowser.getState();
    await window.privateBrowser.newTab();
    await window.privateBrowser.activateTab(activeTabId);
    return activeTabId;
  });
  const windowsBefore = await windowCount();
  const prompt = await popupPrompt();

  expect(await runInCheckout<boolean>(`window.wallet = window.open('/wallet', 'wallet', 'popup,width=420,height=560'); Boolean(window.wallet)`)).toBe(true);
  await expect.poll(windowCount).toBe(windowsBefore + 1);
  await expect.poll(prompt.state).toMatchObject({ capability: 'popups', origin, popupDestination: origin, popupMethod: 'GET' });
  await expect(page.getByText('Initial destination:', { exact: false })).toBeVisible();
  expect(walletRequests).toBe(0);
  expect(await runInCheckout<string[]>('window.received')).toEqual([]);
  await prompt.answer('allow-once');
  await expect.poll(() => runInCheckout<string[]>('window.received')).toEqual(['wallet-ready']);
  expect(walletRequests).toBe(1);

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
  await page.evaluate((id) => window.privateBrowser.closeTab(id), checkoutId);
  await expect.poll(windowCount).toBe(windowsBefore);
});

test('blocking closes the held popup before a request can reach the wallet', async () => {
  const page = await openCheckout('personal');
  const windowsBefore = await windowCount();
  const prompt = await popupPrompt();
  expect(await runInCheckout<boolean>(`Boolean(window.open('/wallet', 'wallet', 'popup,width=420,height=560'))`)).toBe(true);
  await expect.poll(prompt.state).toMatchObject({ capability: 'popups', origin });
  expect(walletRequests).toBe(0);
  await prompt.answer('deny');
  await expect.poll(windowCount).toBe(windowsBefore);
  expect(walletRequests).toBe(0);
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then(({ privacyLog }) =>
    privacyLog.find(({ title }) => title === 'Popup blocked by your preference')?.detail))).toContain('Open Site permissions');
});

test('an initial blank popup can navigate safely and return a result to its opener', async () => {
  const page = await openCheckout('personal');
  const prompt = await popupPrompt();
  expect(await runInCheckout<boolean>(`window.verification = window.open('', 'google-verification', 'popup,width=480,height=640'); Boolean(window.verification)`)).toBe(true);
  await expect.poll(prompt.state).toMatchObject({ capability: 'popups', origin, popupAddressType: expect.stringMatching(/^(empty|about:blank)$/) });
  expect(walletRequests).toBe(0);
  await prompt.answer('allow-once');
  await expect.poll(windowCount).toBe(2);
  await application!.evaluate(async ({ BrowserWindow }, target) => {
    const child = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === 'about:blank');
    if (!child) throw new Error('Expected the allowed blank popup to remain available');
    await child.webContents.executeJavaScript(`location.href = ${JSON.stringify(target + '/blank-result')}; true`);
  }, origin);
  await expect.poll(() => runInCheckout<string[]>('window.received')).toEqual(['verification-result']);
  const child = await application!.evaluate(async ({ BrowserWindow }) => {
    const popup = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/blank-result'))!;
    return { url: new URL(popup.webContents.getURL()).pathname, opener: await popup.webContents.executeJavaScript('Boolean(window.opener)') };
  });
  expect(child).toEqual({ url: '/blank-result', opener: true });
  expect(await page.evaluate(({ id, origin }) => window.privateBrowser.getSitePermissions(id, origin), { id: (await page.evaluate(() => window.privateBrowser.getState())).activeTabId, origin })).toContainEqual({
    capability: 'popups', decision: 'ask',
  });
});

test('site controls allow, block with an actionable indicator, and reset to Ask', async () => {
  const page = await openCheckout('personal');
  const state = () => page.evaluate(() => window.privateBrowser.getState());
  const currentTabId = (await state()).activeTabId;
  const permissions = () => page.evaluate(({ id, origin }) => window.privateBrowser.getSitePermissions(id, origin), { id: currentTabId, origin });
  expect(await permissions()).toContainEqual({ capability: 'popups', decision: 'ask' });

  await page.getByRole('button', { name: 'View site information' }).click();
  await page.getByText('Site permissions', { exact: true }).click();
  await page.getByLabel('Pop-ups').selectOption('allow');
  expect(await permissions()).toContainEqual({ capability: 'popups', decision: 'allowed', duration: 'until-revoked' });
  await page.getByRole('button', { name: 'View site information' }).click();
  await page.waitForTimeout(250);
  expect(await runInCheckout<boolean>(`Boolean(window.open('/wallet', 'wallet-allowed', 'popup,width=420,height=560'))`)).toBe(true);
  await expect.poll(() => runInCheckout<string[]>('window.received')).toContain('wallet-ready');

  await page.getByRole('button', { name: 'View site information' }).click();
  await page.getByText('Site permissions', { exact: true }).click();
  await page.getByLabel('Pop-ups').selectOption('block');
  expect(await runInCheckout<boolean>(`Boolean(window.open('/wallet', 'wallet-blocked', 'popup,width=420,height=560'))`)).toBe(false);
  await expect.poll(state).toMatchObject({ tabs: expect.arrayContaining([expect.objectContaining({ id: currentTabId, popupBlockedReason: 'preference' })]) });
  expect(await permissions()).toContainEqual({ capability: 'popups', decision: 'blocked-preference' });

  await page.getByLabel('Pop-ups').selectOption('ask');
  expect(await permissions()).toContainEqual({ capability: 'popups', decision: 'ask' });
  expect((await state()).tabs.find((tab) => tab.id === currentTabId)?.popupBlockedReason).toBeUndefined();
});

test('Always allow saves the exact origin choice across an app restart', async () => {
  const page = await openCheckout('personal');
  const prompt = await popupPrompt();
  const tabId = (await page.evaluate(() => window.privateBrowser.getState())).activeTabId;
  expect(await runInCheckout<boolean>(`Boolean(window.open('/wallet', 'wallet-always', 'popup,width=420,height=560'))`)).toBe(true);
  await expect.poll(prompt.state).toMatchObject({ capability: 'popups', origin });
  await prompt.answer('allow-always');
  await expect.poll(() => page.evaluate(({ id, origin }) => window.privateBrowser.getSitePermissions(id, origin), { id: tabId, origin })).toContainEqual({
    capability: 'popups', decision: 'allowed', duration: 'until-revoked',
  });

  await application!.close();
  application = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userDataPath}`], env: { ...process.env, NODE_ENV: 'test' } });
  const restarted = await application.firstWindow();
  await restarted.evaluate(async ({ origin }) => {
    await window.privateBrowser.switchWorkspace('personal');
    await window.privateBrowser.navigate(origin + '/checkout');
  }, { origin });
  const restartedState = () => restarted.evaluate(() => window.privateBrowser.getState());
  await expect.poll(async () => {
    const state = await restartedState();
    return state.tabs.find((tab) => tab.id === state.activeTabId)?.url;
  }).toBe(`${origin}/checkout`);
  const activeId = (await restartedState()).activeTabId;
  await expect.poll(() => restarted.evaluate(({ id, origin }) => window.privateBrowser.getSitePermissions(id, origin), { id: activeId, origin })).toContainEqual({
    capability: 'popups', decision: 'allowed', duration: 'until-revoked',
  });
  const openedAfterRestart = await application.evaluate(async ({ webContents }, target) => {
    const checkout = webContents.getAllWebContents().find((contents) => contents.getURL() === target)!;
    return checkout.executeJavaScript(`Boolean(window.open('/wallet', 'wallet-after-restart', 'popup,width=420,height=560'))`);
  }, `${origin}/checkout`);
  expect(openedAfterRestart).toBe(true);
  await expect.poll(() => restarted.evaluate(() => window.privateBrowser.getState().then((state) => state.pendingPermission))).toBeUndefined();
  await expect.poll(() => runInCheckout<string[]>('window.received')).toContain('wallet-ready');
});

test('Banking still refuses payment popups', async () => {
  await openCheckout('banking');
  const windowsBefore = await windowCount();
  expect(await runInCheckout<boolean>(`Boolean(window.open('/wallet', 'wallet', 'popup,width=420,height=560'))`)).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await windowCount()).toBe(windowsBefore);
});
