import { expect, test } from '@playwright/test';

test('reviews and revokes a current-site grant and filters grants in Account Manager', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?permissions=sample');
  await page.evaluate(() => window.privateBrowser.navigate('https://example.test/notes'));
  await page.getByRole('button', { name: 'View site information' }).click();
  const site = page.getByRole('dialog', { name: 'Site information' });
  const summary = site.getByText('Site permissions', { exact: true });
  await summary.focus();
  await summary.press('Enter');
  await expect(site.getByText('Grant allowed · Until revoked')).toBeVisible();
  await site.getByRole('button', { name: 'Revoke Downloads' }).click();
  await expect(site.getByRole('status')).toHaveText('Downloads revoked. The site will ask again.');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Account Space: Operations' }).click();
  await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
  const manager = page.getByRole('dialog', { name: 'Account Spaces' });
  await manager.getByText('Site permission grants', { exact: true }).click();
  await expect(manager.getByText('https://mail.google.com', { exact: true })).toBeVisible();
  await manager.getByLabel('Filter by origin').fill('example.test');
  await expect(manager.getByText('No grants match your filters.')).toBeVisible();
  await manager.getByLabel('Filter by origin').fill('mail.google');
  await manager.getByLabel('Filter by capability').selectOption('camera');
  await expect(manager.getByText('No grants match your filters.')).toBeVisible();
  await manager.getByLabel('Filter by capability').selectOption('notifications');
  await expect(manager.getByText('Notifications · This session')).toBeVisible();
});

test('switches and manages Account Spaces without leaking visible state', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Account Space: Operations' })).toBeVisible();
  await page.getByRole('button', { name: 'Account Space: Operations' }).click();
  await expect(page.getByRole('menu', { name: 'Account Spaces' })).toBeVisible();
  await page.getByRole('menuitemradio', { name: /Personal Local browsing only/ }).click();
  await expect(page.getByRole('button', { name: 'Account Space: Personal' })).toBeVisible();
  await expect(page.getByText('Google Drive')).toHaveCount(0);
  await page.getByRole('button', { name: 'Account Space: Personal' }).click();
  await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
  await expect(page.getByRole('dialog', { name: 'Account Spaces' })).toBeVisible();
  await expect(page.getByText('Website status: not visited · API status: disconnected.')).toBeVisible();
});

test('keeps the manager usable at mobile width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Account Space: Operations' }).click();
  await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Account Spaces' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close Account Space manager' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Operations operations@example.com' })).toBeVisible();
});

test('shows the Chrome-style autofill state in the vault panel without preview errors', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.goto('/');
  await page.getByRole('button', { name: 'Open MyVault' }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await expect(panel.getByRole('tab', { name: 'Vault' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Saved logins autofill matching HTTPS sign-in pages.')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
