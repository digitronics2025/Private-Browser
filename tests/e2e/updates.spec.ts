import { expect, test } from '@playwright/test';
import { DEVELOPER_PROFILE, renderDownloadPage } from '../../cloudflare/src/page';

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

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menu', { name: 'Browser menu' }).getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.update-settings')).toBeVisible();
}

async function openUpdatesPage(page: import('@playwright/test').Page, action: 'Open' | 'Update' | 'Review') {
  await openSettings(page);
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
  await expect(page.getByText('WHAT CHANGED SINCE YOUR VERSION')).toBeVisible();
  await expect(page.getByText('Review release highlights before installing a new browser version.')).toBeVisible();
  // F-36: releases are unsigned, so the page must not promise a signed installer.
  await expect(page.getByText(/checksum is checked/)).toBeVisible();
  await expect(page.getByText(/\bsigned\b/i)).toHaveCount(0);
  await page.getByRole('button', { name: 'Release history', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const state = await window.privateBrowser.getState();
    return state.tabs.find((tab) => tab.id === state.activeTabId)?.url;
  })).toBe('https://private-browser-downloads.digitronics-electro.workers.dev/#release-history');
  expectNoBrowserIssues();
});

test('shows escaped release highlights and the full changelog on the download page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  const published = '2026-11-21T11:00:00Z';
  await page.setContent(renderDownloadPage({
    developer: DEVELOPER_PROFILE, history: [], canonicalUrl: 'https://example.test/',
    downloadUrl: 'https://example.test/installer', renderedAt: published,
    release: {
      id: 'stable-example', app_id: 'private-browser', version: '0.6.40', build_number: 251,
      object_key: 'fixture', filename: 'Private-Browser-Setup.exe', size_bytes: 123, sha256: 'a'.repeat(64),
      commit_sha: 'b'.repeat(40), content_type: 'application/octet-stream', channel: 'stable',
      release_notes: 'Reviewed example <note> stays visible.', published_at: published, is_active: 1,
    },
  }));
  await expect(page.getByRole('heading', { name: 'Latest release highlights' })).toBeVisible();
  await expect(page.getByText('Reviewed example <note> stays visible.')).toBeVisible();
  await expect(page.locator('note')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Full changelog' })).toHaveAttribute(
    'href', 'https://github.com/digitronics2025/Private-Browser/blob/main/CHANGELOG.md',
  );
});

test('keeps loading and failure states explicit and retryable', async ({ page }) => {
  const expectNoBrowserIssues = monitorBrowser(page);
  await page.goto('/?update=loading');
  await openSettings(page);
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
