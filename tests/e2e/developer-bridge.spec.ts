import { expect, test } from '@playwright/test';

function snapshot(workspaceId: 'development' | 'banking') {
  const workspaces = [
    { id: 'digitronics', name: 'Digitronics', color: '#5b8cff', icon: 'D', protected: false },
    { id: 'tenten', name: 'TenTen', color: '#ffbd59', icon: 'T', protected: false },
    { id: 'development', name: 'Development', color: '#a78bfa', icon: '</>', protected: false },
    { id: 'personal', name: 'Personal', color: '#4fd1a5', icon: 'P', protected: false },
    { id: 'banking', name: 'Banking', color: '#ff6b7a', icon: '$', protected: true },
  ];
  const accounts = workspaces.map((workspace, index) => ({ id: `00000000-0000-4000-8000-00000000000${index}`, workspaceId: workspace.id, label: workspace.name, color: 'indigo', order: 0, kind: 'local', createdAt: '2026-09-12T10:00:00Z', lastUsedAt: '2026-09-12T10:00:00Z', locked: false, googleConnection: 'disconnected', websiteStatus: 'not-visited', enabledModules: [], grantedScopes: [], backupEnabled: false, backupIncludesOpenTabs: false, backupIncludesHistory: false }));
  const tabs = workspaces.map((workspace, index) => ({ id: workspace.id, workspaceId: workspace.id, accountSpaceId: accounts[index].id, title: 'New tab', url: 'private://home', loading: false, canGoBack: false, canGoForward: false, isHome: true, developerToolsAllowed: false, developerToolsOpen: false }));
  const active = accounts.find((account) => account.workspaceId === workspaceId)!;
  return { workspaces, activeWorkspaceId: workspaceId, activeAccountSpaceId: active.id, activeTabId: workspaceId, tabs, bookmarks: [], history: [], downloads: [], privacyLog: [], trackerBlocking: true, bookmarkBarVisible: true, accountSpaces: accounts, accountHealth: accounts.map((account) => ({ accountSpaceId: account.id, status: account.googleConnection, checkedAt: '2026-09-12T10:00:00Z' })), googleConfiguration: { configured: false }, externalBrowsers: [] };
}

async function installMock(page: import('@playwright/test').Page, workspaceId: 'development' | 'banking', connected = false) {
  await page.addInitScript(({ state, connected }) => {
    const project = { project: { id: 'a'.repeat(32), name: 'Fixture workspace' }, framework: 'Vite', packageManager: 'npm', types: ['vite-react'] };
    const commit = 'a'.repeat(40);
    let bridge: { state: string; browserVersion: string; extensionVersion?: string; project?: typeof project; pairingCode?: string; pairingExpiresAt?: number } = connected
      ? { state: 'connected', browserVersion: '0.6.0', extensionVersion: '0.4.1', project }
      : { state: 'disconnected', browserVersion: '0.4.0' };
    const api = new Proxy({
      getState: async () => state,
      onState: () => () => undefined,
      onCommand: () => () => undefined,
      onUpdateAvailable: () => () => undefined,
      getBridgeStatus: async () => bridge,
      getAiProvider: async () => ({ configured: false }),
      beginBridgePairing: async () => (bridge = { state: 'pairing', browserVersion: '0.4.0', pairingCode: '12345678', pairingExpiresAt: Date.now() + 300000 }),
      listBridgeProjects: async () => [],
      runBridgeAction: async (action: string) => action === 'project.revision'
        ? { branch: 'topic/review', commit, staged: 1, unstaged: 2, untracked: 0, conflicts: 0, githubRepository: 'example/app' }
        : undefined,
      newTab: async (_workspace: string, url: string) => { document.documentElement.dataset.openedGitHubUrl = url; },
      setLayout: async () => undefined,
    }, { get: (target, property) => property in target ? target[property as keyof typeof target] : async () => undefined });
    Object.defineProperty(window, 'privateBrowser', { value: api });
  }, { state: snapshot(workspaceId), connected });
}

test('shows focused pairing and all four bridge tabs in Development', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await installMock(page, 'development'); await page.goto('/', { waitUntil: 'networkidle' }); await page.waitForTimeout(200);
  expect(errors).toEqual([]); await expect(page.locator('.app-shell')).toBeVisible();
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.getByTitle('Developer cockpit').evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByRole('heading', { name: 'Developer Bridge' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Project' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Inspect' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Test' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'AI Fix' })).toBeVisible();
  await page.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(page.getByText('Pair with 12345678')).toBeVisible();
});

test('keeps bridge actions hidden in Banking', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await installMock(page, 'banking'); await page.goto('/', { waitUntil: 'networkidle' }); await page.waitForTimeout(200);
  expect(errors).toEqual([]); await expect(page.locator('.app-shell')).toBeVisible();
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.getByTitle('Developer cockpit').evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText('Protected by workspace policy')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pair', exact: true })).toHaveCount(0);
});

test('opens the exact GitHub revision on request from a narrow Developer Bridge panel', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await installMock(page, 'development', true);
  await page.goto('/');
  const panelToggle = page.getByRole('button', { name: 'Side panel', exact: true });
  await panelToggle.click();
  await page.locator('#side-panel-tab-developer').click();
  const revision = page.getByRole('region', { name: 'Git revision' });
  await expect(revision.getByText('topic/review')).toBeVisible();
  await expect(revision.getByText('1 staged · 2 unstaged · 0 untracked · 0 conflicts')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-opened-git-hub-url');
  await revision.getByRole('button', { name: 'Open commit' }).click();
  const destination = await page.locator('html').evaluate((root: HTMLElement) => root.dataset.openedGitHubUrl);
  expect(destination).toBe('https://github.com/example/app/commit/' + 'a'.repeat(40));
});
