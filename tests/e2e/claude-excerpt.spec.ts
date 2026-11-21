import { expect, test } from '@playwright/test';

test('previews the exact redacted excerpt before copying or cancelling', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?claudeExcerpt=sample');
  await page.evaluate(() => window.privateBrowser.navigate('https://example.test/article?unshared=1'));
  const open = async () => {
    await page.getByRole('button', { name: 'Browser menu' }).click();
    await page.getByRole('menuitem', { name: 'Copy approved excerpt for Claude…' }).click();
    return page.getByRole('dialog', { name: 'Review excerpt for Claude' });
  };
  const review = await open();
  const root = page.locator('html');
  await expect(review.getByLabel('Text to copy')).toHaveText('Selected catalogue paragraph. [REDACTED]');
  await expect(review).not.toContainText('unshared');
  await page.keyboard.press('Escape');
  await expect(review).toBeHidden();
  await expect(root).not.toHaveAttribute('data-preview-claude-copy', /./);
  await open();
  await review.getByRole('button', { name: 'Copy excerpt' }).click();
  await expect(root).toHaveAttribute('data-preview-claude-copy', 'Selected catalogue paragraph. [REDACTED]');
  await expect(page.getByText('Excerpt copied. Paste it in Claude when ready.')).toBeVisible();
});
