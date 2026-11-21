import { expect, test } from '@playwright/test';

test('previews and saves only selected tabs as a routine and a bookmark folder', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/');
  await page.evaluate(async () => {
    for (const path of ['reference-one', 'reference-two']) {
      await window.privateBrowser.newTab();
      await window.privateBrowser.navigate('https://example.test/' + path);
    }
  });
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'More tools' }).click();
  await page.getByRole('menuitem', { name: 'Automations' }).click();
  await page.getByRole('button', { name: 'Save open tabs as a routine' }).click();
  const choose = async (path: string) => {
    const tabs = page.getByRole('group', { name: 'Tabs in', exact: false });
    for (const tab of await tabs.getByRole('checkbox').all()) await tab.uncheck();
    await tabs.getByRole('checkbox', { name: new RegExp(path) }).check();
    await expect(tabs.getByRole('status')).toHaveText('1 selected (up to 20)');
  };
  await choose('reference-one');
  await page.getByLabel('Routine name').fill('Selected references');
  await page.getByRole('button', { name: 'Save routine' }).click();
  const routine = page.locator('details').filter({ hasText: 'Selected references' });
  await routine.locator('summary').click();
  await expect(routine.getByRole('listitem')).toHaveCount(1);
  await expect(routine.getByRole('listitem')).toContainText('https://example.test/reference-one');
  await page.getByRole('button', { name: 'Bookmark this set' }).click();
  await choose('reference-two');
  await page.getByLabel('Bookmarks bar folder').fill('Selected bookmarks');
  await page.getByRole('button', { name: 'Add bookmarks' }).click();
  await expect.poll(() => page.evaluate(async () => (await window.privateBrowser.getState()).bookmarks
    .filter((bookmark) => bookmark.folderPath[0] === 'Selected bookmarks').map((bookmark) => bookmark.url)))
    .toEqual(['https://example.test/reference-two']);
});

test('creates, previews and reruns a routine and resets its checklist', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'More tools' }).click();
  await page.getByRole('menuitem', { name: 'Automations' }).click();
  await page.getByRole('button', { name: 'New routine' }).click();
  await page.getByLabel('Routine name').fill('Morning review');
  await page.getByLabel('Web address 1').fill('https://example.test/first');
  await page.getByRole('button', { name: 'Add link', exact: true }).click();
  await page.getByLabel('Web address 2').fill('https://example.test/second');
  await page.getByLabel('Account Space 2').selectOption({ label: 'Digitronics / Digitronics' });
  await page.getByRole('button', { name: 'Move link 2 up' }).click();
  await expect(page.getByLabel('Web address 1')).toHaveValue('https://example.test/second');
  await page.getByRole('button', { name: 'Add checklist item' }).click();
  await page.getByLabel('Checklist item 1', { exact: true }).fill('Check the morning queue');
  await page.getByRole('button', { name: 'Save routine' }).click();
  const routine = page.locator('details').filter({ hasText: 'Morning review' });
  await routine.locator('summary').click();
  const firstLink = routine.getByRole('listitem').first();
  await expect(firstLink).toContainText('https://example.test/second');
  await expect(firstLink).toContainText('Digitronics / Digitronics');
  await routine.getByRole('button', { name: 'Run routine' }).click();
  await expect(routine.getByText('2 added · 0 reused · 0 skipped')).toBeVisible();
  await routine.getByRole('button', { name: 'Run routine' }).click();
  await expect(routine.getByText('0 added · 2 reused · 0 skipped')).toBeVisible();
  const checkbox = routine.getByRole('checkbox', { name: /Check the morning queue/ });
  await checkbox.check();
  await expect(routine.getByText(/Last done /)).toBeVisible();
  await routine.getByRole('button', { name: 'Reset checklist' }).click();
  await expect(checkbox).not.toBeChecked();
  await expect(routine.getByText(/Last done /)).toBeVisible();
});
