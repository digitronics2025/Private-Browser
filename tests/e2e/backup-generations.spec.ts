import { expect, test } from '@playwright/test';

test('shows backup generations and waits for a decision before resolving a conflict', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.clock.install({ time: new Date('2026-11-21T10:00:00Z') });
  await page.goto('/?backupGenerations=sample');
  const notice = page.getByRole('region', { name: 'Backup reminder' });
  await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();
  await expect(notice).toBeHidden();
  await page.clock.fastForward(61_000);
  await notice.getByRole('button', { name: 'Manage backup' }).click();
  const backup = page.getByRole('region', { name: 'Manage encrypted backups' });
  await backup.getByRole('button', { name: 'Review backup' }).click();
  const table = backup.getByRole('table', { name: 'What each backup contains' });
  await expect(table.getByRole('row', { name: /Latest upload.*5/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /After merge.*6/ })).toBeVisible();
  await expect(table.getByRole('row', { name: /Earlier backup/ })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-preview-backup-resolution');
  await backup.getByRole('button', { name: 'Merge and save' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-preview-backup-resolution', 'merge');

  const restore = page.getByRole('region', { name: 'Restore an encrypted backup' });
  await restore.getByRole('button', { name: 'Verify and preview backup' }).click();
  await restore.getByLabel('Backup generation').selectOption({ value: '2026-11-09T12:00:00.000Z' });
  await restore.getByRole('button', { name: 'Verify and preview backup' }).click();
  await expect(restore.locator('time')).toHaveAttribute('datetime', '2026-11-09T12:00:00.000Z');
  await expect(page.locator('html')).not.toHaveAttribute('data-preview-backup-applied');
});
