import { expect, test } from '@playwright/test';

test('shows tracker categories and exact-site compatibility at a narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 812 });
  await page.goto('/?trackers=sample');
  await page.evaluate(() => window.privateBrowser.navigate('https://reference.example.test/'));
  const open = () => page.getByRole('button', { name: 'Private Browser protection status' }).click();
  await open();
  const shield = page.getByRole('dialog', { name: 'Protection status' });
  const site = shield.getByRole('region', { name: 'Current site tracking' });
  await expect(site.getByText('https://reference.example.test')).toBeVisible();
  await expect(site.getByText('2 known tracker requests blocked this session')).toBeVisible();
  await expect(site.getByText('Advertising 1')).toBeVisible();
  await expect(site.getByText('Analytics 1')).toBeVisible();
  await site.getByRole('button', { name: 'Pause for this site for 10 minutes' }).click();
  await expect(site.getByText('Protection resumes at', { exact: false })).toBeVisible();
  await site.getByRole('button', { name: 'Turn protection back on' }).click();
  await expect(shield.getByText('Tracker blocking is on')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    await window.privateBrowser.switchWorkspace('banking');
    await window.privateBrowser.navigate('https://reference.example.test/');
  });
  await open();
  await expect(shield.getByText('Tracker blocking stays on in Banking')).toBeVisible();
  await expect(site.getByText('0 known tracker requests blocked this session')).toBeVisible();
  await expect(site.getByRole('button', { name: /pause for this site/i })).toHaveCount(0);
  await expect(shield.getByRole('menuitemcheckbox', { name: 'Block trackers' })).toHaveCount(0);
});
