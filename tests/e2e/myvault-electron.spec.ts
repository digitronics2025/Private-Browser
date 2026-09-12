import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('MyVault renderer stays metadata-only and secrets use an isolated window', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'private-browser-e2e-'));
  const launchEnv: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  launchEnv.PRIVATE_BROWSER_E2E_USER_DATA = userData;
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  const electronApp = await electron.launch({
    args: [resolve('dist-electron/main.js')],
    env: launchEnv,
  });

  try {
    const page = await electronApp.firstWindow();
    await expect(page.getByRole('button', { name: 'Open MyVault' })).toBeVisible();
    await page.getByRole('button', { name: 'Open MyVault' }).click();
    await expect(page.getByText('Connection required')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);

    const secureWindowPromise = electronApp.waitForEvent('window');
    await page.getByRole('button', { name: 'Connect with one-time code' }).click();
    const secureWindow = await secureWindowPromise;
    await expect(secureWindow.getByRole('heading', { name: 'Connect MyVault' })).toBeVisible();
    await expect(secureWindow.getByLabel('Master password')).toHaveAttribute('type', 'password');
    await expect(secureWindow.getByLabel('One-time enrollment code')).toBeVisible();
    const devToolsOpened = await electronApp.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return windows.some((window) => window.getTitle() === 'Connect MyVault' && window.webContents.isDevToolsOpened());
    });
    expect(devToolsOpened).toBe(false);
    const secureClosePromise = secureWindow.waitForEvent('close');
    await secureWindow.getByRole('button', { name: 'Cancel' }).click();
    await secureClosePromise;

    await page.getByRole('button', { name: 'Development' }).click();
    await expect(page.getByRole('button', { name: 'Open MyVault' })).toHaveCount(0);
  } finally {
    await electronApp.close();
    await rm(userData, { recursive: true, force: true });
  }
});
