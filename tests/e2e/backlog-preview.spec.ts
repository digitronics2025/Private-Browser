import { expect, test } from '@playwright/test';

for (const width of [1280, 390]) {
  test('finds and switches to a local tab at ' + width + 'px', async ({ page }) => {
    await page.setViewportSize({ width, height: 840 });
    await page.goto('/');
    const input = page.getByRole('combobox', { name: 'Address and search bar' });
    await input.fill('quarterly operations');
    await expect(page.getByRole('option', { name: /Quarterly operations review.*Switch to tab/i })).toBeVisible();
    await input.press('ArrowDown');
    await expect(page.getByRole('option', { selected: true })).toBeVisible();
    await input.press('Enter');
    await expect(input).toHaveValue('https://docs.google.com/document/d/preview');
    await expect(page.getByRole('listbox', { name: 'Local address matches' })).toHaveCount(0);
  });
}

test('keeps keyboard selection when the native page overlay is still preparing', async ({ page }) => {
  await page.goto('/');
  const input = page.getByRole('combobox', { name: 'Address and search bar' });
  await expect(input).toBeVisible();
  await page.evaluate(() => {
    const api = window.privateBrowser;
    Object.defineProperty(window, 'privateBrowser', {
      configurable: true,
      value: new Proxy(api, {
        get(target, property) {
          if (property !== 'freezeContent') return Reflect.get(target, property);
          return () => new Promise<null>((resolve) => {
            window.addEventListener('preview-release-freeze', () => resolve(null), { once: true });
            document.documentElement.dataset.previewFreezePending = 'true';
          });
        },
      }),
    });
  });
  await input.fill('quarterly operations');
  await expect(page.locator('html')).toHaveAttribute('data-preview-freeze-pending', 'true');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.press('ArrowDown');
  await page.evaluate(() => window.dispatchEvent(new Event('preview-release-freeze')));
  await expect(page.getByRole('option', { selected: true })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('https://docs.google.com/document/d/preview');
});

test('labels the preview and exercises Chrome import and protected browsing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByText('Preview · Synthetic data')).toBeVisible();
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByLabel('Chrome profile')).toContainText('Sample Chrome profile');
  await page.getByRole('button', { name: 'Import selected data' }).click();
  await expect(page.getByText('Import complete')).toBeVisible();
  await expect(page.getByText('1 bookmarks · 1 history · 0 passwords')).toBeVisible();
  await page.getByRole('button', { name: 'Choose CSV' }).click();
  await expect(page.getByText('Password files are unavailable in the synthetic preview')).toBeVisible();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect(page.getByRole('button', { name: 'Account Space: Banking' })).toBeVisible();
  await expect(page.getByLabel('Import into Account Space')).toBeDisabled();
  expect(errors).toEqual([]);
});

test('shows the synthetic bridge and handles native-only pairing safely', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.evaluate(() => window.privateBrowser.switchWorkspace('development'));
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'More tools' }).click();
  await page.getByRole('menuitem', { name: 'Developer Bridge' }).click();
  await expect(page.getByText('VS Code disconnected')).toBeVisible();
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText('VS Code pairing requires the desktop app')).toBeVisible();
  expect(errors).toEqual([]);
});

test('paginates a large bookmark library and preserves filters after editing', async ({ page }) => {
  await page.goto('/?bookmarks=large');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Bookmarks', exact: true }).click();
  await page.getByRole('menuitem', { name: /Bookmark manager/ }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await expect(panel.getByRole('heading', { name: 'Bookmarks', exact: true })).toBeVisible();
  const folder = panel.getByRole('textbox', { name: 'Filter by bookmark folder' });
  const search = panel.getByRole('textbox', { name: 'Search bookmarks' });
  await folder.fill('Import folder 248');
  await expect(panel.getByText('Page 1 of 2')).toBeVisible();
  await page.getByRole('navigation', { name: 'Bookmark pages' }).getByRole('button', { name: 'Next' }).click();
  await expect(panel.getByText('Sample bookmark 24899', { exact: true })).toBeVisible();
  await search.fill('24899');
  await panel.getByRole('button', { name: 'Rename Sample bookmark 24899' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit bookmark name' });
  await dialog.getByRole('textbox').fill('Renamed bookmark 24899');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByText('Renamed bookmark 24899', { exact: true })).toBeVisible();
  await expect(folder).toHaveValue('Import folder 248');
  await expect(search).toHaveValue('24899');
});

test('filters and groups the full retained history with date and site controls', async ({ page }) => {
  await page.goto('/?history=large');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: /^History/ }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await expect(panel.getByText('Page 1 of 3')).toBeVisible();
  await panel.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(panel.getByText('Page 2 of 3')).toBeVisible();
  await panel.getByRole('textbox', { name: 'Filter history by site' }).fill('archive.example.test');
  await expect(panel.getByRole('button', { name: /Older sample visit.*2 visits/ })).toBeVisible();
  await panel.getByLabel('From', { exact: true }).fill('2026-10-02');
  await expect(panel.getByRole('button', { name: /Older sample visit/ })).toBeVisible();
  await expect(panel.getByText(/2 visits/)).toHaveCount(0);
});

test('reopens a chosen recently closed tab without stealing focus', async ({ page }) => {
  await page.goto('/');
  const input = page.getByRole('combobox', { name: 'Address and search bar' });
  await expect(input).toBeVisible();
  await page.evaluate(() => window.privateBrowser.closeTab('preview-docs'));
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Recently closed' }).click();
  await page.getByRole('menuitem', { name: /Quarterly operations review.*Reopen in background/i }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByRole('tab', { name: /Quarterly operations review/i })).toBeVisible();
});

test('pins tabs separately and collapses named groups at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 720 });
  await page.goto('/');
  const docs = page.getByRole('tab', { name: /Quarterly operations review/ });
  await docs.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
  await expect(page.locator('.pinned-tabs').getByRole('tab', { name: /Quarterly operations review/ })).toBeVisible();
  const video = page.getByRole('tab', { name: /Team update video/ });
  await video.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Move to group' }).click();
  await page.getByRole('menuitem', { name: 'New group…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create tab group' });
  await dialog.getByLabel('Group name').fill('Research');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  const research = page.getByRole('button', { name: 'Research', exact: true });
  await expect(research).toHaveAttribute('aria-expanded', 'true');
  await research.click();
  await expect(research).toHaveAttribute('aria-expanded', 'false');
  await expect(video).toHaveCount(0);
  await research.click();
  await expect(video).toBeVisible();
});

test('shows Windows default-browser choices and limits OS actions in preview', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByText('Windows uses another browser for web links.')).toBeVisible();
  await page.getByRole('button', { name: 'Open Windows Default Apps' }).click();
  await expect(page.getByText('Changing the default browser requires the desktop app')).toBeVisible();
  await page.getByRole('button', { name: 'Test with a link' }).click();
  await expect(page.getByText('Testing the Windows default browser requires the desktop app')).toBeVisible();
});

test('confirms the exact bulk count and restores a closed tab group', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: /Team update video/ })).toBeVisible();
  const group = await page.evaluate(async () => {
    await window.privateBrowser.organizeTab({ kind: 'create-group', tabId: 'preview-media', name: 'Review' });
    const group = (await window.privateBrowser.getState()).tabGroups![0];
    await window.privateBrowser.organizeTab({ kind: 'move-to-group', tabId: 'preview-intranet', groupId: group.id });
    return group.name;
  });
  await page.getByRole('tab', { name: /Team update video/ }).click({ button: 'right' });
  const pending = page.waitForEvent('dialog');
  const click = page.getByRole('menuitem', { name: /Close tab group/ }).click();
  const confirmation = await pending;
  expect(confirmation.message()).toContain('Close 2 tabs?');
  await confirmation.accept();
  await click;
  await expect(page.getByRole('tab', { name: /Team update video/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: new RegExp('Reopen group ' + group) }).click();
  await expect(page.getByRole('tab', { name: /Team update video/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Legacy intranet/ })).toBeVisible();
});

test('shows a recoverable crash screen at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto('/?recovery=crashed');
  await expect(page.getByRole('heading', { name: 'Page crashed' })).toBeVisible();
  await page.getByRole('button', { name: 'Reload page' }).click();
  await expect(page.getByRole('heading', { name: 'Page crashed' })).toHaveCount(0);
});
