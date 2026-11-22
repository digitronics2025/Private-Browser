import { expect, test } from '@playwright/test';

for (const width of [1280, 390]) {
  test('exposes the stock checker status and reviewed password import at ' + width, async ({ page }) => {
    await page.setViewportSize({ width, height: 810 });
    await page.goto('/?chromePassword=sample');
    await page.getByRole('button', { name: 'Browser menu' }).click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Extensions', exact: true }).click();
    await expect(page.getByText('Version 0.5.2 · Blocked before activation')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Passwords', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Google Password Manager' })).toBeVisible();
    await page.getByRole('button', { name: 'Import Google passwords into MyVault' }).click();
    await page.getByRole('button', { name: 'Choose password CSV' }).click();
    await expect(page.getByText('1 of 3 entries ready to import into MyVault.')).toBeVisible();
    await page.getByRole('button', { name: 'Import reviewed logins' }).click();
    await expect(page.getByText('1 login added to MyVault.')).toBeVisible();
  });
}
