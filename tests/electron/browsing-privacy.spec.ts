import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultState } from '../../electron/state-store';

const passphrase = 'Isolated Windows browsing archive fixture';

test('encrypts an existing Windows profile and restores its portable file in a clean profile', async () => {
  test.skip(process.platform !== 'win32', 'Uses Windows device encryption');
  const root = mkdtempSync(join(tmpdir(), 'private-browser-browsing-privacy-'));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const archive = join(root, 'portable.pbbr');
  const fixture = createServer((_request, response) => response.end('<title>Portable browsing fixture</title><p>Local document</p>'));
  let app: ElectronApplication | undefined;
  const launch = async (profile: string) => {
    const env = { ...process.env, LOCALAPPDATA: join(profile, 'local') } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const instance = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), '--user-data-dir=' + profile, '--no-proxy-server'], env });
    app = instance;
    await instance.evaluate(({ dialog }, archivePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: archivePath });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [archivePath] });
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    }, archive);
    return instance.firstWindow();
  };
  const state = (page: Page) => page.evaluate(() => window.privateBrowser.getState());
  const settings = async (page: Page) => {
    await page.getByRole('button', { name: 'Browser menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Browsing privacy', exact: true })).toBeVisible();
  };
  const enterPassphrase = async (page: Page, exporting: boolean) => {
    const opened = app!.waitForEvent('window');
    await page.getByRole('button', { name: exporting ? 'Export recovery file' : 'Restore recovery file', exact: true }).click();
    const secure = await opened;
    await secure.getByLabel('Recovery passphrase', { exact: true }).fill(passphrase);
    if (exporting) await secure.getByLabel('Repeat passphrase').fill(passphrase);
    await secure.getByRole('button', { name: 'Continue', exact: true }).click();
  };
  try {
    fixture.listen(0, '127.0.0.1');
    await once(fixture, 'listening');
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Browsing fixture could not bind to loopback');
    const url = `http://127.0.0.1:${address.port}/private-document`;
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'browser-state.json'), JSON.stringify(createDefaultState()));
    const original = await launch(source);
    await expect(original.getByRole('main', { name: 'New Tab' })).toBeVisible();
    const id = (await state(original)).activeAccountSpaceId;
    const current = join(source, 'account-browsing', `${id}.json`);
    await original.evaluate((target) => window.privateBrowser.navigate(target), url);
    await expect.poll(() => state(original).then(({ history }) => history.some((entry) => entry.url === url))).toBe(true);
    await original.evaluate(() => window.privateBrowser.toggleBookmark());
    expect(readFileSync(current, 'utf8')).toContain(url);
    await settings(original);
    await enterPassphrase(original, true);
    await expect(original.getByText('Encrypted recovery file saved.', { exact: true })).toBeVisible();
    expect(readFileSync(archive, 'utf8')).not.toContain(url);
    await original.getByRole('button', { name: 'Enable browsing encryption', exact: true }).click();
    await expect(original.getByText('Local browsing encryption is on.', { exact: true })).toBeVisible();
    const encrypted = readFileSync(current);
    expect(encrypted.toString()).not.toContain(url);
    await app!.close();
    const restarted = await launch(source);
    await expect.poll(() => state(restarted).then(({ bookmarks }) => bookmarks.some((entry) => entry.url === url))).toBe(true);
    await app!.close();
    const diskDigest = () => createHash('sha256').update(readFileSync(current)).digest('hex');
    const beforeLoss = diskDigest();
    writeFileSync(join(source, 'browsing-device-key.json'), 'unavailable Windows key fixture');
    const recovery = await launch(source);
    await expect.poll(() => state(recovery).then(({ recovery }) => recovery?.accountSpaceId)).toBe(id);
    expect(diskDigest()).toBe(beforeLoss);
    await app!.close();
    const restored = await launch(destination);
    await expect(restored.getByRole('main', { name: 'New Tab' })).toBeVisible();
    await settings(restored);
    await expect(restored.getByText('Local browsing encryption is on.', { exact: true })).toBeVisible();
    await enterPassphrase(restored, false);
    await expect(restored.getByText('Browsing data merged.', { exact: true })).toBeVisible();
    const result = await state(restored);
    expect(result.activeAccountSpaceId).not.toBe(id);
    expect(result.bookmarks.find((entry) => entry.url === url)?.accountSpaceId).toBe(result.activeAccountSpaceId);
    expect(result.history.find((entry) => entry.url === url)?.accountSpaceId).toBe(result.activeAccountSpaceId);
  } finally {
    await app?.close().catch(() => undefined);
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
