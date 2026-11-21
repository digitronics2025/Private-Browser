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
