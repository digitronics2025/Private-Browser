import { expect, test } from '@playwright/test';

test('verifies a recovery code before presenting an optional, scoped restore', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?backupRestore=sample');
  await page.getByRole('button', { name: 'Account Space: Operations' }).click();
  await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
  const backup = page.getByRole('region', { name: 'Restore an encrypted backup' });
  const root = page.locator('html');
  const load = async (code: string) => {
    await backup.getByLabel('Recovery code').fill(code);
    await backup.getByRole('button', { name: 'Verify and preview backup' }).click();
  };
  await load('invalid-fixture-code');
  await expect(backup.getByRole('alert')).toContainText('failed authentication');
  await expect(backup.getByLabel('Recovery code')).toHaveValue('');
  await load('fixture-recovery-code');
  await expect(backup.getByText('Operations · Personal')).toBeVisible();
  await expect(backup.locator('time')).toHaveAttribute('datetime', '2026-11-21T12:00:00.000Z');
  await expect(backup.getByRole('row', { name: 'Bookmarks 2 1 0' })).toBeVisible();
  await expect(root).not.toHaveAttribute('data-preview-backup-applied', /./);
  await backup.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(root).not.toHaveAttribute('data-preview-backup-applied', /./);
  await load('fixture-recovery-code');
  await backup.getByRole('button', { name: 'Add reviewed items' }).click();
  await expect(root).toHaveAttribute('data-preview-backup-applied', /./);
  await expect(page.getByText('Backup items added to Operations')).toBeVisible();
});
