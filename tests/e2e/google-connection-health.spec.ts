import { expect, test } from '@playwright/test';

test('shows last success and quota delay for the selected account', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?googleHealth=quota');
  await page.getByRole('button', { name: 'Account Space: Operations' }).click();
  await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
  const manager = page.getByRole('dialog', { name: 'Account Spaces' });
  const health = manager.getByRole('status').filter({ hasText: 'Google quota delay' });
  await expect(health.getByText('Selected Account Space · Operations')).toBeVisible();
  await expect(health.locator('time')).toHaveAttribute('datetime', '2026-11-21T12:00:00Z');
  await expect(health.getByText(/Try again after/)).toBeVisible();
  await manager.getByRole('button', { name: 'Personal Local only' }).click();
  await expect(manager.getByRole('status').filter({ hasText: 'Google tools are disconnected' })).toContainText('Selected Account Space · Personal');
  await expect(health).toHaveCount(0);
});

test('reviews Google tools and website data actions for the selected Account Space', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  const confirmations: string[] = [];
  page.on('dialog', (dialog) => { confirmations.push(dialog.message()); void dialog.accept(); });
  const openOverview = async () => {
    await page.goto('/?googleHealth=quota');
    await page.getByRole('button', { name: 'Account Space: Operations' }).click();
    await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
    const overview = page.getByRole('region', { name: 'Account access overview' });
    await overview.getByText('Manage access and website data', { exact: true }).click();
    return overview;
  };
  const overview = await openOverview();
  await expect(overview).toContainText('Session data present');
  await expect(overview).toContainText('Profile identity, Gmail overview, Drive app files, Calendar read');
  await expect(overview).toContainText('Encrypted backup');
  await overview.getByRole('button', { name: 'Clear website data and history' }).click();
  await expect(overview).toContainText('Not visited');
  await expect(overview).toContainText('Gmail overview');
  await overview.getByRole('button', { name: 'Disconnect Google tools on this PC' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-preview-google-access', 'disconnect');
  await expect(overview.getByText('None', { exact: true })).toBeVisible();

  const refreshed = await openOverview();
  await refreshed.getByRole('button', { name: 'Revoke Google access' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-preview-google-access', 'revoke');
  await expect(refreshed).toContainText('Session data present');
  expect(confirmations).toHaveLength(3);
  expect(confirmations[0]).toContain('Operations');
  expect(confirmations[1]).toContain('operations@example.com');
  expect(confirmations[2]).toContain('operations@example.com');
});
