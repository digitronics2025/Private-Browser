import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('Electron exposes pairing only after switching to Development', async () => {
  test.skip(process.platform !== 'win32', 'Protocol v1 targets Windows 11 local workspaces.');
  const profile = await mkdtemp(join(tmpdir(), 'private-browser-electron-'));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), APPDATA: profile, LOCALAPPDATA: profile, PRIVATE_BROWSER_E2E_USER_DATA: join(profile, 'user-data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['dist-electron/main.js'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Private Browser', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /Account Space:/ }).click();
    const development = page.getByLabel('Switch to Development');
    await development.click();
    await expect(development).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    const panelToggle = page.getByRole('button', { name: 'Side panel', exact: true });
    if ((await panelToggle.getAttribute('aria-pressed')) !== 'true') await panelToggle.click();
    await page.getByRole('tab', { name: 'Developer Bridge' }).click();
    await expect(page.getByRole('heading', { name: 'Developer Bridge' })).toBeVisible();
    await page.getByRole('button', { name: 'Generate pairing code', exact: true }).click();
    await expect(page.getByLabel('Pairing code')).toHaveText(/^\d{8}$/);
    await expect(page.getByText('VS Code disconnected')).toHaveCount(0);
    await page.getByRole('button', { name: 'Cancel pairing' }).click();
    await expect(page.getByLabel('Pairing code')).toHaveCount(0);
    const status = await page.evaluate(async () => {
      const { state, pairingCode, pairingExpiresAt } = await window.privateBrowser.getBridgeStatus();
      return { state, hasCode: Boolean(pairingCode), hasExpiry: Boolean(pairingExpiresAt) };
    });
    expect(status).toEqual({ state: 'disconnected', hasCode: false, hasExpiry: false });
  } finally {
    await app.close();
  }
});
