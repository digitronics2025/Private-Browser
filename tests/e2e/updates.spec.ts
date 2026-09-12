import { expect, test } from '@playwright/test';

function monitorBrowser(page: import('@playwright/test').Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
  return () => {
    expect(consoleErrors, 'console errors').toEqual([]);
    expect(pageErrors, 'page errors').toEqual([]);
    expect(failedRequests, 'failed network requests').toEqual([]);
  };
}

async function openUpdatesPage(page: import('@playwright/test').Page, action: 'Open' | 'Update' | 'Review') {
  await page.locator('.sidebar-nav button[title="Settings"]').click();
  await page.locator('.update-settings').getByRole('button', { name: action, exact: true }).click();
  await expect(page.getByTestId('updates-page')).toBeVisible();
}

test('verifies that the installed version is the latest stable release', async ({ page }) => {
  const expectNoBrowserIssues = monitorBrowser(page);
  await page.goto('/');
  await openUpdatesPage(page, 'Open');

  await expect(page.getByRole('heading', { name: 'Private Browser is up to date' })).toBeVisible();
  await expect(page.getByLabel('Installed and latest versions')).toContainText('Installedv0.5.7');
  await expect(page.getByLabel('Installed and latest versions')).toContainText('Latest stablev0.5.7');
  await expect(page.getByText('Automatically checked every 24 hours')).toBeVisible();
  await expect(page.getByText('Dr. Badawi Abdalsalam')).toBeVisible();
  await expect(page.getByText('259a374e199949d72b7fa87c6aed3eef9834340b99ed5dfd17da68038a922eec')).toBeVisible();
  expectNoBrowserIssues();
});

test('shows a focused full-width download action when a newer release exists', async ({ page }) => {
  const expectNoBrowserIssues = monitorBrowser(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?update=available');
  await openUpdatesPage(page, 'Update');

  await expect(page.getByRole('heading', { name: 'Version 0.5.8 is available' })).toBeVisible();
  const download = page.getByRole('button', { name: 'Open verified download' });
  await expect(download).toBeVisible();
  const box = await download.boundingBox();
  expect(box?.width).toBeGreaterThan(240);
  await expect(page.getByText('Build 83')).toBeVisible();
  expectNoBrowserIssues();
});

test('keeps loading and failure states explicit and retryable', async ({ page }) => {
  const expectNoBrowserIssues = monitorBrowser(page);
  await page.goto('/?update=loading');
  await page.locator('.sidebar-nav button[title="Settings"]').click();
  await expect(page.getByText('Checking the latest stable release…')).toBeVisible();
  await page.waitForTimeout(1_050);
  await openUpdatesPage(page, 'Open');
  await expect(page.getByRole('heading', { name: 'Private Browser is up to date' })).toBeVisible();

  await page.goto('/?update=error');
  await openUpdatesPage(page, 'Review');
  await expect(page.getByRole('heading', { name: 'Could not verify the latest version' })).toBeVisible();
  await expect(page.getByText('The public update service could not be reached')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  expectNoBrowserIssues();
});
