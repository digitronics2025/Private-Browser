import { expect, test } from '@playwright/test';

test('creates an empty folder and chooses it when bookmarking, then moves it from the keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 810 });
  await page.goto('/');
  await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();
  await page.keyboard.press('Control+Shift+O');
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByText('Manage folders', { exact: true }).click();
  await panel.getByRole('button', { name: 'New folder' }).click();
  const newFolder = page.getByRole('dialog', { name: 'New bookmark folder' });
  await newFolder.getByLabel('Folder name').fill('Reference Work');
  await newFolder.getByRole('button', { name: 'Create folder' }).click();
  const tree = panel.getByRole('navigation', { name: 'Bookmark folders' });
  await tree.getByRole('button', { name: 'Reference Work', exact: true }).click();
  await expect(panel.getByText('This folder is empty.')).toBeVisible();

  await page.setViewportSize({ width: 1150, height: 810 });
  const address = page.getByRole('combobox', { name: 'Address and search bar' });
  await address.fill('https://reference.example.test/');
  await address.press('Enter');
  await expect(page.getByRole('button', { name: 'Bookmark this tab', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Bookmark this tab', exact: true }).click({ modifiers: ['Shift'] });
  const save = page.getByRole('dialog', { name: 'Bookmark this tab in a folder' });
  await save.getByLabel('Find a folder').fill('Reference Work');
  await save.getByLabel('Destination folder').selectOption({ label: 'Bookmarks bar / Reference Work' });
  await save.getByRole('button', { name: 'Save bookmark' }).click();
  await expect(panel.getByRole('checkbox', { name: 'Select reference.example.test' })).toBeVisible();

  await page.setViewportSize({ width: 520, height: 810 });
  const move = panel.getByRole('button', { name: 'Move folder', exact: true });
  await move.focus();
  await page.keyboard.press('Enter');
  const folderDialog = page.getByRole('dialog', { name: 'Move bookmark folder' });
  await folderDialog.getByLabel('Destination folder').selectOption({ label: 'Other bookmarks' });
  await folderDialog.getByRole('button', { name: 'Move folder' }).press('Enter');
  await expect(folderDialog).toBeHidden();
  await tree.getByRole('button', { name: 'Reference Work', exact: true }).click();
  await expect(panel.getByRole('button', { name: /reference\.example\.test.*Other bookmarks \/ Reference Work/ })).toBeVisible();
});
