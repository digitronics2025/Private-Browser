import { expect, test } from '@playwright/test';

test('finds exact passages in the local preview without a model, then clears them when changing spaces', async ({ page }) => {
  await page.goto('/?localAi=sample');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Read page locally' }).click();
  const keywords = panel.getByLabel('Page keywords');
  await keywords.fill('cafe ceramic');
  await keywords.press('Enter');
  await expect(panel.getByRole('listitem')).toHaveText('The café stocks ceramic mugs.');
  await keywords.fill('الشاي');
  await keywords.press('Enter');
  await expect(panel.getByRole('listitem')).toHaveText('الشاي متوفر اليوم.');
  await keywords.fill('coffee');
  await keywords.press('Enter');
  await expect(panel.getByText('No matching passages in this page preview.')).toBeVisible();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('development'));
  await expect(panel.getByRole('button', { name: 'Read page locally' })).toBeVisible();
  await expect(keywords).toHaveCount(0);
});

test('checks installed local models and labels the saved provider without a key field', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 800 });
  await page.goto('/?localAi=sample');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByLabel('Provider type')).toHaveValue('local');
  await expect(panel.getByPlaceholder('API key (encrypted)')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Save local model' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Check installed models' }).click();
  await expect(panel.getByText('Ollama is running with cloud features disabled.')).toBeVisible();
  await panel.getByLabel('Local model').selectOption('preview-small:latest');
  await panel.getByRole('button', { name: 'Save local model' }).click();
  await expect(panel.getByText('Local · Ollama')).toBeVisible();
  await expect(panel.getByText('preview-small:latest', { exact: true })).toBeVisible();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect(page.evaluate(() => window.privateBrowser.getLocalAiModels())).rejects.toThrow(/workspace/);
});
