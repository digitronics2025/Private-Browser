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
    const project = { project: { id: 'a'.repeat(32), name: 'Fixture workspace', trusted: true }, framework: 'Vite', packageManager: 'npm', types: ['vite-react'] };
    const commit = 'a'.repeat(40);
    let bridge: { state: string; browserVersion: string; extensionVersion?: string; project?: typeof project; pairingCode?: string; pairingExpiresAt?: number; activity?: string; vscodeVersion?: string; instanceId?: string } = connected
      ? { state: 'connected', browserVersion: '0.6.0', extensionVersion: '0.4.2', vscodeVersion: '1.95.3', instanceId: 'abad0000-0000-4000-8000-000000000010', project }
      : { state: 'disconnected', browserVersion: '0.4.0' };
    let ui: Record<string, unknown> = {};
    let server: Record<string, unknown> = { phase: 'stopped', expectedUrl: 'http://localhost:5173/' };
    let attempts = 0;
    let notify: ((value: ReturnType<typeof getState>) => void) | undefined;
    const getState = () => ({ ...state, ui });
    const api = new Proxy({
      getState: async () => getState(),
      onState: (listener: typeof notify) => { notify = listener; return () => { notify = undefined; }; },
      onCommand: () => () => undefined,
      onUpdateAvailable: () => () => undefined,
      getBridgeStatus: async () => bridge,
      getAiProvider: async () => ({ configured: false }),
      beginBridgePairing: async () => (bridge = { state: 'pairing', browserVersion: '0.4.0', pairingCode: '12345678', pairingExpiresAt: Date.now() + 300000 }),
      cancelBridgePairing: async () => (bridge = { state: 'disconnected', browserVersion: '0.4.0', activity: 'Pairing cancelled' }),
      listBridgeProjects: async () => [],
      setUiPreferences: async (patch: Record<string, unknown>) => { ui = { ...ui, ...patch }; notify?.(getState()); },
      runBridgeAction: async (action: string) => {
        if (action === 'project.revision') return { branch: 'topic/review', commit, staged: 1, unstaged: 2, untracked: 0, conflicts: 0, githubRepository: 'example/app' };
        if (action === 'server.status') return server;
        if (action === 'server.start') {
          attempts += 1;
          server = attempts === 1
            ? { phase: 'failed', expectedUrl: 'http://localhost:5173/', reason: 'port-in-use' }
            : { phase: 'ready', expectedUrl: 'http://localhost:5173/', address: 'http://localhost:5174/', port: 5174 };
          return server;
        }
        if (action === 'server.stop') {
          server = { phase: 'stopped', expectedUrl: 'http://localhost:5173/' };
          return { stopped: true };
        }
      },
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
  await page.getByRole('tab', { name: 'Developer Bridge' }).click();
  await expect(page.getByRole('heading', { name: 'Developer Bridge' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Project' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Inspect' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Test' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'AI Fix' })).toBeVisible();
  await page.clock.install();
  const guide = page.getByRole('region', { name: 'Set up the VS Code companion' });
  await expect(guide).toContainText('Private Browser: Pair with Browser');
  await guide.getByRole('button', { name: 'Generate pairing code', exact: true }).click();
  await expect(guide.getByLabel('Pairing code')).toHaveText('12345678');
  await expect(guide.locator('time')).toBeVisible();
  await guide.getByRole('button', { name: 'Cancel pairing' }).click();
  await expect(guide.getByLabel('Pairing code')).toHaveCount(0);
  await guide.getByRole('button', { name: 'Generate pairing code', exact: true }).click();
  await page.clock.fastForward(301_000);
  await expect(guide.getByLabel('Pairing code')).toHaveCount(0);
  await expect(guide.getByRole('button', { name: 'Generate new pairing code' })).toBeVisible();
});

test('keeps bridge actions hidden in Banking', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await installMock(page, 'banking'); await page.goto('/', { waitUntil: 'networkidle' }); await page.waitForTimeout(200);
  expect(errors).toEqual([]); await expect(page.locator('.app-shell')).toBeVisible();
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Developer Bridge' }).click();
  await expect(page.getByText('Protected by workspace policy')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate pairing code', exact: true })).toHaveCount(0);
});

test('opens the exact GitHub revision on request from a narrow Developer Bridge panel', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await installMock(page, 'development', true);
  await page.goto('/');
  const panelToggle = page.getByRole('button', { name: 'Side panel', exact: true });
  await panelToggle.click();
  await page.locator('#side-panel-tab-developer').click();
  const status = page.getByRole('region', { name: 'Connection details' });
  await expect(status).toContainText('0.4.2 · Protocol matched');
  await expect(status).toContainText('1.95.3 abad0000');
  await expect(status).toContainText('Fixture workspace · Approved');
  await status.getByRole('button', { name: 'Check connection status' }).click();
  const revision = page.getByRole('region', { name: 'Git revision' });
  await expect(revision).toHaveCount(1);
  await expect(revision.getByText('topic/review')).toBeVisible();
  await expect(revision.getByText('1 staged · 2 unstaged · 0 untracked · 0 conflicts')).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-opened-git-hub-url');
  await revision.getByRole('button', { name: 'Open commit' }).click();
  const destination = await page.locator('html').evaluate((root: HTMLElement) => root.dataset.openedGitHubUrl);
  expect(destination).toBe('https://github.com/example/app/commit/' + 'a'.repeat(40));
});

test('shows the selected project port, retries a conflict and stops the verified server', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await installMock(page, 'development', true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.locator('#side-panel-tab-developer').click();
  const server = page.getByRole('region', { name: 'Development server' });
  await expect(server).toContainText('Fixture workspace');
  await expect(server).toContainText('http://localhost:5173/');
  await server.getByRole('button', { name: 'Start server' }).click();
  await expect(server).toContainText('The expected port is already in use.');
  await expect(server.getByRole('button', { name: 'Open local server' })).toHaveCount(0);
  await server.getByRole('button', { name: 'Retry' }).click();
  await expect(server.getByRole('status')).toHaveText('Ready for local connections');
  await expect(server).toContainText('http://localhost:5174/');
  await server.getByRole('button', { name: 'Stop server' }).click();
  await expect(server.getByRole('status')).toHaveText('Stopped');
});
