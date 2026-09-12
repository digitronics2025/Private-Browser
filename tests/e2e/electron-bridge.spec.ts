import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

test('Electron exposes pairing only after switching to Development', async () => {
  test.skip(process.platform !== 'win32', 'Protocol v1 targets Windows 11 local workspaces.');
  const profile = await mkdtemp(join(tmpdir(), 'private-browser-electron-'));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), APPDATA: profile, LOCALAPPDATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['dist-electron/main.js'], env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByText('Private Browser', { exact: true }).first()).toBeVisible();
    await page.getByLabel('Switch to Development').click();
    await page.getByTitle('Developer cockpit').click();
    await expect(page.getByRole('heading', { name: 'Developer Bridge' })).toBeVisible();
    await page.getByRole('button', { name: 'Pair', exact: true }).click();
    await expect(page.getByText(/Pair with \d{8}/)).toBeVisible();
    await expect(page.getByText('VS Code disconnected')).toHaveCount(0);
  } finally {
    await app.close();
  }
});
