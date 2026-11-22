import { expect, test } from '@playwright/test';

test('reviews local and cloud metadata before enabling either conflict choice', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?vaultConflict=sample');
  await page.getByRole('button', { name: 'Browser menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /^MyVault/ }).click();
  const conflict = page.getByRole('region', { name: 'MyVault sync conflict' });
  await expect(conflict.getByRole('button', { name: 'Keep cloud copy' })).toHaveCount(0);
  await conflict.getByRole('button', { name: 'Review versions' }).click();
  await expect(conflict.getByText('Cloud version 3')).toBeVisible();
  await expect(conflict.getByText('Local reference')).toBeVisible();
  await expect(conflict.getByText('Cloud reference')).toBeVisible();
  await expect(conflict.locator('time')).toHaveCount(2);
  await conflict.getByRole('button', { name: 'Keep cloud copy' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Both encrypted recovery copies are saved' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show conflict recovery files' })).toBeVisible();
});
