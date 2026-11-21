import { expect, test } from '@playwright/test';

for (const setup of ['enrolled', 'unenrolled'] as const) {
  test('shows the recovery guide for the ' + setup + ' Windows Hello preview', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 810 });
    await page.goto('/?vaultGuide=' + setup);
    await page.getByRole('button', { name: 'Side panel', exact: true }).click();
    await page.getByRole('tab', { name: 'Vault', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Side panel' });
    const summary = panel.getByText('Setup and recovery', { exact: true });
    await summary.focus();
    await summary.press('Enter');
    await expect(panel.getByText('Enrollment code expired')).toBeVisible();
    await expect(panel.getByText('Master password forgotten')).toBeVisible();
    await expect(panel.getByText('Offline', { exact: true })).toBeVisible();
    await expect(panel.getByText('Device access revoked')).toBeVisible();
    await expect(panel.getByText('Website passkeys')).toBeVisible();
    await expect(panel.getByText(/Windows Security prompt for the device, phone or security key/)).toBeVisible();
    await expect(panel.getByText(/Settings → Accounts → Passkeys/)).toBeVisible();
    await expect(panel.locator('input[type=password]')).toHaveCount(0);
    if (setup === 'enrolled') {
      await expect(panel.getByRole('button', { name: 'Unlock with Windows Hello' })).toBeVisible();
      await expect(panel.getByText(/Hello is enrolled/)).toBeVisible();
    } else {
      await expect(panel.getByRole('button', { name: 'Unlock in secure window' })).toBeVisible();
      await expect(panel.getByText(/If Hello is available after unlocking/)).toBeVisible();
    }
  });
}

test('shows a next action when there is no matching sign-in', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?vaultFill=no-match');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Vault', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  const status = panel.getByRole('status').filter({ hasText: 'No matching sign-in' });
  await expect(status).toContainText('Choose Add login or save the login from this website.');
  await expect(panel.locator('input[type=password]')).toHaveCount(0);
});
