import { expect, test } from '@playwright/test';

test('Notes is discoverable, keyboard accessible and has deliberate local data controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Side panel', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+Y');
  const notes = page.getByRole('tab', { name: 'Notes', exact: true });
  await expect(notes).toHaveAttribute('aria-selected', 'true');
  await expect(notes).toBeFocused();
  await expect(page.getByRole('button', { name: 'Library home', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /Sign out of Notes/ })).toHaveCount(0);
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('Only the Notes side-panel partition is cleared');
    expect(dialog.message()).toContain('Cloud records are not deleted');
    expect(dialog.message()).toContain('Unsynced local changes and drafts may be lost');
    expect(dialog.message()).toContain('export a backup');
    await dialog.dismiss();
  });
  await page.getByRole('button', { name: 'Clear local Notes data', exact: true }).click();
  await page.keyboard.press('Control+Shift+Y');
  await expect(page.locator('.side-app-slot')).toHaveCount(0);
  await page.getByRole('button', { name: 'Browser menu', exact: true }).click();
  await page.getByRole('menuitem', { name: /Notes/ }).click();
  await expect(notes).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Claude', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New chat', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out of Claude', exact: true })).toBeVisible();
});
