import { expect, test } from '@playwright/test';

test('pins tools and remembers the selected tool only in its Account Space', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Downloads' }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  const tools = panel.getByRole('tablist', { name: 'Side panel tools' });
  await expect(tools.getByRole('tab', { name: 'Downloads' })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('button', { name: 'Pin Downloads' }).click();
  await expect(tools.getByRole('tab').first()).toHaveAccessibleName('Downloads');
  await tools.getByRole('tab', { name: 'Downloads' }).press('ArrowRight');
  await expect(tools.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
  const first = await page.evaluate(() => window.privateBrowser.getState().then((state) => ({
    id: state.activeAccountSpaceId, workspace: state.activeWorkspaceId,
  })));
  await page.evaluate(() => window.privateBrowser.switchWorkspace('tenten'));
  await expect(tools.getByRole('tab').first()).toHaveAccessibleName('Notes');
  await expect(tools.getByRole('tab', { name: 'AI assistant' })).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(async ({ id, workspace }) => {
    await window.privateBrowser.switchWorkspace(workspace);
    await window.privateBrowser.switchAccountSpace(id);
  }, first);
  await expect(tools.getByRole('tab').first()).toHaveAccessibleName('Downloads');
  await expect(tools.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
  await tools.getByRole('tab', { name: 'Downloads' }).click();
  await panel.getByRole('button', { name: 'Unpin Downloads' }).click();
  await expect(tools.getByRole('tab').first()).toHaveAccessibleName('Notes');
});

test('filters retained downloads and removes only the selected list entry', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?downloadHistory=sample');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Downloads' }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await expect(panel.getByLabel('Keep download history')).toBeChecked();
  await panel.getByRole('searchbox', { name: 'Search downloads' }).fill('billing');
  const file = panel.locator('.download-card').filter({ hasText: 'Statement.pdf' });
  await expect(file.getByText('https://billing.example.test')).toBeVisible();
  await expect(file.locator('time')).toHaveAttribute('datetime', '2026-11-20T16:00:00Z');
  const filter = panel.getByRole('combobox', { name: 'Download status' });
  await filter.selectOption('interrupted');
  await expect(panel.getByText('No downloads match these filters.')).toBeVisible();
  await filter.selectOption('completed');
  await file.getByRole('button', { name: 'Remove from list' }).click();
  await expect(file).toHaveCount(0);
  await expect(panel.getByText('Downloaded files will appear here.')).toBeVisible();
});

test('chooses a per-space download folder and switches between asking and automatic saving', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?downloadFolder=sample&downloads=sample');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Downloads' }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Choose folder' }).click();
  await expect(panel.getByText('Sample invoices')).toBeVisible();
  await expect(panel.getByLabel('Ask where to save')).toBeChecked();
  await panel.getByLabel('Ask where to save').uncheck();
  await expect(panel.getByText('New files with the same name get a number.', { exact: false })).toBeVisible();
  await expect(panel.getByLabel('Downloads this session')).toHaveText(/active.*downloaded.*stopped/i);
  await panel.getByRole('button', { name: 'Use default' }).click();
  await expect(panel.getByText('Windows default')).toBeVisible();
  await expect(panel.getByLabel('Ask where to save')).toBeChecked();
});

test('reports unavailable desktop actions without fabricating successful results', async ({ page }) => {
  await page.goto('/');
  const status = await page.evaluate(async () => {
    const api = window.privateBrowser;
    try {
      await api.requestVaultUnlock();
      return 'Unexpected preview unlock';
    } catch (error) {
      return (error as Error).message;
    }
  });
  expect(status).toBe('This action is available in the desktop app.');
  await expect(page.locator('html')).toHaveAttribute('data-browser-preview', 'synthetic');
});

test('separates file type, checksum and publisher and only enables eligible files', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?downloads=sample');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Downloads' }).click();
  const downloading = page.locator('.download-card').filter({ hasText: 'sample.pdf' });
  await expect(downloading.getByRole('button', { name: 'Open', exact: true })).toBeDisabled();
  const verified = page.locator('.download-card').filter({ hasText: 'installer-sample.exe' });
  await expect(verified.getByText('EXE · May run code')).toBeVisible();
  await expect(verified.getByText('Matches the published release')).toBeVisible();
  await expect(verified.getByText('No Windows signature')).toBeVisible();
  await verified.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'This preview cannot open files' })).toBeVisible();
  const mismatch = page.locator('.download-card').filter({ hasText: 'invalid-installer.exe' });
  await expect(mismatch.getByRole('button', { name: 'Open', exact: true })).toBeDisabled();
  await expect(mismatch.getByRole('button', { name: 'Show folder' })).toBeEnabled();
  const checking = page.locator('.download-card').filter({ hasText: 'checking.exe' });
  await expect(checking.getByText('Waiting for verification')).toBeVisible();
  await expect(checking.getByRole('button', { name: 'Show folder' })).toBeDisabled();
  await downloading.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(downloading.getByText('Paused', { exact: true })).toBeVisible();
  await downloading.getByRole('button', { name: 'Resume' }).click();
  await expect(downloading.getByText('Downloading', { exact: true })).toBeVisible();
  const interrupted = page.locator('.download-card').filter({ hasText: 'interrupted.pdf' });
  await interrupted.getByRole('button', { name: 'Retry' }).click();
  await expect(interrupted.getByText('Downloading', { exact: true })).toBeVisible();
  await interrupted.getByRole('button', { name: 'Cancel download' }).click();
  await expect(interrupted.getByText('Cancelled', { exact: true })).toBeVisible();
});

test('reviews and moves or deletes duplicate bookmark entries without merging them', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 810 });
  await page.goto('/?bookmarks=duplicates');
  await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();
  await page.keyboard.press('Control+Shift+O');
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await expect(panel.getByRole('heading', { name: 'Bookmarks' })).toBeVisible();
  await panel.getByRole('button', { name: 'Duplicate addresses' }).click();
  const choose = async () => {
    await panel.getByRole('checkbox', { name: 'Select Invoices' }).check();
    await panel.getByRole('checkbox', { name: 'Select Invoice reference' }).check();
  };
  await choose();
  await panel.getByRole('button', { name: 'Move selected' }).click();
  const move = panel.getByRole('region', { name: 'Choose a bookmark destination' });
  await expect(move.getByRole('listitem').filter({ hasText: /^Bookmarks bar \/ Finance$/ })).toBeVisible();
  await move.getByLabel('Move to').selectOption({ label: 'Other bookmarks' });
  await move.getByRole('button', { name: 'Move 2 bookmarks' }).click();
  await expect(panel.getByRole('button', { name: 'Undo bookmark change' })).toBeVisible();
  await panel.getByRole('button', { name: 'Undo bookmark change' }).click();
  await expect(panel.getByText('2 bookmarks restored.')).toBeVisible();

  await choose();
  await panel.getByRole('button', { name: 'Delete selected' }).click();
  const deletion = panel.getByRole('region', { name: 'Review bookmark deletion' });
  await expect(deletion.getByText('2 bookmarks from 2 folders')).toBeVisible();
  await expect(deletion.getByText('Other bookmarks / Archive')).toBeVisible();
  await deletion.getByRole('button', { name: 'Delete 2 bookmarks' }).click();
  await expect(panel.getByRole('checkbox', { name: 'Select Invoices' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Undo bookmark change' }).click();
  await expect(panel.getByRole('checkbox', { name: 'Select Invoices' })).toBeVisible();

  await panel.getByRole('button', { name: 'Edit address for Invoices' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit bookmark address' });
  await editor.getByLabel('URL').fill('https://billing.example.com/invoices?year=2025');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByRole('checkbox', { name: 'Select Invoices' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Duplicate addresses' }).click();
  await expect(panel.getByRole('checkbox', { name: 'Select Invoice reference' })).toBeVisible();
});

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
          if (property !== 'setOverlayOpen') return Reflect.get(target, property);
          return (open: boolean) => open ? new Promise<void>((resolve, reject) => {
            window.addEventListener('preview-release-overlay', () => target.setOverlayOpen(true).then(resolve, reject), { once: true });
            document.documentElement.dataset.previewOverlayPending = 'true';
          }) : target.setOverlayOpen(false);
        },
      }),
    });
  });
  await input.fill('quarterly operations');
  await expect(page.locator('html')).toHaveAttribute('data-preview-overlay-pending', 'true');
  await expect(input).toHaveAttribute('aria-expanded', 'false');
  await input.press('ArrowDown');
  await page.evaluate(() => window.dispatchEvent(new Event('preview-release-overlay')));
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
  await page.getByRole('button', { name: 'Use suggested destination' }).click();
  await page.getByRole('button', { name: 'Preview import' }).click();
  await expect(page.getByText('Review Chrome import')).toBeVisible();
  await expect(page.getByText(/History dates/)).toBeVisible();
  await page.getByText('Bookmark folders', { exact: true }).click();
  await expect(page.getByText('Bookmarks bar / Sample folder · 1')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then((state) =>
    state.bookmarks.some((item) => item.title === 'Sample imported page')))).toBe(false);
  await page.getByRole('button', { name: 'Import selected data' }).click();
  await expect(page.getByText('Import complete')).toBeVisible();
  await expect(page.getByText('1 bookmarks · 1 history · 0 passwords')).toBeVisible();
  await page.getByRole('button', { name: 'Choose CSV' }).click();
  await page.getByRole('button', { name: 'Choose password CSV' }).click();
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
  await page.getByRole('button', { name: 'Generate pairing code', exact: true }).click();
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
  await expect(panel.getByRole('button', { name: /^Older sample visit/ })).toBeVisible();
  await expect(panel.getByText(/2 visits/)).toHaveCount(0);
});

test('deletes a single visit and reviews site and time scope before clearing', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?history=large');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: /^History/ }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('textbox', { name: 'Filter history by site' }).fill('archive.example.test');
  await expect(panel.getByRole('button', { name: /Older sample visit.*2 visits/ })).toBeVisible();
  page.once('dialog', (dialog) => void dialog.accept());
  await panel.getByRole('button', { name: 'Delete most recent visit to Older sample visit' }).click();
  await expect(panel.getByText(/2 visits/)).toHaveCount(0);
  await expect(panel.getByText('Older sample visit')).toBeVisible();
  await panel.getByRole('button', { name: 'Delete browsing data…' }).click();
  const review = page.getByRole('dialog', { name: 'Delete browsing data' });
  await expect(review.getByRole('combobox', { name: 'Account Space', exact: true })).toBeVisible();
  await review.getByLabel('Website address (optional)').fill('https://archive.example.test');
  await review.getByRole('combobox', { name: 'History time range' }).selectOption('week');
  await review.getByRole('button', { name: 'Review deletion' }).click();
  await expect(review.getByText('0 visits to remove · Last 7 days')).toBeVisible();
  await expect(review.getByRole('button', { name: 'Delete reviewed data' })).toBeDisabled();
  await review.getByRole('button', { name: 'Change selection' }).click();
  await review.getByRole('combobox', { name: 'History time range' }).selectOption('all');
  await review.getByRole('checkbox', { name: 'Website data and sign-ins' }).check();
  await review.getByRole('button', { name: 'Review deletion' }).click();
  await expect(review.getByText('1 visit to remove · All time')).toBeVisible();
  await expect(review.getByText(/may sign you out/)).toBeVisible();
  await review.getByRole('button', { name: 'Delete reviewed data' }).click();
  await expect(review).toHaveCount(0);
  await expect(panel.getByText('No retained visits match those filters.')).toBeVisible();
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
