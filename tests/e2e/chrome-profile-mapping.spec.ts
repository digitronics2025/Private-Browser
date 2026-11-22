import { expect, test } from '@playwright/test';

test('requires a profile destination and previews the independently chosen workspace settings', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?chrome=mapping');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  const open = page.getByRole('button', { name: 'Preview import' });
  await expect(page.getByLabel('Chrome profile')).toContainText('Research');
  await expect(open).toBeDisabled();
  await page.getByLabel('Chrome profile').selectOption('Profile 1');
  await page.getByRole('button', { name: 'Create an Account Space for this profile' }).click();
  await expect(page.getByLabel('Import into Account Space').locator('option:checked')).toHaveText('Research');
  const options = page.getByRole('group', { name: 'Optional settings for Personal' });
  await expect(options.getByRole('checkbox', { name: 'Search engine', exact: true })).not.toBeChecked();
  await options.getByRole('checkbox', { name: 'Home page', exact: true }).check();
  await open.click();
  await expect(page.getByText('Destination · Research')).toBeVisible();
  await expect(page.getByText('Home page · https://reference.example.test/')).toBeVisible();
  await expect(page.getByText(/Search engine · Google/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Import selected data' }).click();
  await expect(page.getByText('This Chrome profile has already been imported into Research.')).toBeVisible();
  await expect(open).toBeDisabled();
});
