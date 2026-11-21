import { expect, test } from '@playwright/test';

test('chooses a search engine during setup and edits behavior in the current workspace only', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?setup=new');
  await page.getByRole('button', { name: 'Open setup guide' }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Choose search engine' }).click();
  const engine = panel.getByLabel('Search engine');
  await expect(engine).toBeFocused();
  await engine.selectOption('brave');
  await panel.getByRole('radio', { name: 'Also open selected pages' }).click();
  await panel.getByLabel('Startup addresses').fill('https://example.test/dashboard\nexample.test/help');
  await panel.getByRole('button', { name: 'Save startup pages' }).click();
  await panel.getByLabel('Keywords and search addresses').fill('gh https://example.test/search?q=%s');
  await panel.getByRole('button', { name: 'Save site keywords' }).click();
  const address = page.getByRole('combobox', { name: 'Address and search bar' });
  await address.fill('gh privacy tabs');
  await address.press('Enter');
  await expect(address).toHaveValue('https://example.test/search?q=privacy%20tabs');
  await page.evaluate(() => window.privateBrowser.switchWorkspace('tenten'));
  await expect(engine).toHaveValue('duckduckgo');
  await expect(panel.getByRole('radio', { name: 'Continue where you left off' })).toHaveAttribute('aria-checked', 'true');
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect(panel.getByLabel('Keywords and search addresses')).toHaveCount(0);
});
