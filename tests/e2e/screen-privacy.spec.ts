import { expect, test } from '@playwright/test';

test('masks account identity and browsing summaries on a narrow New Tab', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 812 });
  await page.goto('/');
  const home = page.getByRole('main', { name: 'New Tab' });
  await expect(home.getByRole('region', { name: 'Shortcuts' })).toBeVisible();
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByLabel('Lock Private Browser when Windows locks').check();
  await page.getByLabel('Lock after device inactivity').selectOption('15');
  await page.getByLabel('Mask Account Space identity on New Tab').check();
  await page.getByRole('button', { name: 'Close side panel' }).click();
  await expect(home.getByText('Today', { exact: true })).toBeVisible();
  await expect(home.getByRole('region', { name: 'Shortcuts' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Account Space', exact: true })).toHaveAttribute('title', 'Account Space');
  await expect(page.getByRole('navigation', { name: 'Bookmarks bar' })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then((state) => state.ui))).toMatchObject({
    lockOnWindowsSession: true, idleLockMinutes: 15, maskTodayIdentity: true,
  });
});
