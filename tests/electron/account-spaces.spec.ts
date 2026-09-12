import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let application: ElectronApplication | undefined;
let userDataPath: string;
let origin: string;
let server: Server;
let documentHeaders: IncomingHttpHeaders | undefined;

test.beforeEach(async () => {
  documentHeaders = undefined;
  server = createServer((request, response) => {
    if (request.url === '/') documentHeaders = request.headers;
    response.setHeader('Cache-Control', 'public, max-age=3600');
    if (request.url === '/sw.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end("self.addEventListener('fetch', () => undefined);");
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Account isolation fixture</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP');
  origin = `http://127.0.0.1:${address.port}`;
  userDataPath = mkdtempSync(join(tmpdir(), 'private-browser-electron-'));
  const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userDataPath}`], env });
});

test.afterEach(async () => {
  await application?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(userDataPath, { recursive: true, force: true });
});

test('keeps the packaged User-Agent aligned with Chromium client hints', async () => {
  const page = await application!.firstWindow();
  const state = await page.evaluate(() => window.privateBrowser.getState());
  await page.evaluate(
    ({ accountSpaceId, target }) => window.privateBrowser.openInAccountSpace(accountSpaceId, target)
      .catch((error) => {
        if (!(error instanceof Error) || !error.message.includes('ERR_ABORTED')) throw error;
      }),
    { accountSpaceId: state.activeAccountSpaceId, target: origin },
  );
  await expect.poll(() => documentHeaders?.['user-agent']).toContain('Chrome/');
  const headerUserAgent = documentHeaders?.['user-agent'] ?? '';
  expect(headerUserAgent).not.toMatch(/Electron|private[-_ ]work[-_ ]browser/i);

  const rendererIdentity = await application!.evaluate(async ({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(target));
    if (!contents) throw new Error('Browser page view was not created');
    return contents.executeJavaScript(`({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData?.brands ?? []
    })`);
  }, origin);
  expect(rendererIdentity.userAgent).toBe(headerUserAgent);
  expect(rendererIdentity.brands).toEqual(expect.arrayContaining([expect.objectContaining({ brand: 'Chromium' })]));
});

test('creates unique persistent partitions and isolates cookies, storage, cache and workers', async () => {
  const page = await application!.firstWindow();
  await expect(page.getByRole('button', { name: /Account Space:/ })).toBeVisible();
  const [first, second] = await page.evaluate(async () => {
    const firstId = await window.privateBrowser.addLocalAccountSpace('personal', 'First', 'indigo');
    const secondId = await window.privateBrowser.addLocalAccountSpace('personal', 'Second', 'sky');
    return [firstId, secondId];
  });
  expect(first).not.toBe(second);
  const result = await application!.evaluate(async ({ BrowserWindow, session }, value) => {
    let stage = 'create sessions';
    try {
    const firstSession = session.fromPartition(`persist:private-browser-account-${value.first}`);
    const secondSession = session.fromPartition(`persist:private-browser-account-${value.second}`);
    stage = 'set cookie';
    await firstSession.cookies.set({ url: value.origin, name: 'account', value: 'first' });
    const openFixture = async (partition: string) => {
      const window = new BrowserWindow({ show: false, webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      await window.loadURL(value.origin);
      return window;
    };
    stage = 'open first fixture';
    const firstWindow = await openFixture(`persist:private-browser-account-${value.first}`);
    stage = 'seed first storage';
    const seeded = await firstWindow.webContents.executeJavaScript(`(async () => {
      let stage = 'localStorage';
      try {
        localStorage.setItem('account', 'first');
        stage = 'indexedDB';
        await new Promise((resolve, reject) => {
          const request = indexedDB.open('account-db', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('values').put('first', 'account');
          request.onsuccess = () => { request.result.close(); resolve(undefined); };
          request.onerror = () => reject(request.error);
        });
        stage = 'cacheStorage';
        await caches.open('account-cache');
        stage = 'serviceWorker';
        await navigator.serviceWorker.register('/sw.js');
        await navigator.serviceWorker.ready;
        return { error: null };
      } catch (error) {
        return { error: stage + ': ' + (error instanceof Error ? error.name + ': ' + error.message : String(error)) };
      }
    })()`);
    if (seeded.error) throw new Error(seeded.error);
    const inspect = async (partition: string) => {
      const window = await openFixture(partition);
      const state = await window.webContents.executeJavaScript(`(async () => ({
        localStorage: localStorage.getItem('account'),
        databases: (await indexedDB.databases()).map((database) => database.name),
        caches: await caches.keys(),
        serviceWorkers: (await navigator.serviceWorker.getRegistrations()).length
      }))()`);
      window.destroy();
      return state;
    };
    stage = 'close seed window';
    firstWindow.destroy();
    stage = 'inspect first storage';
    const firstStorage = await inspect(`persist:private-browser-account-${value.first}`);
    stage = 'inspect second storage';
    const secondStorage = await inspect(`persist:private-browser-account-${value.second}`);
    return {
      fatalError: undefined,
      first: (await firstSession.cookies.get({ url: value.origin })).map((cookie) => cookie.value),
      second: (await secondSession.cookies.get({ url: value.origin })).map((cookie) => cookie.value),
      firstStorage,
      secondStorage,
    };
    } catch (error) {
      const detail = error && typeof error === 'object'
        ? Object.fromEntries(Object.getOwnPropertyNames(error).map((key) => [key, String(Reflect.get(error, key))]))
        : { value: String(error) };
      return {
        fatalError: `${stage}: ${JSON.stringify(detail)}`,
        first: [],
        second: [],
        firstStorage: undefined,
        secondStorage: undefined,
      };
    }
  }, { first, second, origin });
  expect(result.fatalError).toBeUndefined();
  expect(result.first).toEqual(['first']);
  expect(result.second).toEqual([]);
  expect(result.firstStorage).toEqual({ localStorage: 'first', databases: ['account-db'], caches: ['account-cache'], serviceWorkers: 1 });
  expect(result.secondStorage).toEqual({ localStorage: null, databases: [], caches: [], serviceWorkers: 0 });

  await page.evaluate(({ accountSpaceId, target }) => window.privateBrowser.openInAccountSpace(accountSpaceId, target), { accountSpaceId: first, target: origin });
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState()).then((state) => state.tabs.some((tab) => tab.url.startsWith(origin)))).toBe(true);
  await application!.evaluate(async ({ webContents }, target) => {
    const source = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(target));
    if (!source) throw new Error('Account Space page view was not created');
    await source.executeJavaScript(`window.open(${JSON.stringify(target + '/popup')})`);
  }, origin);
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.privateBrowser.getState());
    return state.tabs.find((tab) => tab.url === `${origin}/popup`)?.accountSpaceId;
  }).toBe(first);
});

test('preserves workspace policy while account UI stays reachable', async () => {
  const page = await application!.firstWindow();
  await page.getByRole('button', { name: /Account Space:/ }).click();
  await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
  await expect(page.getByRole('dialog', { name: 'Account Spaces' })).toBeVisible();
  await page.getByRole('button', { name: 'Close Account Space manager' }).click();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  const state = await page.evaluate(() => window.privateBrowser.getState());
  const active = state.tabs.find((tab) => tab.id === state.activeTabId);
  expect(active?.workspaceId).toBe('banking');
  expect(active?.developerToolsAllowed).toBe(false);
});
