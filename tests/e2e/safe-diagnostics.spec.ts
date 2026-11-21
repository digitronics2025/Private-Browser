import { expect, test } from '@playwright/test';

test('previews the exact diagnostic report and copies only after confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 812 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async (text: string) => { (window as unknown as { diagnosticCopy: string }).diagnosticCopy = text; },
    } });
  });
  const copied = () => page.evaluate(() => (window as unknown as { diagnosticCopy?: string }).diagnosticCopy);
  await page.goto('/?recovery=crashed');
  const button = page.getByRole('button', { name: 'Copy diagnostics' });
  await button.click();
  const preview = page.getByRole('region', { name: 'Diagnostics preview' });
  await expect(preview).toHaveAttribute('aria-busy', 'false');
  const text = await preview.getByLabel('Report text').textContent();
  expect(text).toBe('Private Browser 0.5.7\nCategory Recovery\nReason PB-RECOVERY-PAGE\nNext action Reload the affected page or go back.');
  expect(await copied()).toBeUndefined();
  await preview.getByRole('button', { name: 'Copy report' }).click();
  await expect(preview.getByRole('status')).toHaveText('Diagnostics copied.');
  expect(await copied()).toBe(text);
});

test('shows a stable side-app reason with a next action and excludes page data', async ({ page }) => {
  await page.goto('/?notes=offline');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Notes' }).click();
  await page.getByRole('button', { name: 'Copy diagnostics' }).click();
  const report = page.getByRole('region', { name: 'Diagnostics preview' }).getByLabel('Report text');
  await expect(report).toContainText('PB-SIDE-APP-OFFLINE');
  await expect(report).toContainText('Check the internet connection and select Retry.');
  await expect(report).not.toContainText('http');
});
