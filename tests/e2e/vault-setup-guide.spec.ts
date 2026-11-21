import { expect, test } from '@playwright/test';

test('reviews synthetic Chrome password skips and shows CSV cleanup after import', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?chromePassword=sample');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.getByRole('tab', { name: 'MyVault', exact: true }).click();
  await page.getByRole('button', { name: 'Import Chrome password CSV' }).click();
  const wizard = page.getByRole('region', { name: 'Import Chrome passwords' });
  await expect(wizard.getByText(/find Export passwords and choose Download file/)).toBeVisible();
  await wizard.getByRole('button', { name: 'Choose password CSV' }).click();
  await expect(wizard.getByRole('status')).toHaveText('1 of 3 entries ready to import into MyVault.');
  await wizard.getByText('Review skipped entries', { exact: true }).click();
  await expect(wizard.getByText('https://shop.example.test · sample@example.test')).toBeVisible();
  await expect(wizard.getByText('Entry 3 · Unsupported website or app address')).toBeVisible();
  await expect(wizard.locator('input')).toHaveCount(0);
  await wizard.getByRole('button', { name: 'Import reviewed logins' }).click();
  await expect(wizard.getByRole('status')).toHaveText('1 login added to MyVault.');
  await expect(wizard.getByText(/delete the CSV from its folder/)).toBeVisible();
});

test('reviews a synthetic health finding at a narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?vaultHealth=sample');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.getByRole('tab', { name: 'MyVault', exact: true }).click();
  const health = page.getByRole('region', { name: 'Login health' });
  await health.getByRole('button', { name: 'Check login health' }).click();
  await expect(health.getByRole('status')).toHaveText('1 login to review. 1 checked.');
  await expect(health.getByText('Password is short or repeats one character')).toBeVisible();
  await health.getByRole('button', { name: 'Edit Sample login' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Open the desktop app to edit a login' })).toBeVisible();
});

for (const setup of ['enrolled', 'unenrolled'] as const) {
  test('shows the recovery guide for the ' + setup + ' Windows Hello preview', async ({ page }) => {
    await page.setViewportSize({ width: 430, height: 810 });
    await page.goto('/?vaultGuide=' + setup);
    await page.getByRole('button', { name: 'Side panel', exact: true }).click();
    await page.getByRole('tab', { name: 'MyVault', exact: true }).click();
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
  await page.getByRole('tab', { name: 'MyVault', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  const status = panel.getByRole('status').filter({ hasText: 'No matching sign-in' });
  await expect(status).toContainText('Choose Add login or save the login from this website.');
  await expect(panel.locator('input[type=password]')).toHaveCount(0);
});

test('shows a clipboard countdown and lets the user clear a synthetic copy', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.getByRole('tab', { name: 'MyVault', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Password', exact: true }).click();
  await expect(panel.getByText(/Vault clipboard clears in \d+s/)).toBeVisible();
  await panel.getByRole('button', { name: 'Clear now', exact: true }).click();
  await expect(page.getByText('Vault copy cleared', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Clear now', exact: true })).toHaveCount(0);
});
