import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { once } from 'node:events';
import {
  FrameDecoder, PROTOCOL_VERSION, encodeFrame, generateEphemeralKeyPair, generateIdentity, helloTranscript,
  signText, verifyText, welcomeSchema, welcomeTranscript,
} from '@private-browser/bridge-protocol';
import { createEmptyVaultPayload, createVault, serializeVaultArchive } from '../../electron/myvault/security/vault-crypto';

const password = 'Disposable packaged smoke password'; // secret-guard:allow — inert fixture
const sampleName = 'private-browser-smoke.txt';
const sampleBytes = 'Packaged Windows smoke test sample.\n';

function pairFixtureClient(local: string, pairingCode: string, appVersion: string) {
  const rendezvous = JSON.parse(readFileSync(join(local, 'Private Browser Bridge', 'rendezvous.json'), 'utf8')) as {
    pipePath: string; challenge: string; browserIdentityPublicKey: string;
  };
  expect(rendezvous.pipePath).toMatch(/^\\\\\.\\pipe\\private-browser-[0-9a-f-]{36}$/);
  const identity = generateIdentity();
  const ephemeral = generateEphemeralKeyPair();
  const unsigned = {
    kind: 'hello' as const, minVersion: PROTOCOL_VERSION, maxVersion: PROTOCOL_VERSION,
    deviceId: randomUUID(), instanceId: randomUUID(), extensionVersion: '0.0.1', vscodeVersion: '1.99.0',
    identityPublicKey: identity.publicKey, ephemeralPublicKey: ephemeral.publicKey, challenge: rendezvous.challenge, pairingCode,
  };
  const hello = { ...unsigned, signature: signText(identity.privateKey, helloTranscript(unsigned)) };
  const socket = connect(rendezvous.pipePath);
  const welcome = new Promise<void>((resolve, reject) => {
    const decoder = new FrameDecoder();
    socket.setTimeout(5_000, () => socket.destroy(new Error('The installed app did not answer the fixture bridge client')));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('The fixture bridge connection closed before pairing')));
    socket.on('data', (chunk) => {
      try {
        const [frame] = decoder.push(chunk);
        if (!frame) return;
        const reply = welcomeSchema.parse(frame);
        const { signature, ...transcript } = reply;
        expect(reply.browserVersion).toBe(appVersion);
        expect(reply.browserIdentityPublicKey).toBe(rendezvous.browserIdentityPublicKey);
        expect(verifyText(reply.browserIdentityPublicKey, welcomeTranscript(hello, transcript), signature)).toBe(true);
        socket.setTimeout(0);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('connect', () => socket.write(encodeFrame(hello)));
  });
  return { socket, welcome };
}

test('runs the operator journey on the packaged Windows binary', async () => {
  const binary = process.env.PRIVATE_BROWSER_PACKAGED_EXE;
  const appVersion = process.env.PRIVATE_BROWSER_PACKAGED_VERSION;
  if (process.platform !== 'win32' || !binary || !isAbsolute(binary) || !appVersion) {
    throw new Error('Use the Windows installer smoke workflow or specify the absolute packaged executable and its version.');
  }
  expect(binary).toMatch(/[\\/]Private Browser\.exe$/i);
  expect(existsSync(join(dirname(binary), 'resources', 'app.asar'))).toBe(true);
  expect(existsSync(join(dirname(binary), 'resources', 'private-browser-update.json'))).toBe(false);

  const root = mkdtempSync(join(tmpdir(), 'private-browser-packaged-smoke-'));
  const profile = join(root, 'profile');
  const local = join(root, 'local');
  const roaming = join(root, 'roaming');
  const chromeProfile = join(local, 'Google', 'Chrome', 'User Data', 'Default');
  let browser: Browser | undefined;
  let chrome: Page | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let fileRequests = 0;
  let launchError: Error | undefined;
  const server = createServer((request, response) => {
    if (request.url === '/download') {
      fileRequests += 1;
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename=' + sampleName });
      response.end(sampleBytes);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>Packaged browser fixture</title><a href="/download">Download test file</a>');
  });
  try {
    let origin = '';
    await test.step('Launch the installed app with a disposable profile', async () => {
      for (const directory of [join(profile, 'myvault'), chromeProfile, roaming]) mkdirSync(directory, { recursive: true });
      writeFileSync(join(chromeProfile, 'Bookmarks'), JSON.stringify({
        roots: { bookmark_bar: { children: [{ type: 'url', name: 'Packaged smoke bookmark', url: 'https://example.test/smoke' }] } },
      }));
      const { envelope } = await createVault(password, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
      writeFileSync(join(profile, 'myvault', 'envelope.myvault'), serializeVaultArchive(envelope));
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('The fixture did not bind to loopback');
      origin = 'http://127.0.0.1:' + address.port;
      const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: local, APPDATA: roaming, VITE_DEV_SERVER_URL: 'https://example.invalid/' };
      for (const key of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'VITE_DEV_SERVER_URL', 'PRIVATE_BROWSER_E2E_USER_DATA'] as const) delete env[key];
      child = spawn(binary, [
        '--user-data-dir=' + profile, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-proxy-server',
      ], { env, stdio: 'ignore', windowsHide: true });
      child.once('error', (error) => { launchError = error; });
      const portFile = join(profile, 'DevToolsActivePort');
      await expect.poll(() => {
        if (launchError) throw launchError;
        if (child?.exitCode !== null) throw new Error('The installed app closed before starting its trusted window');
        return existsSync(portFile);
      }, { timeout: 12_000 }).toBe(true);
      const [port] = readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (!/^[1-9]\d{0,4}$/.test(port)) throw new Error('Invalid disposable debugging port');
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 10_000, noDefaults: true });
      await expect.poll(() => {
        chrome = browser?.contexts().flatMap((context) => context.pages()).find((page) => page.url().startsWith('file:') && page.url().endsWith('/dist/index.html'));
        return Boolean(chrome);
      }, { timeout: 12_000 }).toBe(true);
      await expect(chrome!.getByRole('searchbox', { name: /search|enter address/i }).or(chrome!.getByRole('textbox', { name: /search|enter address/i })).first()).toBeVisible();
      expect(await chrome!.evaluate(() => window.privateBrowser.getUpdateService().then(({ currentVersion }) => currentVersion))).toBe(appVersion);
      expect(existsSync(join(profile, 'browser-state-v2.json'))).toBe(true);
    });
    const page = chrome!;
    const state = () => page.evaluate(() => window.privateBrowser.getState());

    await test.step('Switch workspace and import the reviewed disposable Chrome bookmark', async () => {
      await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
      const { activeAccountSpaceId } = await state();
      const reviewed = await page.evaluate((accountSpaceId) => window.privateBrowser.previewChromeImport({
        profileId: 'Default', workspaceId: 'personal', accountSpaceId, bookmarks: true, history: false,
      }), activeAccountSpaceId);
      expect(reviewed.result.imported.bookmarks).toBe(1);
      expect((await state()).bookmarks).toHaveLength(0);
      await page.evaluate((id) => window.privateBrowser.confirmChromeImport(id), reviewed.id);
      expect((await state()).bookmarks).toEqual([expect.objectContaining({ title: 'Packaged smoke bookmark' })]);
    });

    await test.step('Unlock the encrypted fixture through the secure MyVault dialog', async () => {
      const context = page.context();
      const dialog = context.waitForEvent('page');
      const unlocking = page.evaluate(() => window.privateBrowser.requestVaultUnlock());
      const secure = await dialog;
      await secure.getByLabel('Master password').fill(password);
      await secure.getByRole('button', { name: /unlock/i }).click();
      expect((await unlocking).lifecycle).toBe('unlocked');
    });

    const pageAt = async (url: string) => {
      await page.evaluate((target) => window.privateBrowser.navigate(target), url);
      let site: Page | undefined;
      await expect.poll(() => {
        site = browser?.contexts().flatMap((context) => context.pages()).find((item) => item.url() === url);
        return Boolean(site);
      }, { timeout: 10_000 }).toBe(true);
      return site!;
    };

    await test.step('Keep Banking separate and block its download', async () => {
      await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
      const site = await pageAt(origin + '/banking');
      await expect(site.getByRole('link', { name: 'Download test file' })).toBeVisible();
      const banking = await state();
      expect(banking.activeWorkspaceId).toBe('banking');
      expect(banking.bookmarks).toHaveLength(0);
      await site.getByRole('link', { name: 'Download test file' }).evaluate((link) => (link as HTMLAnchorElement).click());
      await expect.poll(() => fileRequests).toBe(1);
      await expect.poll(() => state().then(({ privacyLog }) => privacyLog.some(({ title }) => title === 'Download blocked in Banking'))).toBe(true);
      expect((await state()).pendingPermission).toBeUndefined();
      expect((await state()).downloads).toHaveLength(0);
    });

    await test.step('Approve and cancel a sample download in a regular Account Space', async () => {
      await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
      const site = await pageAt(origin + '/regular');
      await site.getByRole('link', { name: 'Download test file' }).evaluate((link) => (link as HTMLAnchorElement).click());
      await expect.poll(() => state().then(({ pendingPermission }) => pendingPermission?.capability)).toBe('download');
      const prompt = (await state()).pendingPermission!;
      await page.evaluate((id) => window.privateBrowser.respondToPermissionPrompt(id, 'allow-once'), prompt.id);
      const download = () => state().then(({ downloads }) => downloads.find(({ filename }) => filename === sampleName));
      await expect.poll(download).toMatchObject({ state: 'progressing' });
      const id = (await download())!.id;
      await page.evaluate((downloadId) => window.privateBrowser.controlDownload(downloadId, 'cancel'), id);
      await expect.poll(download).toMatchObject({ state: 'cancelled' });
    });

    await test.step('Pair the installed bridge through its actual Windows named pipe', async () => {
      await page.evaluate(() => window.privateBrowser.switchWorkspace('development'));
      await expect(page.evaluate(() => window.privateBrowser.requestVaultUnlock())).rejects.toThrow(/unavailable/i);
      const pairing = await page.evaluate(() => window.privateBrowser.beginBridgePairing());
      expect(pairing.pairingCode).toMatch(/^\d{8}$/);
      const client = pairFixtureClient(local, pairing.pairingCode!, appVersion);
      try {
        await client.welcome;
        await expect.poll(() => page.evaluate(() => window.privateBrowser.getBridgeStatus().then(({ state }) => state))).toBe('connected');
      } finally {
        client.socket.destroy();
      }
    });

    await test.step('Read and validate the public release manifest through the installed updater', async () => {
      await page.evaluate(() => window.privateBrowser.switchWorkspace('personal'));
      const check = await page.evaluate(async () => {
        const { currentVersion, state, latest } = await window.privateBrowser.checkForUpdates();
        return { currentVersion, state, stable: latest.channel, checksum: latest.sha256 };
      });
      expect(check.currentVersion).toBe(appVersion);
      expect(['available', 'up-to-date']).toContain(check.state);
      expect(check.stable).toBe('stable');
      expect(check.checksum).toMatch(/^[a-f0-9]{64}$/);
    });
  } finally {
    if (chrome && !chrome.isClosed()) await chrome.evaluate(() => { void window.privateBrowser.quit(); }).catch(() => undefined);
    await browser?.close().catch(() => undefined);
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      const force = setTimeout(() => child?.kill(), 3_000);
      try { await exited; } finally { clearTimeout(force); }
    }
    if (server.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  }
});
