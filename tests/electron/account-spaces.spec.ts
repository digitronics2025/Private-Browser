import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let application: ElectronApplication | undefined;
let userDataPath: string;

test.beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'private-browser-electron-'));
  const env = { ...process.env, NODE_ENV: 'test' } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), `--user-data-dir=${userDataPath}`], env });
});

test.afterEach(async () => {
  await application?.close();
  rmSync(userDataPath, { recursive: true, force: true });
});

test('creates unique persistent partitions and isolates cookies', async () => {
  const page = await application!.firstWindow();
  await expect(page.getByRole('button', { name: /Account Space:/ })).toBeVisible();
  const [first, second] = await page.evaluate(async () => {
    const firstId = await window.privateBrowser.addLocalAccountSpace('personal', 'First', 'indigo');
    const secondId = await window.privateBrowser.addLocalAccountSpace('personal', 'Second', 'sky');
    return [firstId, secondId];
  });
  expect(first).not.toBe(second);
  const result = await application!.evaluate(async ({ session }, value) => {
    const firstSession = session.fromPartition(`persist:private-browser-account-${value.first}`);
    const secondSession = session.fromPartition(`persist:private-browser-account-${value.second}`);
    await firstSession.cookies.set({ url: 'https://example.test/', name: 'account', value: 'first', secure: true });
    return {
      first: (await firstSession.cookies.get({ url: 'https://example.test/' })).map((cookie) => cookie.value),
      second: (await secondSession.cookies.get({ url: 'https://example.test/' })).map((cookie) => cookie.value),
    };
  }, { first, second });
  expect(result.first).toEqual(['first']);
  expect(result.second).toEqual([]);
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
