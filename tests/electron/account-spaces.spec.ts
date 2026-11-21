import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSpaceId } from '../../electron/types.js';

let application: ElectronApplication | undefined;
let userDataPath: string;
let origin: string;
let server: Server;
let documentHeaders: IncomingHttpHeaders | undefined;
let trackerConnections = 0;
const installerBytes = 'local installer fixture';

function launchProfile() {
  const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userDataPath}`], env });
}

function startAccountDownload(target: string, savePath: string) {
  return application!.evaluate(({ webContents }, { target, savePath }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target + '/source');
    if (!contents) throw new Error('Download source view is missing');
    // The initial request is stopped for permission. Set a path on the granted retry.
    contents.session.once('will-download', () => {
      contents.session.once('will-download', (_event, item) => item.setSavePath(savePath));
    });
    contents.downloadURL(target);
  }, { target, savePath });
}

test.beforeEach(async () => {
  documentHeaders = undefined;
  trackerConnections = 0;
  server = createServer((request, response) => {
    if (request.url === '/') documentHeaders = request.headers;
    response.setHeader('Cache-Control', 'public, max-age=3600');
    if (request.url === '/sleep-static' || request.url === '/sleep-form') {
      response.setHeader('Content-Type', 'text/html');
      response.end(request.url === '/sleep-static'
        ? '<!doctype html><title>Reference to sleep</title><p>Static reference text.</p>'
        : '<!doctype html><title>Page with a form</title><form><input name="unsaved"></form>');
      return;
    }
    if (request.url === '/slow-download') {
      const size = 20 * 1024 * 1024;
      const match = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
      let sent = match ? Number(match[1]) : 0;
      response.statusCode = match ? 206 : 200;
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', 'attachment; filename="slow-fixture.txt"');
      response.setHeader('Content-Length', String(size - sent));
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('ETag', '"slow-fixture"');
      response.setHeader('Last-Modified', 'Sat, 21 Nov 2026 11:00:00 GMT');
      if (match) response.setHeader('Content-Range', 'bytes ' + sent + '-' + (size - 1) + '/' + size);
      const chunk = Buffer.alloc(64 * 1024, 65);
      const timer = setInterval(() => {
        sent += chunk.length;
        if (sent >= size) response.end(chunk);
        else response.write(chunk);
      }, 80);
      response.once('close', () => clearInterval(timer));
      return;
    }
    if (request.url === '/release-fixture') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', 'attachment; filename="installer-fixture.exe"');
      response.end(installerBytes);
      return;
    }
    if (request.url === '/account-download') {
      response.setHeader('Content-Type', 'text/plain');
      response.setHeader('Content-Disposition', 'attachment; filename="account-fixture.txt"');
      response.end('local fixture');
      return;
    }
    if (request.url === '/turnstile') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html>
        <title>Turnstile fixture</title>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
        <div class="cf-turnstile" data-sitekey="1x00000000000000000000AA"></div>`);
      return;
    }
    if (request.url === '/sw.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end("self.addEventListener('fetch', () => undefined);");
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Account isolation fixture</title>');
  });
  server.on('connect', (request, socket) => {
    if (request.url === 'scorecardresearch.com:443') trackerConnections++;
    // The test proxy terminates every connection locally.
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to TCP');
  origin = `http://127.0.0.1:${address.port}`;
  userDataPath = mkdtempSync(join(tmpdir(), 'private-browser-electron-'));
  application = await launchProfile();
});

test.afterEach(async () => {
  await application?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(userDataPath, { recursive: true, force: true });
});

test('restores selected side-panel tools and pins only for their owning Account Space', async () => {
  let page = await application!.firstWindow();
  const state = () => page.evaluate(() => window.privateBrowser.getState());
  const first = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Owner of panel pins', 'sky'));
  await page.evaluate(async (id) => {
    await window.privateBrowser.setUiPreferences({ sidePanelOpen: true, sidePanelTool: 'downloads' }, id);
    await window.privateBrowser.setSidePanelPin(id, 'downloads', true);
  }, first);
  const second = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Other panel preferences', 'indigo'));
  expect((await state()).sidePanelPins).toEqual([]);
  await expect(page.evaluate((id) => window.privateBrowser.setSidePanelPin(id, 'downloads', false), first)).rejects.toThrow(/unavailable/i);
  await expect(page.evaluate((id) => window.privateBrowser.setUiPreferences({ sidePanelTool: 'downloads' }, id), first)).rejects.toThrow(/space changed/i);
  await page.evaluate((id) => window.privateBrowser.setUiPreferences({ sidePanelTool: 'privacy' }, id), second);
  await application!.close();
  application = await launchProfile();
  page = await application.firstWindow();
  expect((await state()).ui.sidePanelTool).toBe('privacy');
  expect((await state()).sidePanelPins).toEqual([]);
  await page.evaluate((id) => window.privateBrowser.switchAccountSpace(id), first);
  expect((await state()).ui.sidePanelTool).toBe('downloads');
  expect((await state()).sidePanelPins).toEqual(['downloads']);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  expect((await state()).sidePanelPins).toBeUndefined();
});

test('offers first-launch setup once and keeps a skip after restart', async () => {
  let page = await application!.firstWindow();
  await expect(page.getByRole('button', { name: 'Open setup guide' })).toBeVisible();
  await page.getByRole('main', { name: 'New Tab' }).getByRole('button', { name: 'Skip setup' }).click();
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then((state) => state.ui.offerSetupGuide))).toBe(false);
  await application!.close();
  const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userDataPath}`], env });
  page = await application.firstWindow();
  await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open setup guide' })).toHaveCount(0);
  expect(await page.evaluate(() => window.privateBrowser.getState().then((state) => state.ui.offerSetupGuide))).toBe(false);
});

test('counts blocked requests for the current page and keeps Banking strict', async () => {
  const page = await application!.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  const getState = () => page.evaluate(() => window.privateBrowser.getState());
  const ordinary = origin + '/tracker-page-ordinary';
  const banking = origin + '/tracker-page-banking';
  const probe = (url: string, number: number) => application!.evaluate(async ({ webContents }, input) => {
    const contents = webContents.getAllWebContents().find((view) => view.getURL() === input.url);
    if (!contents) throw new Error('Tracker fixture view is missing');
    await contents.session.setProxy({ mode: 'fixed_servers', proxyRules: input.proxy, proxyBypassRules: '127.0.0.1' });
    await contents.session.closeAllConnections();
    await contents.executeJavaScript(`new Image().src = "https://scorecardresearch.com/tracker-${input.number}.gif"; true`);
  }, { url, number, proxy: origin });

  await page.evaluate((url) => window.privateBrowser.navigate(url), ordinary);
  await probe(ordinary, 1);
  await expect.poll(async () => (await getState()).trackerSite?.counts.analytics).toBe(1);
  expect(trackerConnections).toBe(0);
  const tab = (await getState()).activeTabId;
  const pause = (value: boolean) => page.evaluate(({ tab, site, value }) =>
    window.privateBrowser.setTrackerCompatibility(tab, site, value), { tab, site: origin, value });
  await pause(true);
  await probe(ordinary, 2);
  await expect.poll(() => trackerConnections).toBeGreaterThan(0);
  expect((await getState()).trackerSite?.counts.analytics).toBe(1);
  await pause(false);
  await probe(ordinary, 3);
  await expect.poll(async () => (await getState()).trackerSite?.counts.analytics).toBe(2);
  await page.evaluate(() => window.privateBrowser.toggleTrackerBlocking());
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await page.evaluate((url) => window.privateBrowser.navigate(url), banking);
  await probe(banking, 4);
  await expect.poll(async () => (await getState()).trackerSite?.counts.analytics).toBe(1);
  expect((await getState()).trackerSite).toMatchObject({ blocking: true, canPause: false });
  await expect(page.evaluate(({ id, site }) => window.privateBrowser.setTrackerCompatibility(id, site, true),
    { id: (await getState()).activeTabId, site: origin })).rejects.toThrow(/unavailable/);
});

test('locks browser data and native views on Windows lock until its observed unlock', async () => {
  test.skip(process.platform !== 'win32', 'Exercises the Windows lock event path in an isolated Electron profile.');
  let page = await application!.firstWindow();
  const subject = origin + '/locked-window-fixture';
  await page.evaluate(async (url) => {
    await window.privateBrowser.switchWorkspace('personal');
    await window.privateBrowser.navigate(url);
    await window.privateBrowser.setUiPreferences({ lockOnWindowsSession: true, idleLockMinutes: 5 });
  }, subject);
  await application!.evaluate(({ powerMonitor }) => { powerMonitor.emit('lock-screen'); });
  await expect(page.getByRole('heading', { name: 'Private Browser is locked' })).toBeVisible();
  const snapshot = await page.evaluate(() => window.privateBrowser.getState());
  expect(snapshot).toMatchObject({ sessionLock: 'windows', accountSpaces: [], tabs: [], history: [], sideApps: [] });
  expect(await application!.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((view) => view.getURL() === url), subject)).toBe(false);
  await expect(page.evaluate(() => window.privateBrowser.listVault())).rejects.toThrow(/locked/i);
  await application!.close();
  application = await launchProfile();
  page = await application.firstWindow();
  await expect(page.getByRole('heading', { name: 'Private Browser is locked' })).toBeVisible();
  await application.evaluate(({ powerMonitor }) => { powerMonitor.emit('unlock-screen'); });
  await expect(page.getByRole('heading', { name: 'Private Browser is locked' })).toBeVisible();
  await application.evaluate(({ powerMonitor }) => {
    powerMonitor.emit('lock-screen');
    powerMonitor.emit('unlock-screen');
  });
  await expect.poll(() => application!.evaluate(({ webContents }, url) => webContents.getAllWebContents().some((view) => view.getURL() === url), subject)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Private Browser is locked' })).toHaveCount(0);
  expect((await page.evaluate(() => window.privateBrowser.getState())).ui.idleLockMinutes).toBe(5);
});

test('idle auto-lock uses the Windows idle clock without leaving a browser unlock button', async () => {
  test.skip(process.platform !== 'win32', 'Exercises the Windows idle clock integration.');
  const page = await application!.firstWindow();
  await application!.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 301; });
  await page.evaluate(() => window.privateBrowser.setUiPreferences({ idleLockMinutes: 5 }));
  await expect(page.getByRole('heading', { name: 'Private Browser is locked' })).toBeVisible({ timeout: 10_000 });
  expect((await page.evaluate(() => window.privateBrowser.getState())).sessionLock).toBe('idle');
  await expect(page.getByRole('button', { name: /resume|unlock/i })).toHaveCount(0);
  await expect(page.getByText('Lock and unlock Windows to resume browsing.')).toBeVisible();
});

test('sleeps a static inactive tab and restores it without unloading forms or pinned origins', async () => {
  const page = await application!.firstWindow();
  const fixtures = { reading: origin + '/sleep-static', form: origin + '/sleep-form' };
  const { reading, form } = await page.evaluate(async (urls) => {
    const api = window.privateBrowser;
    await api.switchWorkspace('personal');
    await api.setUiPreferences({ memorySaverMinutes: 5 });
    await api.newTab('personal', urls.reading);
    const reading = (await api.getState()).activeTabId;
    await api.newTab('personal', urls.form);
    const form = (await api.getState()).activeTabId;
    await api.newTab('personal');
    return { reading, form };
  }, fixtures);
  const openNative = (url: string) => application!.evaluate(({ webContents }, value) =>
    webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === value).length, url);
  await expect.poll(() => openNative(fixtures.reading)).toBe(1);
  await expect.poll(() => openNative(fixtures.form)).toBe(1);
  await application!.evaluate(() => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + 6 * 60_000;
  });
  const snapshot = () => page.evaluate(() => window.privateBrowser.getState());
  await expect.poll(async () => (await snapshot()).tabs.find(({ id }) => id === reading)?.sleeping, { timeout: 12_000 }).toBe(true);
  expect((await snapshot()).tabs.find(({ id }) => id === form)?.sleeping).toBeUndefined();
  expect(await openNative(fixtures.reading)).toBe(0);
  expect(await openNative(fixtures.form)).toBe(1);
  await page.evaluate((id) => window.privateBrowser.activateTab(id), reading);
  await expect.poll(() => openNative(fixtures.reading)).toBe(1);
  const awake = await page.evaluate(async ({ id, site }) => {
    await window.privateBrowser.setMemorySaverSite(id, site, true);
    return (await window.privateBrowser.getState()).memorySaverSite;
  }, { id: reading, site: origin });
  expect(awake).toEqual({ origin, keptAwake: true });
  const original = (await snapshot()).activeAccountSpaceId;
  const other = await page.evaluate(async (url) => {
    const api = window.privateBrowser;
    await api.addLocalAccountSpace('personal', 'Other memory space', 'sky');
    await api.navigate(url);
    const state = await api.getState();
    await api.newTab('personal');
    return { site: state.memorySaverSite, id: state.activeTabId };
  }, fixtures.reading);
  expect(other.site).toEqual({ origin, keptAwake: false });
  await application!.evaluate(() => {
    const now = Date.now.bind(Date);
    Date.now = () => now() + 6 * 60_000;
  });
  await expect.poll(async () => (await snapshot()).tabs.find(({ id }) => id === other.id)?.sleeping, { timeout: 12_000 }).toBe(true);
  expect((await snapshot()).tabs.find(({ id }) => id === reading)?.sleeping).toBeUndefined();
  expect(await openNative(fixtures.reading)).toBe(1);
  await application!.close();
  application = await launchProfile();
  const restarted = await application.firstWindow();
  const retained = await restarted.evaluate(async (id) => {
    const api = window.privateBrowser;
    await api.switchAccountSpace(id);
    return (await api.getState()).memorySaverSite;
  }, original);
  expect(retained).toEqual(awake);
});

test('checks the managed update in its own directory and opens it only on an eligible explicit action', async () => {
  test.skip(process.platform !== 'win32', 'Exercises the Windows installer download marker.');
  const page = await application!.firstWindow();
  const targetVersion = '90.0.0';
  const checksum = createHash('sha256').update(installerBytes).digest('hex');
  await application!.evaluate(({ shell }, sample) => {
    const endpoint = 'https://private-browser-downloads.digitronics-electro.workers.dev';
    const expiresAt = new Date(Date.now() + 60_000);
    const signature = 'expires=' + Math.floor(expiresAt.getTime() / 1000) + '&signature=fixture';
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.origin !== endpoint) throw new Error('Unexpected fixture request');
      if (url.pathname === '/api/v1/releases/public/latest') {
        return Response.json({
          schemaVersion: 1, appId: 'private-browser', version: sample.version, buildNumber: 1, channel: 'stable',
          sha256: sample.checksum, filename: 'Private-Browser-Setup.exe', sizeBytes: Buffer.byteLength(sample.bytes),
          commitSha: 'a'.repeat(40), publishedAt: new Date().toISOString(), releaseNotes: '',
          downloadUrl: endpoint + '/download/latest.exe?' + signature,
          downloadPageUrl: endpoint + '/download?' + signature, expiresAt: expiresAt.toISOString(),
        });
      }
      if (url.pathname === '/download/latest.exe') return new Response(sample.bytes);
      throw new Error('Unexpected fixture route');
    };
    shell.openPath = async (file) => {
      process.env.PRIVATE_BROWSER_TEST_MANAGED_OPEN = file;
      return '';
    };
  }, { version: targetVersion, checksum, bytes: installerBytes });
  const getState = () => page.evaluate(() => window.privateBrowser.getState());
  const openedPath = () => application!.evaluate(() => process.env.PRIVATE_BROWSER_TEST_MANAGED_OPEN);
  await page.evaluate(({ version, sha }) => window.privateBrowser.downloadManagedUpdate(version, sha), { version: targetVersion, sha: checksum });
  expect((await getState()).managedUpdate).toMatchObject({ phase: 'ready', version: targetVersion });
  expect(await openedPath()).toBeUndefined();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  expect((await getState()).managedUpdate).toBeUndefined();
  await expect(page.evaluate(() => window.privateBrowser.installManagedUpdate())).rejects.toThrow(/regular Account Space/);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
  await page.evaluate(() => window.privateBrowser.installManagedUpdate());
  expect((await getState()).managedUpdate).toEqual({ phase: 'launched', version: targetVersion });
  const path = (await openedPath())!;
  expect(path).toMatch(/[/\\]update-installers[/\\]installer-[^/\\]+[/\\]PrivateBrowserUpdate\.exe$/);
  expect(existsSync(path)).toBe(true);
});

test('previews a native Chrome import and undoes its untouched records only', async () => {
  test.skip(process.platform !== 'win32', 'The disposable Chrome path in this test uses the Windows profile convention');
  const page = await application!.firstWindow();
  const localRoot = join(userDataPath, 'disposable-local-data');
  const chromeProfile = join(localRoot, 'Google', 'Chrome', 'User Data', 'Default');
  mkdirSync(chromeProfile, { recursive: true });
  writeFileSync(join(chromeProfile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children: [
    { type: 'folder', name: 'Reviewed folder', children: [
      { type: 'url', name: 'Keep edited bookmark', url: 'https://example.test/import/first' },
      { type: 'url', name: 'Undo this bookmark', url: 'https://example.test/import/second' },
    ] },
    { type: 'url', name: 'Unsupported fixture', url: 'file:///not-a-bookmark' },
  ] } } }));
  await application!.evaluate((_electron, directory) => { process.env.LOCALAPPDATA = directory; }, localRoot);
  const initial = await page.evaluate((url) => window.privateBrowser.navigate(url + '/unrelated').then(async () => {
    await window.privateBrowser.toggleBookmark();
    return window.privateBrowser.getState();
  }), origin);
  const options = { profileId: 'Default', accountSpaceId: initial.activeAccountSpaceId, workspaceId: initial.activeWorkspaceId, bookmarks: true, history: false };
  const review = await page.evaluate((value) => window.privateBrowser.previewChromeImport(value), options);
  expect(review.result.imported.bookmarks).toBe(2);
  expect(review.unsupported).toBe(1);
  expect(review.folders).toEqual([{ location: 'bar', path: ['Reviewed folder'], count: 2 }]);
  const read = () => page.evaluate(() => window.privateBrowser.getState().then((state) => state.bookmarks));
  expect(await read()).toEqual(initial.bookmarks);
  const confirm = () => page.evaluate((id) => window.privateBrowser.confirmChromeImport(id), review.id);
  await expect(confirm()).resolves.toMatchObject({ imported: { bookmarks: 2 } });
  await expect(confirm()).rejects.toThrow(/Preview this Chrome import again/i);
  const edited = (await read()).find((item) => item.title === 'Keep edited bookmark')!;
  await page.evaluate((id) => window.privateBrowser.renameBookmark(id, 'I edited this'), edited.id);
  await expect(page.evaluate((id) => window.privateBrowser.undoChromeImport(id), options.accountSpaceId)).resolves.toEqual({ bookmarks: 1, history: 0 });
  const after = await read();
  expect(after).toHaveLength(initial.bookmarks.length + 1);
  expect(after.find((item) => item.id === edited.id)?.title).toBe('I edited this');
  expect(after).toContainEqual(initial.bookmarks[0]);
  await expect(page.evaluate((value) => window.privateBrowser.previewChromeImport(value), options)).rejects.toThrow(/already been imported/);
});

test('suggests a Chrome profile destination and persists one settings import per profile', async () => {
  test.skip(process.platform !== 'win32', 'The fixture uses the Windows Chrome profile path.');
  const localRoot = join(userDataPath, 'chrome-settings-fixture');
  const source = join(localRoot, 'Google', 'Chrome', 'User Data');
  mkdirSync(join(source, 'Profile 1'), { recursive: true });
  writeFileSync(join(source, 'Local State'), JSON.stringify({ profile: { info_cache: { 'Profile 1': { name: 'Research' } } } }));
  writeFileSync(join(source, 'Profile 1', 'Preferences'), JSON.stringify({
    default_search_provider_data: { template_url_data: { url: '{google:baseURL}search?q={searchTerms}' } },
    homepage_is_newtabpage: false, homepage: 'https://research.example.test/',
    session: { restore_on_startup: 5 },
  }));
  const useFixture = () => application!.evaluate((_electron, directory) => { process.env.LOCALAPPDATA = directory; }, localRoot);
  await useFixture();
  let page = await application!.firstWindow();
  const id = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Research', 'sky'));
  const profile = () => page.evaluate(() => window.privateBrowser.listChromeProfiles().then((profiles) => profiles.find((item) => item.id === 'Profile 1')));
  expect(await profile()).toMatchObject({ suggestedAccountSpaceId: id, hasPreferences: true });
  const options = { profileId: 'Profile 1', workspaceId: 'personal' as const, accountSpaceId: id,
    bookmarks: false, history: false, settings: { search: true, home: true } };
  const preview = () => page.evaluate((value) => window.privateBrowser.previewChromeImport(value), options);
  const old = await preview();
  expect(old.settingsPatch).toEqual({ searchEngine: 'google', homePage: 'url', homePageUrl: 'https://research.example.test/' });
  const original = await page.evaluate(() => window.privateBrowser.getState().then((state) => state.settings));
  expect(original.searchEngine).toBe('duckduckgo');
  await page.evaluate(() => window.privateBrowser.setBrowserSettings({ searchEngine: 'bing' }, 'personal'));
  await expect(page.evaluate((value) => window.privateBrowser.confirmChromeImport(value), old.id)).rejects.toThrow(/Workspace settings changed/);
  const final = await preview();
  await expect(page.evaluate((value) => window.privateBrowser.confirmChromeImport(value), final.id)).resolves.toMatchObject({ appliedSettings: ['search', 'home'] });
  expect(await page.evaluate(() => window.privateBrowser.getState().then((state) => state.settings)))
    .toMatchObject({ searchEngine: 'google', homePageUrl: 'https://research.example.test/', startup: original.startup });
  await application!.close();
  application = await launchProfile();
  await useFixture();
  page = await application.firstWindow();
  expect(await profile()).toMatchObject({ imported: true, importedInto: id });
  await expect(preview()).rejects.toThrow(/already been imported/);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('tenten'));
  expect(await page.evaluate(() => window.privateBrowser.getState().then((state) => state.settings.searchEngine))).toBe('duckduckgo');
  expect(await profile()).toMatchObject({ imported: true, importedInto: undefined });
});

test('imports standard bookmark HTML into the selected native Account Space', async () => {
  const page = await application!.firstWindow();
  const account = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'HTML destination', 'sky'));
  const path = join(userDataPath, 'fixture-bookmarks.html');
  writeFileSync(path, '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3><DL>'
    + '<DT><H3>Work &amp; notes</H3><DL><DT><A HREF="https://example.test/catalog">Sample link</A></DL>'
    + '<DT><A HREF="file:///local-fixture">Unsupported local file</A></DL></DL>');
  const chooseFixture = () => application!.evaluate(({ dialog }, selected) => {
    const real = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = real;
      return { canceled: false, filePaths: [selected] };
    };
  }, path);
  const imported = () => page.evaluate((id) => window.privateBrowser.importBookmarkHtml(id), account);
  await chooseFixture();
  expect(await imported()).toEqual({ imported: 1, skipped: 1 });
  await chooseFixture();
  expect(await imported()).toEqual({ imported: 0, skipped: 2 });
  const items = await page.evaluate(() => window.privateBrowser.getState().then((state) => state.bookmarks));
  expect(items.filter((item) => item.accountSpaceId === account)).toMatchObject([
    { title: 'Sample link', url: 'https://example.test/catalog', location: 'bar', folderPath: ['Work & notes'] },
  ]);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect(imported()).rejects.toThrow(/Account Space changed/i);
});

test('reads Google connection health without a network check and rejects another workspace', async () => {
  const page = await application!.firstWindow();
  const initial = await page.evaluate(() => window.privateBrowser.getState());
  const id = initial.activeAccountSpaceId;
  const health = () => page.evaluate((value) => window.privateBrowser.getGoogleConnectionHealth(value), id);
  expect(await health()).toMatchObject({ state: 'disconnected' });
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect(health()).rejects.toThrow(/active workspace/);
  const banking = await page.evaluate(async () => {
    const api = window.privateBrowser;
    return api.getGoogleConnectionHealth((await api.getState()).activeAccountSpaceId);
  });
  expect(banking).toEqual({ state: 'unavailable' });
});

test('retains a named Google setup after restart and keeps Banking out of OAuth', async () => {
  const windowBefore = await application!.firstWindow();
  const id = await windowBefore.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Pending Google setup', 'indigo', true));
  await expect.poll(() => windowBefore.evaluate((accountId) => window.privateBrowser.getState().then(
    (state) => state.accountSpaces.find((account) => account.id === accountId),
  ), id)).toMatchObject({ googleSetupPending: true, kind: 'local', googleConnection: 'disconnected' });

  await application!.close();
  application = await launchProfile();
  const windowAfter = await application.firstWindow();
  const restored = await windowAfter.evaluate((accountId) => window.privateBrowser.getState().then(
    (state) => state.accountSpaces.find((account) => account.id === accountId),
  ), id);
  expect(restored).toMatchObject({ googleSetupPending: true, label: 'Pending Google setup', enabledModules: [] });
  const denied = await windowAfter.evaluate(async () => {
    const api = window.privateBrowser;
    await api.switchWorkspace('banking');
    return api.connectGoogleAccount((await api.getState()).activeAccountSpaceId, ['identity'], 'edge');
  });
  expect(denied).toMatchObject({ ok: false, error: { code: 'GOOGLE_POLICY_DENIED' } });
});

test('reviews a local selection and rejects clipboard replay after cancelling', async () => {
  const page = await application!.firstWindow();
  const url = origin + '/selection-excerpt';
  await page.evaluate((target) => window.privateBrowser.navigate(target), url);
  await expect.poll(() => application!.evaluate(({ webContents }, target) => {
    return webContents.getAllWebContents().some((view) => view.getURL() === target && !view.isLoading());
  }, url)).toBe(true);
  await application!.evaluate(async ({ webContents }, target) => {
    const view = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target)!;
    await view.executeJavaScript(`
      document.body.textContent = 'Approved catalogue paragraph. token=local-fixture';
      const range = document.createRange();
      range.selectNodeContents(document.body);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    `);
  }, url);
  const review = await page.evaluate(() => window.privateBrowser.prepareClaudeExcerpt());
  expect(review).toMatchObject({ url: origin, text: 'Approved catalogue paragraph. [REDACTED]', redactions: 1 });
  expect(review).not.toHaveProperty('sourceUrl');
  await page.evaluate((id) => window.privateBrowser.cancelClaudeExcerpt(id), review.id);
  await expect(page.evaluate((id) => window.privateBrowser.copyClaudeExcerpt(id), review.id)).rejects.toThrow(/Review the selection again/);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect(page.evaluate(() => window.privateBrowser.prepareClaudeExcerpt())).rejects.toThrow(/unavailable/);
});

test('routes an operating-system link back to the last regular account from Banking', async () => {
  const page = await application!.firstWindow();
  const accountSpaceId = await page.evaluate(async () => {
    const id = await window.privateBrowser.addLocalAccountSpace('personal', 'External link destination', 'sky');
    await window.privateBrowser.switchWorkspace('banking');
    return id;
  });
  const before = await page.evaluate(() => window.privateBrowser.getState());
  expect(before.activeWorkspaceId).toBe('banking');
  await application!.evaluate(({ app }, url) => {
    app.emit('second-instance', {}, ['private-browser', url], process.cwd(), {});
  }, origin);
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then((state) => state.activeAccountSpaceId)))
    .toBe(accountSpaceId);
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then((state) =>
    state.tabs.find((tab) => tab.id === state.activeTabId)?.title))).toBe('Account isolation fixture');
  const after = await page.evaluate(() => window.privateBrowser.getState());
  expect(after.tabs.filter((tab) => tab.workspaceId === 'banking')).toEqual(before.tabs.filter((tab) => tab.workspaceId === 'banking'));
});

test('saves reviewed tabs locally and refuses stale or cross-Account Space selections', async () => {
  const page = await application!.firstWindow();
  const initial = await page.evaluate(() => window.privateBrowser.getState());
  const selected = await page.evaluate(async (url) => {
    const api = window.privateBrowser;
    await api.navigate(url + '/one');
    await api.newTab(undefined, url + '/two');
    const state = await api.getState();
    return state.tabs.filter((tab) => tab.accountSpaceId === state.activeAccountSpaceId && tab.url.startsWith(url))
      .map(({ id, url }) => ({ id, url }));
  }, origin);
  expect(selected).toHaveLength(2);
  const reviewed = { accountSpaceId: initial.activeAccountSpaceId, tabs: selected };
  expect(await page.evaluate((input) => window.privateBrowser.saveTabSet({ ...input, kind: 'routine', name: 'Reviewed local tabs' }), reviewed)).toBe(2);
  const saveBookmarks = () => page.evaluate((input) => window.privateBrowser.saveTabSet({ ...input, kind: 'bookmarks', name: 'Reviewed pages' }), reviewed);
  expect(await saveBookmarks()).toBe(2);
  expect(await saveBookmarks()).toBe(0);
  const after = await page.evaluate(() => window.privateBrowser.getState());
  expect(after.routines?.find((routine) => routine.name === 'Reviewed local tabs')?.links).toEqual(selected.map(({ url }) => ({ url, accountSpaceId: initial.activeAccountSpaceId })));
  expect(after.bookmarks.filter((item) => item.folderPath[0] === 'Reviewed pages').map(({ url }) => url)).toEqual(selected.map(({ url }) => url));
  await page.evaluate((url) => window.privateBrowser.navigate(url + '/changed'), origin);
  await expect(saveBookmarks()).rejects.toThrow(/selected tabs changed/i);
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect(saveBookmarks()).rejects.toThrow(/original regular Account Space/i);
});

test('runs an ordered routine across isolated accounts and reuses its tabs after restart', async () => {
  let page = await application!.firstWindow();
  const { first, second } = await page.evaluate(async () => ({
    first: await window.privateBrowser.addLocalAccountSpace('personal', 'Morning first', 'sky'),
    second: await window.privateBrowser.addLocalAccountSpace('personal', 'Morning second', 'indigo'),
  }));
  const routine = {
    id: 'routine-fixture', name: 'Morning fixture', focusIndex: 0,
    links: [{ accountSpaceId: first, url: origin }, { accountSpaceId: second, url: origin }],
    checklist: [{ label: 'Review first account' }],
  };
  await page.evaluate((value) => window.privateBrowser.saveRoutine(value), routine);
  const launchRoutine = () => page.evaluate((id) => window.privateBrowser.runRoutine(id), routine.id);
  expect(await launchRoutine()).toEqual({ opened: 2, reused: 0, skipped: [], focusUnavailable: false });
  const current = await page.evaluate(() => window.privateBrowser.getState());
  expect(current.activeAccountSpaceId).toBe(first);
  expect(current.tabs.filter((tab) => tab.url === origin + '/').map((tab) => tab.accountSpaceId)).toEqual([first, second]);
  await page.evaluate((id) => window.privateBrowser.markRoutineChecklist(id, 0, true), routine.id);
  await application!.close();
  const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), '--user-data-dir=' + userDataPath], env });
  page = await application.firstWindow();
  await expect(page.getByRole('button', { name: /Account Space: Morning first/ })).toBeVisible();
  expect(await launchRoutine()).toEqual({ opened: 0, reused: 2, skipped: [], focusUnavailable: false });
  await page.evaluate(({ second, id }) => window.privateBrowser.setAccountSpaceLocked(second, true).then(() => window.privateBrowser.resetRoutineChecklist(id)), { second, id: routine.id });
  expect(await launchRoutine()).toEqual({ opened: 0, reused: 1, skipped: [1], focusUnavailable: false });
  const saved = await page.evaluate((id) => window.privateBrowser.getState().then((state) => state.routines?.find((item) => item.id === id)), routine.id);
  expect(saved?.checklist[0]).toMatchObject({ label: 'Review first account', done: false, completedAt: expect.any(String) });
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  expect(await page.evaluate(() => window.privateBrowser.getState().then((state) => state.routines))).toEqual([]);
});

test('pauses, resumes and cancels a real download only in its Account Space', async () => {
  const page = await application!.firstWindow();
  const owner = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Download controls owner', 'sky'));
  const target = origin + '/slow-download';
  const source = origin + '/source';
  await page.evaluate((url) => window.privateBrowser.navigate(url), source);
  await application!.evaluate(({ webContents }, { target, source, savePath }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === source);
    if (!contents) throw new Error('Download source view is missing');
    contents.session.once('will-download', () => {
      contents.session.once('will-download', (_event, item) => item.setSavePath(savePath));
    });
    contents.downloadURL(target);
  }, { target, source, savePath: join(userDataPath, 'slow-fixture.txt') });
  const getState = () => page.evaluate(() => window.privateBrowser.getState());
  await expect.poll(async () => (await getState()).pendingPermission?.capability).toBe('download');
  await page.evaluate((id) => window.privateBrowser.respondToPermissionPrompt(id, 'allow-once'), (await getState()).pendingPermission!.id);
  const current = async () => (await getState()).downloads[0];
  await expect.poll(async () => (await current())?.canPause).toBe(true);
  const id = (await current()).id;
  await page.evaluate((value) => window.privateBrowser.controlDownload(value, 'pause'), id);
  await expect.poll(async () => (await current())?.paused).toBe(true);
  const pausedAt = (await current()).receivedBytes;
  await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Other account', 'indigo'));
  await expect(page.evaluate((value) => window.privateBrowser.controlDownload(value, 'cancel'), id))
    .rejects.toThrow(/unavailable in this Account Space/i);
  await page.evaluate((value) => window.privateBrowser.switchAccountSpace(value), owner);
  await page.evaluate((value) => window.privateBrowser.controlDownload(value, 'resume'), id);
  await expect.poll(async () => (await current())?.receivedBytes).toBeGreaterThan(pausedAt);
  await page.evaluate((value) => window.privateBrowser.controlDownload(value, 'cancel'), id);
  await expect.poll(async () => (await current())?.state).toBe('cancelled');
  expect((await current()).canCancel).toBe(false);
});

test('reads and revokes native site grants only for the active origin and Account Space', async () => {
  const page = await application!.firstWindow();
  const owner = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Permission owner', 'sky'));
  const source = origin + '/source';
  const target = origin + '/account-download';
  await page.evaluate((url) => window.privateBrowser.navigate(url), source);
  const getState = () => page.evaluate(() => window.privateBrowser.getState());
  const tabId = (await getState()).activeTabId;
  const site = { tabId, origin };
  const status = () => page.evaluate(({ tabId, origin }) => window.privateBrowser.getSitePermissions(tabId, origin), site);
  expect(await status()).toContainEqual({ capability: 'download', decision: 'ask' });
  await application!.evaluate(({ webContents }, { source, target, savePath }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === source);
    if (!contents) throw new Error('Permission source view is missing');
    contents.session.once('will-download', () => {
      contents.session.once('will-download', (_event, item) => item.setSavePath(savePath));
    });
    contents.downloadURL(target);
  }, { source, target, savePath: join(userDataPath, 'permission-fixture.txt') });
  await expect.poll(async () => (await getState()).pendingPermission?.capability).toBe('download');
  await page.evaluate((id) => window.privateBrowser.respondToPermissionPrompt(id, 'allow-always'), (await getState()).pendingPermission!.id);
  await expect.poll(async () => (await getState()).downloads[0]?.state).toBe('completed');
  expect(await status()).toContainEqual({ capability: 'download', decision: 'allowed', duration: 'until-revoked' });
  expect(await page.evaluate((id) => window.privateBrowser.listAccountPermissionGrants(id), owner))
    .toEqual([{ origin, capability: 'download', duration: 'until-revoked' }]);
  const revoke = () => page.evaluate(({ tabId, origin }) => window.privateBrowser.revokeSitePermission(tabId, origin, 'download'), site);
  await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Separate permissions', 'indigo'));
  await expect(revoke()).rejects.toThrow(/page changed/i);
  await page.evaluate((id) => window.privateBrowser.switchAccountSpace(id), owner);
  expect(await revoke()).toContainEqual({ capability: 'download', decision: 'ask' });
  expect(await page.evaluate((id) => window.privateBrowser.listAccountPermissionGrants(id), owner)).toEqual([]);
});

test('scopes the download list and both file commands to the originating account', async () => {
  const page = await application!.firstWindow();
  const first = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Download owner', 'sky'));
  const target = origin + '/account-download';
  await page.evaluate((url) => window.privateBrowser.navigate(url + '/source'), target);
  const savePath = join(userDataPath, 'account-fixture.txt');
  await startAccountDownload(target, savePath);
  const getState = () => page.evaluate(() => window.privateBrowser.getState());
  await expect.poll(async () => (await getState()).pendingPermission?.capability).toBe('download');
  const promptId = (await getState()).pendingPermission!.id;
  await page.evaluate((id) => window.privateBrowser.respondToPermissionPrompt(id, 'allow-once'), promptId);
  await expect.poll(async () => (await getState()).downloads[0]?.state).toBe('completed');
  const [download] = (await getState()).downloads;
  expect(download.filename).toBe('account-fixture.txt');
  expect(download).not.toHaveProperty('savePath');
  await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Separate account', 'indigo'));
  expect((await getState()).downloads).toEqual([]);
  const errors = await page.evaluate(async (id) => {
    const results = await Promise.allSettled([
      window.privateBrowser.openDownload(id),
      window.privateBrowser.showDownload(id),
    ]);
    return results.map((result) => result.status === 'rejected' ? String(result.reason) : 'allowed');
  }, download.id);
  for (const error of errors) expect(error).toContain('Download is unavailable in this Account Space');
  await page.evaluate((id) => window.privateBrowser.switchAccountSpace(id), first);
  expect((await getState()).downloads).toEqual([download]);
});

test('retains only opted-in downloads and removes entries without deleting the saved file', async () => {
  test.skip(process.platform !== 'win32', 'Uses Windows protected storage in a disposable app profile.');
  let page = await application!.firstWindow();
  const getState = () => page.evaluate(() => window.privateBrowser.getState());
  const account = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'History fixture owner', 'sky'));
  const target = origin + '/account-download';
  await page.evaluate((url) => window.privateBrowser.navigate(url + '/source'), target);
  expect((await getState()).downloadHistory).toBe('off');
  await page.evaluate((id) => window.privateBrowser.setDownloadHistory(id, true), account);
  const savePath = join(userDataPath, 'history-fixture.txt');
  await startAccountDownload(target, savePath);
  await expect.poll(async () => (await getState()).pendingPermission?.capability).toBe('download');
  await page.evaluate((id) => window.privateBrowser.respondToPermissionPrompt(id, 'allow-once'), (await getState()).pendingPermission!.id);
  await expect.poll(async () => (await getState()).downloads[0]?.retained).toBe(true);
  await application!.close();
  application = await launchProfile();
  page = await application.firstWindow();
  const [download] = (await getState()).downloads;
  expect(download).toMatchObject({ filename: 'history-fixture.txt', origin, state: 'completed', retained: true });
  expect(download).not.toHaveProperty('savePath');
  expect(download).not.toHaveProperty('retainedFileStamp');
  expect(Date.parse(download.finishedAt!)).toBeGreaterThan(0);
  await application.evaluate(({ shell }, expected) => {
    shell.openPath = async (path) => path === expected ? '' : 'Unexpected path';
  }, savePath);
  const open = () => page.evaluate((id) => window.privateBrowser.openDownload(id), download.id);
  await expect(open()).resolves.toBeUndefined();
  writeFileSync(savePath, 'Updated fixture bytes', 'utf8');
  await expect(open()).rejects.toThrow(/saved file changed/i);
  await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Second history account', 'rose'));
  expect((await getState()).downloads).toEqual([]);
  await expect(open()).rejects.toThrow(/unavailable in this Account Space/i);
  await page.evaluate((id) => window.privateBrowser.switchAccountSpace(id), account);
  await page.evaluate(({ account, id }) => window.privateBrowser.removeDownloadEntry(account, id), { account, id: download.id });
  expect((await getState()).downloads).toEqual([]);
  expect(existsSync(savePath)).toBe(true);
  await application.close();
  application = await launchProfile();
  page = await application.firstWindow();
  expect((await getState()).downloads).toEqual([]);
});

test('saves a batch to its chosen Account Space folder without replacing existing files', async () => {
  test.skip(process.platform !== 'win32', 'Uses Windows protected storage and native downloads in a disposable profile.');
  let page = await application!.firstWindow();
  const folder = join(userDataPath, 'DigiTronics fixture downloads');
  const secondFolder = join(userDataPath, 'TenTen fixture downloads');
  for (const path of [folder, secondFolder]) mkdirSync(path);
  const existing = join(folder, 'account-fixture.txt');
  writeFileSync(existing, 'do not overwrite');
  const target = origin + '/account-download';
  const account = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('digitronics', 'DigiTronics fixture', 'sky'));
  const getState = () => page.evaluate(() => window.privateBrowser.getState());
  const choose = async (id: AccountSpaceId, path: string) => {
    await application!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, path);
    await page.evaluate((owner) => window.privateBrowser.chooseDownloadFolder(owner), id);
  };
  await choose(account, folder);
  expect((await getState()).downloadFolder).toEqual({ ask: true, available: true, name: 'DigiTronics fixture downloads' });
  await page.evaluate((owner) => window.privateBrowser.setDownloadFolderMode(owner, 'automatic'), account);
  await page.evaluate((url) => window.privateBrowser.navigate(url + '/source'), target);
  const trigger = () => application!.evaluate(({ webContents }, url) => {
    const source = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url + '/source');
    if (!source) throw new Error('Download source view is missing');
    source.downloadURL(url);
  }, target);
  await trigger();
  await expect.poll(async () => (await getState()).pendingPermission?.capability).toBe('download');
  await page.evaluate((id) => window.privateBrowser.respondToPermissionPrompt(id, 'allow-always'), (await getState()).pendingPermission!.id);
  await trigger();
  await expect.poll(async () => (await getState()).downloadBatch?.completed).toBe(2);
  expect(readFileSync(existing, 'utf8')).toBe('do not overwrite');
  expect(readdirSync(folder).sort()).toEqual(['account-fixture (1).txt', 'account-fixture (2).txt', 'account-fixture.txt'].sort());
  expect(readFileSync(join(folder, 'account-fixture (2).txt'), 'utf8')).toBe('local fixture');
  expect(JSON.stringify((await getState()).downloads)).not.toContain('savePath');
  const other = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('tenten', 'TenTen fixture', 'indigo'));
  expect((await getState()).downloads).toEqual([]);
  expect((await getState()).downloadFolder?.name).toBeUndefined();
  const stale = () => page.evaluate((owner) => window.privateBrowser.setDownloadFolderMode(owner, 'default'), account);
  await expect(stale()).rejects.toThrow(/unavailable in this Account Space/i);
  await choose(other, secondFolder);
  expect((await getState()).downloadFolder?.name).toBe('TenTen fixture downloads');
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  expect((await getState()).downloadFolder).toBeUndefined();
  await application!.close();
  application = await launchProfile();
  page = await application.firstWindow();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('digitronics'));
  await page.evaluate((owner) => window.privateBrowser.switchAccountSpace(owner), account);
  expect((await getState()).downloadFolder).toEqual({ ask: false, available: true, name: 'DigiTronics fixture downloads' });
  const shownPath = join(userDataPath, 'asked-location.txt');
  await page.evaluate((owner) => window.privateBrowser.setDownloadFolderMode(owner, 'ask'), account);
  await page.evaluate((url) => window.privateBrowser.navigate(url + '/source'), target);
  const dialogPath = await application.evaluate(({ webContents }, { url, shownPath }) => new Promise<string | undefined>((resolve, reject) => {
    const source = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url + '/source');
    if (!source) { reject(new Error('Download source view is missing')); return; }
    source.session.once('will-download', (_event, item) => {
      const path = item.getSaveDialogOptions().defaultPath;
      item.setSavePath(shownPath);
      resolve(path);
    });
    source.downloadURL(url);
  }), { url: target, shownPath });
  expect(dialogPath?.toLowerCase()).toBe(realpathSync.native(existing).toLowerCase());
  await expect.poll(() => existsSync(shownPath)).toBe(true);
});

test('deletes only reviewed visits and website data in one Account Space', async () => {
  const page = await application!.firstWindow();
  const first = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Review owner', 'sky'));
  const firstUrl = origin + '/review-history-first';
  const secondUrl = origin + '/review-history-second';
  const lateUrl = origin + '/review-history-late';
  const navigate = (url: string) => page.evaluate((target) => window.privateBrowser.navigate(target), url);
  const cookie = (url: string, action: 'write' | 'count') => application!.evaluate(async ({ webContents }, { url, action }) => {
    const source = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
    if (!source) throw new Error('Disposable page is missing');
    if (action === 'write') await source.session.cookies.set({ url, name: 'review-fixture', value: 'sample' });
    return (await source.session.cookies.get({ url, name: 'review-fixture' })).length;
  }, { url, action });
  await navigate(firstUrl);
  expect(await cookie(firstUrl, 'write')).toBe(1);
  const second = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Review separate', 'rose'));
  await navigate(secondUrl);
  expect(await cookie(secondUrl, 'write')).toBe(1);
  await page.evaluate((id) => window.privateBrowser.switchAccountSpace(id), first);
  const review = await page.evaluate(({ accountSpaceId, site }) => window.privateBrowser.reviewBrowsingData({
    accountSpaceId, site, range: 'all', history: true, websiteData: true, cache: false,
  }), { accountSpaceId: first, site: origin });
  expect(review).toMatchObject({ accountSpaceId: first, siteOrigin: origin, historyCount: 1 });
  await navigate(lateUrl);
  const remove = () => page.evaluate((id) => window.privateBrowser.deleteReviewedBrowsingData(id), review.id);
  await expect(remove()).resolves.toBe(1);
  await expect(remove()).rejects.toThrow(/review the browsing data again/i);
  const history = (accountId: typeof first) => page.evaluate(async (id) => (await window.privateBrowser.queryHistory(id, {
    text: '', site: '', from: null, until: null, page: 0,
  })).entries.map((entry) => entry.url), accountId);
  expect(await history(first)).toContain(lateUrl);
  expect(await history(first)).not.toContain(firstUrl);
  expect(await cookie(lateUrl, 'count')).toBe(0);
  await page.evaluate((id) => window.privateBrowser.switchAccountSpace(id), second);
  expect(await history(second)).toContain(secondUrl);
  expect(await cookie(secondUrl, 'count')).toBe(1);
});

test('rechecks the installer after a same-size file replacement before it reaches Windows Open', async () => {
  const page = await application!.firstWindow();
  const endpoint = 'https://private-browser-downloads.digitronics-electro.workers.dev';
  const manifest = {
    schemaVersion: 1, appId: 'private-browser', version: '1.0.0', buildNumber: 5, channel: 'stable', filename: 'installer-fixture.exe',
    sizeBytes: Buffer.byteLength(installerBytes), sha256: createHash('sha256').update(installerBytes).digest('hex'),
    commitSha: 'a'.repeat(40), releaseNotes: 'Fixture', publishedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
    downloadUrl: endpoint + '/download/latest.exe?expires=1&signature=fixture', downloadPageUrl: endpoint + '/download?expires=1&signature=fixture',
  };
  await application!.evaluate(({ shell }, { endpoint, manifest }) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => String(input) === endpoint + '/api/v1/releases/public/latest'
      ? Promise.resolve(Response.json(manifest)) : originalFetch(input, init);
    Object.assign(globalThis, { fixtureOpenCount: 0 });
    shell.openPath = async () => {
      (globalThis as unknown as { fixtureOpenCount: number }).fixtureOpenCount += 1;
      return '';
    };
  }, { endpoint, manifest });
  await page.evaluate(() => window.privateBrowser.checkForUpdates());
  const target = origin + '/release-fixture';
  await page.evaluate((url) => window.privateBrowser.navigate(url + '/source'), target);
  const savePath = join(userDataPath, manifest.filename);
  await application!.evaluate(({ webContents }, { target, savePath }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target + '/source')!;
    contents.session.once('will-download', () => {
      contents.session.once('will-download', (_event, item) => item.setSavePath(savePath));
    });
    contents.downloadURL(target);
  }, { target, savePath });
  const getState = () => page.evaluate(() => window.privateBrowser.getState());
  await expect.poll(async () => (await getState()).pendingPermission?.capability).toBe('download');
  await page.evaluate((id) => window.privateBrowser.respondToPermissionPrompt(id, 'allow-once'), (await getState()).pendingPermission!.id);
  // The native publisher check can legitimately use its full 10-second budget.
  await expect.poll(async () => (await getState()).downloads[0]?.checksum, { timeout: 15_000 }).toBe('verified');
  const download = (await getState()).downloads[0];
  expect(download.publisher).toMatchObject({ state: expect.stringMatching(/unsigned|unavailable/) });
  expect(download).not.toHaveProperty('expectedInstaller');
  const open = () => page.evaluate((id) => window.privateBrowser.openDownload(id), download.id);
  await expect(open()).resolves.toBeUndefined();

  writeFileSync(savePath, Buffer.alloc(manifest.sizeBytes, 0x42));
  await expect(open()).rejects.toThrow(/changed or could not be verified/);
  expect((await getState()).downloads[0]).toMatchObject({ checksum: 'mismatch' });
  expect(await application!.evaluate(() => (globalThis as unknown as { fixtureOpenCount: number }).fixtureOpenCount)).toBe(1);
});

test('switches to an existing tab through the real address bar bridge', async () => {
  const page = await application!.firstWindow();
  const initial = await page.evaluate(() => window.privateBrowser.getState());
  await page.evaluate((url) => window.privateBrowser.navigate(url), origin);
  await expect.poll(() => page.evaluate(async () => {
    const state = await window.privateBrowser.getState();
    return state.tabs.find((tab) => tab.id === state.activeTabId)?.title;
  })).toBe('Account isolation fixture');
  await page.evaluate(() => window.privateBrowser.newTab());
  const address = page.getByRole('combobox', { name: 'Address and search bar' });
  await address.fill('isolation fixture');
  await expect(page.getByRole('option', { name: /Account isolation fixture.*Switch to tab/i })).toBeVisible();
  await address.press('ArrowDown');
  await address.press('Enter');
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then((state) => state.activeTabId)))
    .toBe(initial.activeTabId);
});

test('keeps recently closed entries local to their Account Space', async () => {
  const page = await application!.firstWindow();
  const owner = await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Closed tab owner', 'sky'));
  await page.evaluate((url) => window.privateBrowser.navigate(url), origin);
  const getState = () => page.evaluate(() => window.privateBrowser.getState());
  const original = (await getState()).activeTabId;
  await page.evaluate((id) => window.privateBrowser.closeTab(id), original);
  const [closed] = (await getState()).recentlyClosedTabs!;
  expect(closed).toMatchObject({ id: original, url: origin + '/' });
  expect(Date.parse(closed.closedAt)).toBeGreaterThan(0);
  await page.evaluate(() => window.privateBrowser.addLocalAccountSpace('personal', 'Other account', 'indigo'));
  await page.evaluate((id) => window.privateBrowser.reopenRecentTab(id), closed.id);
  expect((await getState()).recentlyClosedTabs).toEqual([]);
  expect((await getState()).tabs.filter((tab) => tab.url === closed.url)).toHaveLength(0);
  await page.evaluate((id) => window.privateBrowser.switchAccountSpace(id), owner);
  const foreground = (await getState()).activeTabId;
  await page.evaluate((id) => window.privateBrowser.reopenRecentTab(id), closed.id);
  const restored = await getState();
  expect(restored.recentlyClosedTabs).toEqual([]);
  expect(restored.activeTabId).toBe(foreground);
  expect(restored.tabs.filter((tab) => tab.url === closed.url && tab.accountSpaceId === owner)).toHaveLength(1);
});

test('keeps the default embedded-browser identity stable across the session', async () => {
  const page = await application!.firstWindow();
  const state = await page.evaluate(() => window.privateBrowser.getState());
  await page.evaluate(
    // No ERR_ABORTED allowance: the double-load race that produced it was fixed
    // (3c60646), so seeing it again is a regression, not noise.
    ({ accountSpaceId, target }) => window.privateBrowser.openInAccountSpace(accountSpaceId, target),
    { accountSpaceId: state.activeAccountSpaceId, target: origin },
  );
  await expect.poll(() => documentHeaders?.['user-agent']).toContain('Chrome/');
  const headerUserAgent = documentHeaders?.['user-agent'] ?? '';

  const rendererIdentity = await application!.evaluate(async ({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(target));
    if (!contents) throw new Error('Browser page view was not created');
    const identity = await contents.executeJavaScript(`({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData?.brands ?? []
    })`);
    return { ...identity, sessionUserAgent: contents.session.getUserAgent() };
  }, origin);
  expect(rendererIdentity.userAgent).toBe(headerUserAgent);
  expect(rendererIdentity.sessionUserAgent).toBe(headerUserAgent);
  expect(headerUserAgent).toContain('Electron/');
  expect(headerUserAgent).not.toContain('HeadlessChrome/');
  expect(rendererIdentity.brands).toEqual(expect.arrayContaining([expect.objectContaining({ brand: 'Chromium' })]));
});

test('completes the official Turnstile test-key flow in a remote page view', async () => {
  const page = await application!.firstWindow();
  const state = await page.evaluate(() => window.privateBrowser.getState());
  await page.evaluate(
    ({ accountSpaceId, target }) => window.privateBrowser.openInAccountSpace(accountSpaceId, target),
    { accountSpaceId: state.activeAccountSpaceId, target: `${origin}/turnstile` },
  );

  await expect.poll(() => application!.evaluate(async ({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target);
    if (!contents) return 0;
    return contents.executeJavaScript(`document.querySelector('[name="cf-turnstile-response"]')?.value.length ?? 0`);
  }, `${origin}/turnstile`), { timeout: 30_000 }).toBeGreaterThan(0);
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
