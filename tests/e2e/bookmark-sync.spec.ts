import { expect, test } from '@playwright/test';

test('shows bookmark deletions and asks which conflict to keep before applying', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 850 });
  await page.addInitScript(() => {
    const workspace = { id: 'personal', name: 'Personal', color: '#4fd1a5', icon: 'P', protected: false };
    const account = { id: 'aaaa0000-abcd-4000-8000-000000000001', workspaceId: 'personal', label: 'Fixture', color: 'indigo',
      kind: 'google', googleConnection: 'connected', websiteStatus: 'not-visited', enabledModules: ['encrypted-backup'], grantedScopes: [], locked: false };
    const state = { activeWorkspaceId: 'personal', activeAccountSpaceId: account.id, activeTabId: 'home', browsingProtection: 'off',
      workspaces: [workspace], accountSpaces: [account], accountHealth: [], bookmarks: [], history: [], downloads: [], privacyLog: [],
      tabs: [{ id: 'home', accountSpaceId: account.id, workspaceId: 'personal', title: 'New tab', url: 'private://home', isHome: true, loading: false }],
      googleConfiguration: { configured: true }, externalBrowsers: [], sideApps: [], windowState: { maximized: false, fullscreen: false, darkMode: true },
      assistantPolicy: { cloud: 'unavailable', receipts: [] }, trackerBlocking: true, ui: {} as Record<string, unknown> };
    let notify: ((snapshot: typeof state) => void) | undefined;
    const handlers = {
      getState: async () => state,
      onState: (listener: typeof notify) => { notify = listener; return () => { notify = undefined; }; },
      onCommand: () => () => undefined,
      onUpdateAvailable: () => () => undefined,
      onDownloadProgress: () => () => undefined,
      onFindResult: () => () => undefined,
      setUiPreferences: async (patch: Record<string, unknown>) => { state.ui = { ...state.ui, ...patch }; notify?.({ ...state }); },
      changeBookmarkSync: async (_account: string, action: string, id?: string, choice?: string) => {
            const fixtureId = 'efaa0000-abcd-4000-8000-000000000003';
            if (action === 'review') return { id: fixtureId, expiresAt: new Date(Date.now() + 120_000).toISOString(),
              deviceBookmarks: 9, pairedBookmarks: 8, deviceOnlyBookmarks: 1, removedHere: 0, removedInPair: 1,
              conflicts: [{ id: 'fixture-bookmark', kind: 'bookmark', local: 'Edited locally · Research' }] };
            if (action === 'apply') document.documentElement.dataset.bookmarkSyncDecision = `${id}:${choice}`;
            return { enabled: true, initializing: false, lastSyncedAt: '2026-11-20T12:00:00Z' };
      },
    };
    Object.defineProperty(window, 'privateBrowser', { value: new Proxy(handlers, {
      get: (target, property) => property in target ? target[property as keyof typeof target] : async () => undefined,
    }) });
  });
  await page.goto('/');
  await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();
  await page.keyboard.press('Control+Shift+O');
  await expect(page.getByRole('heading', { name: 'Bookmarks', exact: true })).toBeVisible();
  await page.getByText('Encrypted bookmark sync', { exact: true }).click();
  await page.getByRole('button', { name: 'Review sync', exact: true }).click();
  const review = page.getByRole('region', { name: 'Bookmark sync review' });
  await expect(review).toContainText('Deleted in the paired library');
  await expect(review).toContainText('Removed since last sync');
  const apply = review.getByRole('button', { name: 'Apply bookmark sync' });
  await expect(apply).toBeDisabled();
  expect(await page.locator('html').getAttribute('data-bookmark-sync-decision')).toBeNull();
  await review.getByLabel('For these conflicts').selectOption('remote');
  await apply.click();
  await expect(page.locator('html')).toHaveAttribute('data-bookmark-sync-decision', 'efaa0000-abcd-4000-8000-000000000003:remote');
});
