import { expect, test } from '@playwright/test';

test('opens and focuses a split from the tab menu, pauses at narrow widths, and closes with the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 770 });
  await page.goto('/');
  const reference = page.getByRole('tab', { name: /Quarterly operations review/ });
  const media = page.getByRole('tab', { name: /Team update video/ });
  await reference.click();
  await media.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show beside active tab' }).click();
  const split = page.getByRole('group', { name: 'Split view', exact: true });
  await expect(split).toBeVisible();
  await split.getByRole('button', { name: /Focus other pane: Team update video/ }).click();
  await expect(media).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('combobox', { name: 'Address and search bar' })).toHaveValue('https://media.example.com/watch');

  await page.setViewportSize({ width: 520, height: 770 });
  await expect(split.getByRole('button', { name: /Focus other pane/ })).toBeDisabled();
  await page.setViewportSize({ width: 1200, height: 770 });
  await expect(split.getByRole('button', { name: /Focus other pane/ })).toBeEnabled();
  await split.getByRole('button', { name: 'End split view' }).press('Enter');
  await expect(split).toHaveCount(0);
  await expect(media).toHaveAttribute('aria-selected', 'true');
});
