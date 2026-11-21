import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let application: ElectronApplication | undefined;
let userDataPath: string;
let origin: string;
let server: Server;
let documentHeaders: IncomingHttpHeaders | undefined;
const installerBytes = 'local installer fixture';

test.beforeEach(async () => {
  documentHeaders = undefined;
  server = createServer((request, response) => {
    if (request.url === '/') documentHeaders = request.headers;
    response.setHeader('Cache-Control', 'public, max-age=3600');
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
  await application!.evaluate(({ webContents }, { target, savePath }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === target + '/source');
    if (!contents) throw new Error('Download source view is missing');
    // The initial request is stopped for permission. Set a path only on its granted retry.
    contents.session.once('will-download', () => {
      contents.session.once('will-download', (_event, item) => item.setSavePath(savePath));
    });
    contents.downloadURL(target);
  }, { target, savePath });
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
  await expect.poll(async () => (await getState()).downloads[0]?.checksum).toBe('verified');
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
