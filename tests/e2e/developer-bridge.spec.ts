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

async function installMock(page: import('@playwright/test').Page, workspaceId: 'development' | 'banking', connected = false, inspection = false, scenario = false) {
  await page.addInitScript(({ state, connected, inspection, scenario }) => {
    if (inspection) Object.assign(state.tabs.find((tab) => tab.id === state.activeTabId)!, {
      url: 'http://127.0.0.1:5173/catalogue.html', title: 'Inspection fixture', isHome: false, developerToolsAllowed: true,
    });
    const project = { project: { id: 'a'.repeat(32), name: 'Fixture workspace', trusted: true }, framework: 'Vite', packageManager: 'npm', types: ['vite-react'],
      ...(scenario ? { devServerUrl: 'http://127.0.0.1:5173/' } : {}) };
    const commit = 'a'.repeat(40);
    let bridge: { state: string; browserVersion: string; extensionVersion?: string; project?: typeof project; pairingCode?: string; pairingExpiresAt?: number; activity?: string; vscodeVersion?: string; instanceId?: string } = connected
      ? { state: 'connected', browserVersion: '0.6.0', extensionVersion: scenario ? '0.4.6' : '0.4.3', vscodeVersion: '1.95.3', instanceId: 'abad0000-0000-4000-8000-000000000010', project }
      : { state: 'disconnected', browserVersion: '0.4.0' };
    let ui: Record<string, unknown> = {};
    let server: Record<string, unknown> = { phase: 'stopped', expectedUrl: 'http://localhost:5173/' };
    let attempts = 0;
    const reportId = 'feca0000-0000-4000-8000-000000000010';
    const report = { id: reportId, projectId: project.project.id, title: 'Catalogue report', kind: 'responsive',
      status: 'failed', finishedAt: '2026-11-21T12:00:00Z', summary: 'Fixture report', findings: [], artifacts: [] };
    let rejectTest: ((error: Error) => void) | undefined;
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
      inspectDeveloperPage: async (pick: boolean) => ({
        route: '/catalogue.html', framework: 'Fixture', viewport: '390 × 800',
        failures: [{ at: '2026-11-21T12:01:00Z', firstAt: '2026-11-21T12:00:00Z', method: 'GET',
          resourceType: 'xhr', status: 503, count: 3, url: 'http://127.0.0.1:5173/api/items' }],
        ...(pick ? { element: 'button', selector: '#sample', confidence: 'nearest' }
          : { confidence: 'exact', sourcePath: 'catalogue.html', sourceReference: '00000000-0000-4000-8000-000000000001' }),
      }),
      setUiPreferences: async (patch: Record<string, unknown>) => { ui = { ...ui, ...patch }; notify?.(getState()); },
      runBridgeAction: async (action: string, payload: Record<string, unknown> = {}) => {
        const patch = { id: 'bade0000-0000-4000-8000-000000000010', files: ['example.ts'] };
        if (action === 'ai.review-patch') {
          document.documentElement.dataset.patchReview = JSON.stringify(payload.edits);
          return patch;
        }
        if (action === 'ai.apply-patch' || action === 'ai.undo-patch') {
          if (payload.id !== patch.id) throw new Error('The fixture did not receive the reviewed ID');
          document.documentElement.dataset.patchDecision = action;
          return patch;
        }
        if (action === 'inspect.open-source') document.documentElement.dataset.confirmedSource = String(payload.reference);
        if (action === 'project.revision') return { branch: 'topic/review', commit, staged: 1, unstaged: 2, untracked: 0, conflicts: 0, githubRepository: 'example/app' };
        if (action === 'reports.search') {
          const query = payload.query as { text?: string; status?: string; date?: string; project?: string };
          const row = { ...report, projectName: project.project.name, route: '/catalogue', findings: 2, artifacts: 1, replayable: true };
          document.documentElement.dataset.reportQuery = JSON.stringify(query);
          const visible = (!query.text || '/catalogue'.includes(query.text)) && (!query.status || query.status === row.status)
            && (!query.project || query.project === row.projectId) && (!query.date || row.finishedAt.startsWith(query.date));
          return { rows: visible ? [row] : [], total: visible ? 1 : 0, pages: 1, page: 1, projects: [project.project] };
        }
        if (action === 'test.rerun') {
          document.documentElement.dataset.replayedReport = String(payload.reportId);
          return report;
        }
        if (action === 'test.configuration') return { fixtures: ['catalogue.json'], keyboardFixtures: ['catalogue.json'] };
        if (action === 'test.run') {
          if (scenario) {
            document.documentElement.dataset.testScenario = JSON.stringify(payload);
            return report;
          }
          return new Promise((_resolve, reject) => { rejectTest = reject; });
        }
        if (action === 'test.cancel') {
          if (!rejectTest) return { stopped: false };
          rejectTest(new Error('Test stopped'));
          rejectTest = undefined;
          return { stopped: true };
        }
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
      copyText: async (value: string) => { document.documentElement.dataset.reportCopied = value; },
      newTab: async (_workspace: string, url: string) => { document.documentElement.dataset.openedGitHubUrl = url; },
      setLayout: async () => undefined,
    }, { get: (target, property) => property in target ? target[property as keyof typeof target] : async () => undefined });
    Object.defineProperty(window, 'privateBrowser', { value: api });
  }, { state: snapshot(workspaceId), connected, inspection, scenario });
}

for (const width of [430, 1280]) {
  test(`opens a separate patch review and waits for an explicit apply at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 850 });
    await installMock(page, 'development', true);
    await page.goto('/');
    await page.getByRole('button', { name: 'Side panel', exact: true }).click();
    await page.getByRole('tab', { name: 'Developer Bridge', exact: true }).click();
    await page.getByRole('tab', { name: 'AI Fix', exact: true }).click();
    const review = page.getByRole('region', { name: 'Review a proposed patch' });
    const proposed = JSON.stringify([{ path: 'example.ts', newText: 'export const enabled = true;' }]);
    await review.getByLabel('Proposed file replacements').fill(proposed);
    await review.getByRole('button', { name: 'Review in VS Code', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-patch-review', proposed);
    await expect(review.getByText('example.ts', { exact: true })).toBeVisible();
    expect(await page.locator('html').getAttribute('data-patch-decision')).toBeNull();
    await review.getByRole('button', { name: 'Apply reviewed patch', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-patch-decision', 'ai.apply-patch');
    await review.getByRole('button', { name: 'Undo patch', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-patch-decision', 'ai.undo-patch');
  });
}

test('sends the exact local route, fixture and selected viewports for baseline comparison', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await installMock(page, 'development', true, false, true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Developer Bridge' }).click();
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  const scenario = page.getByRole('group', { name: 'Local test scenario' });
  await scenario.getByLabel('Route', { exact: true }).fill('/catalogue/prices');
  await scenario.getByLabel('Data fixture').selectOption('catalogue.json');
  await scenario.getByLabel('Mobile', { exact: true }).check();
  await scenario.getByRole('button', { name: 'Compare with baseline' }).click();
  await expect.poll(() => page.locator('html').getAttribute('data-test-scenario')).toBe(JSON.stringify({
    kind: 'baseline-compare', url: 'http://127.0.0.1:5173/catalogue/prices', viewports: ['desktop', 'mobile'], fixture: 'catalogue.json',
  }));
  await scenario.getByRole('button', { name: 'Run keyboard smoke check' }).click();
  await expect.poll(() => page.locator('html').getAttribute('data-test-scenario')).toBe(JSON.stringify({
    kind: 'performance', url: 'http://127.0.0.1:5173/catalogue/prices', viewports: ['desktop', 'mobile'], fixture: 'catalogue.json',
  }));
  await scenario.getByLabel('Route', { exact: true }).fill('//external.example.test/catalogue');
  await expect(scenario.getByRole('button', { name: 'Save local baseline' })).toBeDisabled();
});

test('opens only a confirmed inspection source and displays grouped failures', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await installMock(page, 'development', true, true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.getByRole('tab', { name: 'Developer Bridge' }).click();
  await page.getByRole('tab', { name: 'Inspect', exact: true }).click();
  await page.getByRole('button', { name: 'Select element' }).click();
  await expect(page.getByText('#sample')).toBeVisible();
  await expect(page.getByText('Nearest editor match, source unconfirmed')).toBeVisible();
  const open = page.getByRole('button', { name: 'Open source in VS Code' });
  await expect(open).toHaveCount(0);
  const failures = page.getByRole('region', { name: 'Recent request failures' });
  await expect(failures.getByText('HTTP 503 · 3 occurrences')).toBeVisible();
  await expect(failures.getByText(/First .*Last /)).toBeVisible();
  await page.getByRole('button', { name: 'Inspect page' }).click();
  await expect(page.getByText('Confirmed source file')).toBeVisible();
  await open.click();
  await expect(page.locator('html')).toHaveAttribute('data-confirmed-source', '00000000-0000-4000-8000-000000000001');
});

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
  await expect(status).toContainText('0.4.3 · Protocol matched');
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

test('filters reports, reuses the selected test settings and copies only the reviewed export', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await installMock(page, 'development', true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.locator('#side-panel-tab-developer').click();
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  await page.getByRole('button', { name: 'Report history', exact: true }).click();
  const history = page.getByRole('region', { name: 'Report history' });
  const root = page.locator('html');
  await expect(history.getByRole('status')).toHaveText('1 report');
  await history.getByLabel('Project', { exact: true }).selectOption({ label: 'Fixture workspace' });
  await history.getByLabel('Report date').fill('2026-11-21');
  await history.getByLabel('Search title or route').fill('hidden');
  await expect(history.getByRole('status')).toHaveText('0 reports');
  await history.getByLabel('Search title or route').fill('/catalogue');
  await history.getByLabel('Result', { exact: true }).selectOption('failed');
  await expect(history.getByRole('status')).toHaveText('1 report');
  await history.getByRole('button', { name: 'Review export' }).click();
  const review = history.getByRole('region', { name: 'Sanitized export' });
  const exact = await review.locator('pre').textContent();
  expect(exact).toContain('"findingCount": 2');
  expect(exact).not.toContain('/catalogue');
  expect(exact).not.toContain('Fixture workspace');
  await expect(root).not.toHaveAttribute('data-report-copied', /./);
  await review.getByRole('button', { name: 'Copy JSON' }).click();
  await expect(root).toHaveAttribute('data-report-copied', exact!);
  await history.getByRole('button', { name: 'Rerun with saved settings' }).click();
  await expect(root).toHaveAttribute('data-replayed-report', 'feca0000-0000-4000-8000-000000000010');
  await expect(history.getByLabel('Search title or route')).toHaveValue('/catalogue');
});

test('stops a test while the report is still pending', async ({ page }) => {
  await installMock(page, 'development', true);
  await page.goto('/');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await page.locator('#side-panel-tab-developer').click();
  await page.getByRole('tab', { name: 'Test', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop test' });
  await expect(stop).toBeDisabled();
  await page.getByRole('button', { name: 'Quick Test' }).click();
  await expect(stop).toBeEnabled();
  await stop.click();
  await expect(page.getByText('Test stopped', { exact: true })).toBeVisible();
  await expect(stop).toBeDisabled();
});
