import { expect, test } from '@playwright/test';

test('Notes is discoverable, keyboard accessible and has deliberate local data controls', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Side panel', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+Y');
  const notes = page.getByRole('tab', { name: 'Notes', exact: true });
  await expect(notes).toHaveAttribute('aria-selected', 'true');
  await expect(notes).toBeFocused();
  await expect(page.getByRole('button', { name: 'Library home', exact: true })).toBeVisible();
  await expect(page.getByRole('note')).toHaveText('Shared Notes library');
  await expect(page.getByRole('button', { name: /Sign out of Notes/ })).toHaveCount(0);
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('Last successful sync:');
    expect(dialog.message()).toContain('Cloud records stay in the library');
    expect(dialog.message()).toContain('can lose unsynced changes or drafts');
    expect(dialog.message()).toContain('then Export Notes');
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
  await expect(page.getByText('Shared Notes library')).toHaveCount(0);
});

test('reviews editable web text before opening a Notes draft', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?notesDraft=sample&notes=protected');
  const draft = page.getByRole('dialog', { name: 'Review text for Notes' });
  await expect(draft.getByRole('textbox', { name: 'Selected text' })).toHaveValue('Selected browser excerpt.');
  await draft.getByRole('textbox', { name: 'Selected text' }).fill('Edited reference text.');
  await draft.getByRole('checkbox', { name: /Include source site/ }).uncheck();
  expect(await page.locator('html').getAttribute('data-preview-notes-draft')).toBeNull();
  await draft.getByRole('button', { name: 'Open Notes draft' }).click();
  await expect(draft).toHaveCount(0);
  await expect(page.getByRole('note')).toHaveText('Notes library · Sign-in required');
  await expect(page.locator('html')).toHaveAttribute('data-preview-notes-draft', /Edited reference text.*false/);
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-preview-notes-action', 'pinned');
  await page.getByRole('button', { name: 'Export Notes', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-preview-notes-action', 'backup');
});


test('restoring the persisted panel after fullscreen preserves existing focus', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Side panel', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+Y');
  await expect(page.getByRole('tab', { name: 'Notes', exact: true })).toHaveAttribute('aria-selected', 'true');
  // A field outside the shell represents the neighboring native page's focus.
  // It survives fullscreen while the toolbar and side-panel frame unmount.
  await page.evaluate(async () => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Focus fixture');
    document.body.append(input);
    input.focus();
    await window.privateBrowser.toggleFullscreen();
  });
  await expect(page.locator('.side-panel-shell')).toHaveCount(0);
  await page.evaluate(() => window.privateBrowser.toggleFullscreen());
  await expect(page.getByRole('tab', { name: 'Notes', exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Focus fixture', exact: true })).toBeFocused();
});
