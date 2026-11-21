import { expect, test } from '@playwright/test';

test('opens or skips setup without stopping browsing and can return from Settings', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?setup=new');
  const main = page.getByRole('main', { name: 'New Tab' });
  await expect(main.getByRole('textbox', { name: /Search .* or enter address/ })).toBeVisible();
  await main.getByRole('button', { name: 'Open setup guide' }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await expect(panel.getByRole('heading', { name: 'Setup guide' })).toBeVisible();
  await expect(panel.getByText('Operations is ready')).toBeVisible();
  await expect(panel.getByText('Optional vault pairing')).toBeVisible();
  await panel.getByRole('button', { name: 'Choose Chrome data' }).click();
  await expect(panel.getByLabel('Chrome profile')).toContainText('Sample Chrome profile');
  await panel.getByRole('button', { name: 'Preview import' }).click();
  await panel.getByRole('button', { name: 'Import selected data' }).click();
  await expect(panel.getByText('Import complete')).toBeVisible();
  await panel.getByRole('button', { name: 'Setup guide', exact: true }).click();
  await expect(panel.getByText('A Chrome import has run')).toBeVisible();
  await panel.getByRole('button', { name: 'Skip setup', exact: true }).click();
  await expect(main.getByRole('button', { name: 'Open setup guide' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Setup guide', exact: true })).toBeVisible();
});

test('existing browsers offer setup from Settings without a first-launch banner', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open setup guide' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Setup guide', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Setup guide' })).toBeVisible();
});

test('offers a bookmark HTML file when there is no Chrome profile', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?setup=new&chrome=empty');
  await page.getByRole('button', { name: 'Open setup guide' }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Choose Chrome data' }).click();
  await expect(panel.getByText('Choose a bookmark HTML export below', { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: 'Choose HTML' }).click();
  await expect(panel.getByRole('status').filter({ hasText: '1 bookmark imported · 1 skipped' })).toBeVisible();
});
