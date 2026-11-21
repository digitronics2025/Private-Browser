import { expect, test } from '@playwright/test';

test('shows a sleeping tab and remembers the current-space site exclusion', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?memorySaver=sample');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('group', { name: 'Memory Saver' });
  const delay = settings.getByLabel('Sleep inactive tabs after');
  await expect(delay).toHaveValue('0');
  await delay.selectOption('5');
  await expect(delay).toHaveValue('5');
  const asleep = page.getByRole('tab', { name: 'Reading list, sleeping' });
  await expect(asleep).toBeVisible();
  await asleep.click();
  await expect(page.getByRole('tab', { name: 'Reading list', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View site information' }).click();
  const keepAwake = page.getByRole('menuitemcheckbox', { name: 'Keep this site awake' });
  await expect(keepAwake).toHaveAttribute('aria-checked', 'false');
  await keepAwake.click();
  await expect(keepAwake).toHaveAttribute('aria-checked', 'true');
});
