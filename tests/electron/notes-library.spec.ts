import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

// Only a local real notes Worker may receive mutation tests. Start the sibling
// repository's Worker and set this variable; production URLs are refused.
const notesUrl = process.env.PRIVATE_BROWSER_E2E_NOTES_WORKER_URL;
const local = notesUrl && new URL(notesUrl);
test.skip(!local || local.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(local.hostname), 'Requires an isolated local Easy Copy Notes Worker');
let app: ElectronApplication;
let profile: string;
let notes: Page;
let shell: Page;
const exact = '  First line\nمرحبا 😊\nDernière ligne  \n';
const title = `Native notes ${Date.now()}`;
const card = () => notes.getByRole('article').filter({ has: notes.getByText(title, { exact: true }) });
const copied = () => app.evaluate(({ clipboard }) => clipboard.readText());
const options = () => notes.getByRole('button', { name: 'Library options', exact: true }).click();

test.beforeAll(async () => {
  profile = mkdtempSync(join(tmpdir(), 'private-browser-notes-library-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'));
  delete env.ELECTRON_RUN_AS_NODE;
  Object.assign(env, { PRIVATE_BROWSER_E2E_USER_DATA: profile, PRIVATE_BROWSER_E2E_NOTES_URL: `${notesUrl}/?surface=browser` });
  app = await electron.launch({ args: [resolve('tests/electron/fixtures/notes-host.mjs'), '--no-proxy-server'], env });
  await app.firstWindow();
  await expect.poll(() => app.context().pages().some(p => p.url().endsWith('/reply'))).toBe(true);
  shell = app.context().pages().find(p => p.url().endsWith('/reply'))!;
  await expect.poll(() => app.context().pages().some(p => p.url().startsWith(notesUrl!))).toBe(true);
  notes = app.context().pages().find(p => p.url().startsWith(notesUrl!))!;
  await expect(notes.getByRole('searchbox', { name: 'Search library' })).toBeVisible();
});
test.afterAll(async () => { await app?.close(); if (profile) rmSync(profile, { recursive: true, force: true }); });

test('real Notes view: exact copy, paste beside it, multilingual filling, CRUD, backup import and offline shell', async () => {
  const prefs = await app.evaluate(({ webContents }) => {
    const remote = webContents.getAllWebContents().find(c => c.session.storagePath?.includes('side-app-easynote'))!;
    return (remote as Electron.WebContents & { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences();
  });
  expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  expect(prefs.preload).toBeUndefined();
  expect(await notes.evaluate(() => [typeof (window as any).require, typeof (window as any).process, typeof (window as any).privateBrowser])).toEqual(['undefined', 'undefined', 'undefined']);
  await notes.getByRole('button', { name: 'New Snippet', exact: true }).click();
  await notes.getByLabel('Title', { exact: false }).fill(title);
  await notes.getByLabel('Variant content').fill(exact);
  await notes.getByRole('button', { name: 'Create Snippet', exact: true }).click();
  await notes.getByRole('searchbox', { name: 'Search library' }).fill(title);
  await card().getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(copied).toBe(exact);
  // The app itself never receives general clipboard-read permission.
  expect(await notes.evaluate(async () => { try { await navigator.clipboard.readText(); return true; } catch { return false; } })).toBe(false);
  await shell.getByRole('textbox', { name: 'Webpage reply' }).click();
  await shell.keyboard.press('Control+V');
  await expect(shell.getByRole('textbox')).toHaveValue(exact);
  await card().getByTitle('More actions', { exact: true }).click();
  await notes.getByRole('button', { name: 'Edit Snippet', exact: true }).click();
  await notes.getByLabel('Variant content').fill('  مرحبا {{name}} 😊\n');
  await notes.getByRole('button', { name: 'Save Changes', exact: true }).click();
  await card().getByRole('button', { name: 'Fill & Copy', exact: true }).click();
  await notes.getByLabel('name', { exact: true }).fill('أمينة');
  await notes.getByRole('button', { name: 'Copy Resolved', exact: true }).click();
  await expect.poll(copied).toBe('  مرحبا أمينة 😊\n');
  await card().getByTitle('More actions', { exact: true }).click();
  await notes.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await card().getByTitle('More actions', { exact: true }).click();
  await notes.getByRole('button', { name: 'Pin to Favorites', exact: true }).click();
  await options(); await notes.getByRole('button', { name: 'Backup & Restore', exact: true }).click();
  // Use Electron's native download path without opening an OS save dialog.
  const downloadPath = join(profile, 'notes-backup.json');
  await app.evaluate(({ session }, path) => {
    session.fromPartition('persist:private-browser-side-app-easynote').once('will-download', (_e, item) => item.setSavePath(path));
  }, downloadPath);
  await notes.getByRole('button', { name: 'Download JSON Backup', exact: true }).click();
  const { existsSync } = await import('node:fs');
  await expect.poll(() => existsSync(downloadPath)).toBe(true);
  await notes.locator('input[type="file"]').setInputFiles(downloadPath);
  await expect(notes.getByText('Import Completed Successfully')).toBeVisible();
  await notes.keyboard.press('Escape');
  await notes.evaluate(async () => { await navigator.serviceWorker.ready; });
  await app.evaluate(({ session }) => session.fromPartition('persist:private-browser-side-app-easynote').enableNetworkEmulation({ offline: true }));
  await notes.reload();
  await expect(notes.locator('[data-surface="browser"]')).toBeVisible();
  await notes.getByRole('searchbox', { name: 'Search library' }).fill(title);
  await card().getByRole('button', { name: 'Fill & Copy', exact: true }).click();
  await notes.getByLabel('name', { exact: true }).fill('Offline');
  await notes.getByRole('button', { name: 'Copy Resolved', exact: true }).click();
  await expect.poll(copied).toBe('  مرحبا Offline 😊\n');
  await app.evaluate(({ session }) => session.fromPartition('persist:private-browser-side-app-easynote').disableNetworkEmulation());
});
