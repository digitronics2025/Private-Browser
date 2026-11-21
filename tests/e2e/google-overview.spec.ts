import { expect, test } from '@playwright/test';

test('shows only enabled Google services and opens originals in the selected space', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?googleOverview=sample');
  await page.getByRole('button', { name: 'Account Space: Operations' }).click();
  await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
  const overview = page.getByRole('region', { name: 'Google overview' });
  await expect(overview.getByText('New stock update')).toBeHidden();
  await overview.getByRole('button', { name: 'Show Google overview' }).click();
  await expect(overview.getByText('New stock update')).toBeVisible();
  await expect(overview.getByText(/Up to 50 items/)).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Calendar', exact: true })).toHaveCount(0);
  await overview.getByRole('button', { name: 'Next' }).click();
  await expect(overview.getByText('Page 2')).toBeVisible();
  await expect(overview.getByText('Previous stock update')).toBeVisible();
  await expect(overview.getByRole('button', { name: 'Next' })).toBeDisabled();
  await overview.getByRole('button', { name: 'Previous' }).click();
  await expect(overview.getByText('New stock update')).toBeVisible();
  await overview.getByRole('button', { name: 'Drive', exact: true }).click();
  await expect(overview.getByText('Stock worksheet')).toBeVisible();
  await overview.getByRole('button', { name: 'Hide overview' }).click();
  await expect(overview.getByText('Stock worksheet')).toBeHidden();
  await overview.getByRole('button', { name: 'Show Google overview' }).click();
  await overview.getByRole('button', { name: 'Open New stock update' }).click();
  await expect(overview).toBeHidden();
  await expect(page.getByRole('button', { name: 'Account Space: Operations' })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => {
    const state = await window.privateBrowser.getState();
    return state.tabs.find((tab) => tab.id === state.activeTabId)?.url;
  })).toBe('https://mail.google.com/mail/#inbox/mail-current');
});
