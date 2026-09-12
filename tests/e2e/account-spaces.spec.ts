import { expect, test } from '@playwright/test';

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
  await page.getByRole('button', { name: 'Vault', exact: true }).click();
  await expect(page.getByText('Saved logins autofill matching HTTPS sign-in pages.')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
