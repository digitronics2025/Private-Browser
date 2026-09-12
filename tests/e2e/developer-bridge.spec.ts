import { expect, test } from '@playwright/test';

function snapshot(workspaceId: 'development' | 'banking') {
  const workspaces = [
    { id: 'digitronics', name: 'Digitronics', color: '#5b8cff', icon: 'D', protected: false },
    { id: 'tenten', name: 'TenTen', color: '#ffbd59', icon: 'T', protected: false },
    { id: 'development', name: 'Development', color: '#a78bfa', icon: '</>', protected: false },
    { id: 'personal', name: 'Personal', color: '#4fd1a5', icon: 'P', protected: false },
    { id: 'banking', name: 'Banking', color: '#ff6b7a', icon: '$', protected: true },
  ];
  const tabs = workspaces.map((workspace) => ({ id: workspace.id, workspaceId: workspace.id, title: 'New tab', url: 'private://home', loading: false, canGoBack: false, canGoForward: false, isHome: true, developerToolsAllowed: false, developerToolsOpen: false }));
  return { workspaces, activeWorkspaceId: workspaceId, activeTabId: workspaceId, tabs, bookmarks: [], history: [], downloads: [], privacyLog: [], trackerBlocking: true };
}

async function installMock(page: import('@playwright/test').Page, workspaceId: 'development' | 'banking') {
  await page.addInitScript(({ state }) => {
    let bridge: { state: string; browserVersion: string; pairingCode?: string; pairingExpiresAt?: number } = { state: 'disconnected', browserVersion: '0.4.0' };
    const api = new Proxy({
      getState: async () => state,
      onState: () => () => undefined,
      onFocusAddress: () => () => undefined,
      onUpdateAvailable: () => () => undefined,
      getBridgeStatus: async () => bridge,
      getAiProvider: async () => ({ configured: false }),
      beginBridgePairing: async () => (bridge = { state: 'pairing', browserVersion: '0.4.0', pairingCode: '12345678', pairingExpiresAt: Date.now() + 300000 }),
      listBridgeProjects: async () => [],
      setLayout: async () => undefined,
    }, { get: (target, property) => property in target ? target[property as keyof typeof target] : async () => undefined });
    Object.defineProperty(window, 'privateBrowser', { value: api });
  }, { state: snapshot(workspaceId) });
}

test('shows focused pairing and all four bridge tabs in Development', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await installMock(page, 'development'); await page.goto('/', { waitUntil: 'networkidle' }); await page.waitForTimeout(200);
  expect(errors).toEqual([]); await expect(page.locator('.app-shell')).toBeVisible();
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
  await page.getByTitle('Developer cockpit').evaluate((element: HTMLButtonElement) => element.click());
  await expect(page.getByText('Protected by workspace policy')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pair', exact: true })).toHaveCount(0);
});
