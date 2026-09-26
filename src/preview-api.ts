import type { PrivateBrowserApi } from '../electron/preload.cjs';
import type { AccountSpaceId, Bookmark, BrowserSnapshot, BrowserTab, ShortcutTile, UiPreferencesPatch, Workspace, WorkspaceId } from '../electron/types';
import { mergeUiPreferences, DEFAULT_UI_PREFERENCES } from '../electron/ui-preferences';
import { DEFAULT_BROWSER_SETTINGS, mergeBrowserSettings, requireBrowserSettingsPatch, resolveHomeUrl, searchTemplateFor } from '../electron/browser-settings';
import { parseWebAddress } from '../electron/security';
import { moveTabWithinAccountSpace, removeBookmark, renameBookmark, reorderBookmarkEntry } from '../electron/bookmark-tree';

const WORKSPACES: Workspace[] = [
  { id: 'digitronics', name: 'Digitronics', color: '#6a92ff', icon: 'D', protected: false },
  { id: 'tenten', name: 'TenTen', color: '#ffbd59', icon: 'T', protected: false },
  { id: 'development', name: 'Development', color: '#a78bfa', icon: '</>', protected: false },
  { id: 'personal', name: 'Personal', color: '#4fd1a5', icon: 'P', protected: false },
  { id: 'banking', name: 'Banking', color: '#ff6b7a', icon: 'B', protected: true },
];

const ids = {
  digitronics: '11f6ab55-582f-4b7d-bcb3-b1f0da787fba', tenten: '28b49df5-9286-40b4-84e5-c7cf20423725', development: '3bb91e1b-802d-4ca9-b359-e10f2d5f80ea',
  personal: '488b65fc-5f95-4d2b-af17-2cfd11b999f0', banking: '50c9995c-d128-4a9e-a636-7e3988086987', google: '6be141ef-05f1-46d6-bd35-d743c85faf03',
} as const satisfies Record<string, string>;

function account(id: string, workspaceId: WorkspaceId, label: string, color: 'indigo' | 'sky' | 'emerald' | 'amber' | 'rose' | 'violet' | 'slate', order = 0) {
  return { id: id as AccountSpaceId, workspaceId, label, color, order, kind: 'local' as const, createdAt: '2026-09-12T10:00:00Z', lastUsedAt: '2026-09-12T12:00:00Z', locked: false, googleConnection: 'disconnected' as const, websiteStatus: 'not-visited' as const, enabledModules: [], grantedScopes: [], backupEnabled: false, backupIncludesOpenTabs: false, backupIncludesHistory: false };
}

function homeTab(id: string, workspaceId: WorkspaceId, accountSpaceId: AccountSpaceId): BrowserTab {
  return { id, workspaceId, accountSpaceId, title: 'New tab', url: 'private://home', loading: false, canGoBack: false, canGoForward: false, isHome: true, developerToolsAllowed: false, developerToolsOpen: false };
}

function pageTab(id: string, accountSpaceId: AccountSpaceId, title: string, url: string, extra: Partial<BrowserTab> = {}): BrowserTab {
  return { ...homeTab(id, 'personal', accountSpaceId), title, url, isHome: false, canGoBack: true, zoomPercent: 100, securityWarning: url.startsWith('http:') ? 'insecure' : undefined, ...extra };
}

function bookmark(id: string, title: string, url: string, folderPath: string[], orderPath: number[], location: Bookmark['location'] = 'bar'): Bookmark {
  return { id, workspaceId: 'personal', accountSpaceId: ids.google as AccountSpaceId, title, url, createdAt: '2026-09-12T11:00:00Z', location, folderPath, order: orderPath[0], orderPath };
}

/** Credential-free data so the chrome can be reviewed in a normal browser during development. */
export function installPreviewApi(): void {
  if (!import.meta.env.DEV || 'privateBrowser' in window || new URLSearchParams(location.search).get('preview') === 'bridge') return;
  const accounts = [
    account(ids.digitronics, 'digitronics', 'Digitronics', 'indigo'), account(ids.tenten, 'tenten', 'TenTen', 'amber'), account(ids.development, 'development', 'Development', 'violet'),
    account(ids.personal, 'personal', 'Personal', 'emerald'),
    { ...account(ids.google, 'personal', 'Operations', 'sky', 1), kind: 'google' as const, email: 'operations@example.com', displayName: 'Operations Team', googleConnection: 'connected' as const, websiteStatus: 'session-data-present' as const, enabledModules: ['identity', 'gmail-metadata', 'drive-files', 'calendar-read'] as const, grantedScopes: ['openid', 'email', 'profile'] },
    account(ids.banking, 'banking', 'Banking', 'rose'),
  ];
  const google = ids.google as AccountSpaceId;
  const params = new URLSearchParams(location.search);
  const state: BrowserSnapshot = {
    settings: { ...DEFAULT_BROWSER_SETTINGS },
    workspaces: WORKSPACES,
    activeWorkspaceId: 'personal',
    activeAccountSpaceId: google,
    activeTabId: `preview-${ids.google}`,
    tabs: [
      ...accounts.map((item) => homeTab(`preview-${item.id}`, item.workspaceId, item.id)),
      pageTab('preview-docs', google, 'Quarterly operations review — shared planning document with a very long title', 'https://docs.google.com/document/d/preview'),
      pageTab('preview-media', google, 'Team update video', 'https://media.example.com/watch', { audible: true }),
      pageTab('preview-intranet', google, 'Legacy intranet dashboard', 'http://intranet.example.test/'),
      // Loopback development servers carry no warning chip but are still unencrypted.
      pageTab('preview-localdev', google, 'Local dev server', 'http://localhost:4173/', { securityWarning: undefined }),
    ],
    bookmarks: [
      bookmark('preview-bookmark', 'Google Drive', 'https://drive.google.com/', [], [0]),
      bookmark('preview-calendar', 'Calendar', 'https://calendar.google.com/', [], [1]),
      bookmark('preview-finance-1', 'Invoices', 'https://billing.example.com/invoices', ['Finance'], [2, 0]),
      bookmark('preview-finance-2', 'Supplier payments', 'https://billing.example.com/payments', ['Finance'], [2, 1]),
      bookmark('preview-finance-3', 'Annual reports', 'https://reports.example.com/', ['Finance', 'Reports'], [2, 2, 0]),
      bookmark('preview-marketing', 'Campaign planner', 'https://planner.example.com/', ['Marketing'], [3, 0]),
      ...Array.from({ length: 14 }, (_, index) => bookmark(`preview-extra-${index}`, `Supplier portal ${index + 1}`, `https://supplier${index + 1}.example.com/`, [], [4 + index])),
      bookmark('preview-other', 'Reading list article', 'https://news.example.com/article', [], [0], 'other'),
    ],
    history: [{ id: 'preview-history', workspaceId: 'personal', accountSpaceId: google, title: 'Calendar', url: 'https://calendar.google.com/', visitedAt: new Date().toISOString() }],
    downloads: [], privacyLog: [], trackerBlocking: true, bookmarkBarVisible: true,
    accountSpaces: accounts.map((item) => ({ ...item, enabledModules: [...item.enabledModules], grantedScopes: [...item.grantedScopes] })),
    accountHealth: accounts.map((item) => ({ accountSpaceId: item.id, status: item.googleConnection, checkedAt: '2026-09-12T12:00:00Z' })),
    googleConfiguration: { configured: true, source: 'encrypted-settings' },
    externalBrowsers: [{ id: 'edge', name: 'Microsoft Edge' }, { id: 'chrome', name: 'Google Chrome' }],
    ui: { ...DEFAULT_UI_PREFERENCES, sidePanelOpen: params.get('panel') === 'open', theme: params.get('theme') === 'light' ? 'light' : params.get('theme') === 'dark' ? 'dark' : 'system' },
    windowState: { maximized: false, fullscreen: false, darkMode: true },
    shortcutsByAccountSpace: {},
    bookmarkIcons: {},
    canReopenClosedTab: false,
    sideApps: [{ id: 'claude', name: 'Claude', status: 'ready', canGoBack: false, canGoForward: false }],
    // ?permission=prompt shows a pending site-permission prompt for the e2e suite.
    ...(params.get('permission') === 'prompt' ? { pendingPermission: { id: 'preview-permission', accountSpaceId: ids.personal as AccountSpaceId, workspaceId: 'personal' as const, origin: 'https://meet.google.com', capability: 'notifications' as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } } : {}),
  };
  const media = matchMedia('(prefers-color-scheme: dark)');
  const syncDarkMode = () => { state.windowState.darkMode = state.ui.theme === 'system' ? media.matches : state.ui.theme === 'dark'; };
  syncDarkMode();
  const listeners = new Set<(snapshot: BrowserSnapshot) => void>();
  const publish = () => { state.bookmarkBarVisible = state.ui.bookmarkBarMode !== 'hidden'; listeners.forEach((listener) => listener(structuredClone(state))); };
  media.addEventListener('change', () => { syncDarkMode(); publish(); });
  const activeTab = () => state.tabs.find((tab) => tab.id === state.activeTabId)!;
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    getState: async () => structuredClone(state),
    onState: (callback) => { listeners.add(callback as (snapshot: BrowserSnapshot) => void); return () => listeners.delete(callback as (snapshot: BrowserSnapshot) => void); },
    onCommand: () => () => undefined,
    onFindResult: () => () => undefined,
    onUpdateAvailable: () => () => undefined,
    onGoogleOperationProgress: () => () => undefined,
    onVaultState: () => () => undefined,
    // Recorded on the document so browser tests can compare it with the visible chrome.
    setLayout: async (layout) => { document.documentElement.dataset.previewLayout = JSON.stringify(layout); },
    setOverlayOpen: async () => undefined,
    // A normal browser has no native view to place; record the slot for browser tests instead.
    setSideAppBounds: async (_id, rect) => { document.documentElement.dataset.previewSideApp = JSON.stringify(rect); },
    sideAppCommand: async () => undefined,
    clearSideAppData: async () => undefined,
    respondToPermissionPrompt: async (_id, decision) => { document.documentElement.dataset.previewPermission = String(decision); state.pendingPermission = undefined; publish(); },
    freezeContent: async () => null,
    // Same rules as the main process: validated patch, Home address normalized, Banking Home is the New Tab page.
    setBrowserSettings: async (value) => {
      const patch = requireBrowserSettingsPatch(value);
      if (patch.homePageUrl !== undefined) {
        const url = parseWebAddress(patch.homePageUrl);
        if (!url) throw new Error('Enter a web address, for example tenten.ma');
        patch.homePageUrl = url;
      }
      state.settings = mergeBrowserSettings(state.settings, patch);
      publish();
    },
    goHome: async () => {
      const protectedWorkspace = WORKSPACES.find((item) => item.id === activeTab().workspaceId)?.protected ?? false;
      await handlers.navigate(resolveHomeUrl(state.settings, protectedWorkspace));
    },
    setUiPreferences: async (patch) => { state.ui = mergeUiPreferences(state.ui, patch as UiPreferencesPatch); syncDarkMode(); publish(); },
    toggleBookmarkBar: async () => { state.ui = mergeUiPreferences(state.ui, { bookmarkBarMode: state.ui.bookmarkBarMode === 'hidden' ? 'always' : 'hidden' }); publish(); },
    activateTab: async (value) => { const tab = state.tabs.find((item) => item.id === value); if (tab) { state.activeTabId = tab.id; publish(); } },
    newTab: async () => { const id = `preview-${crypto.randomUUID()}`; state.tabs.push(homeTab(id, state.activeWorkspaceId, state.activeAccountSpaceId)); state.activeTabId = id; publish(); },
    closeTab: async (value) => {
      const tab = state.tabs.find((item) => item.id === value);
      if (!tab) return;
      const siblings = state.tabs.filter((item) => item.accountSpaceId === tab.accountSpaceId);
      if (siblings.length === 1) { Object.assign(tab, homeTab(tab.id, tab.workspaceId, tab.accountSpaceId)); publish(); return; }
      const index = siblings.indexOf(tab);
      state.tabs = state.tabs.filter((item) => item.id !== tab.id);
      if (state.activeTabId === tab.id) state.activeTabId = siblings[index + 1]?.id ?? siblings[index - 1].id;
      publish();
    },
    moveTab: async (idValue, indexValue) => { state.tabs = moveTabWithinAccountSpace(state.tabs, String(idValue), Number(indexValue)); publish(); },
    navigate: async (value) => {
      const text = String(value);
      const tab = activeTab();
      if (text === 'private://home') Object.assign(tab, { url: text, title: 'New tab', isHome: true });
      else {
        const url = /^https?:\/\//.test(text) ? text : searchTemplateFor(state.settings).replace('%s', () => encodeURIComponent(text));
        Object.assign(tab, { url, title: new URL(url).hostname, isHome: false, zoomPercent: 100, securityWarning: url.startsWith('http:') ? 'insecure' : undefined });
      }
      publish();
    },
    openBookmark: async (value) => { const item = state.bookmarks.find((entry) => entry.id === value); if (item) { const id = `preview-${crypto.randomUUID()}`; state.tabs.push(pageTab(id, state.activeAccountSpaceId, item.title, item.url)); state.activeTabId = id; publish(); } },
    toggleBookmark: async () => {
      const tab = activeTab();
      if (tab.isHome) return;
      const existing = state.bookmarks.find((item) => item.url === tab.url && item.accountSpaceId === tab.accountSpaceId);
      state.bookmarks = existing ? state.bookmarks.filter((item) => item !== existing) : [...state.bookmarks, { id: crypto.randomUUID(), workspaceId: tab.workspaceId, accountSpaceId: tab.accountSpaceId, title: tab.title, url: tab.url, createdAt: new Date().toISOString(), location: 'bar', folderPath: [], order: 99, orderPath: [99] }];
      publish();
    },
    moveBookmark: async (levelValue, keyValue, indexValue) => { state.bookmarks = reorderBookmarkEntry(state.bookmarks, state.activeAccountSpaceId, levelValue as { location: 'bar'; path: string[] }, keyValue as { kind: 'bookmark'; id: string }, Number(indexValue)); publish(); },
    renameBookmark: async (idValue, titleValue) => { state.bookmarks = renameBookmark(state.bookmarks, String(idValue), String(titleValue)); publish(); },
    removeBookmark: async (idValue) => { state.bookmarks = removeBookmark(state.bookmarks, String(idValue)); publish(); },
    setShortcutTiles: async (idValue, tilesValue) => { if (tilesValue === null) delete state.shortcutsByAccountSpace[String(idValue)]; else state.shortcutsByAccountSpace[String(idValue)] = tilesValue as ShortcutTile[]; publish(); },
    toggleTrackerBlocking: async () => { state.trackerBlocking = !state.trackerBlocking; publish(); },
    switchAccountSpace: async (value) => { const id = value as AccountSpaceId; const selected = state.accountSpaces.find((item) => item.id === id); if (!selected || selected.locked) throw new Error('Account Space is unavailable'); state.activeAccountSpaceId = id; state.activeWorkspaceId = selected.workspaceId; state.activeTabId = state.tabs.find((tab) => tab.accountSpaceId === id)!.id; publish(); },
    switchWorkspace: async (value) => { const workspaceId = value as WorkspaceId; state.activeWorkspaceId = workspaceId; state.activeAccountSpaceId = state.accountSpaces.find((item) => item.workspaceId === workspaceId)!.id; state.activeTabId = state.tabs.find((tab) => tab.accountSpaceId === state.activeAccountSpaceId)!.id; publish(); },
    addLocalAccountSpace: async (workspaceValue, labelValue, colorValue) => { const id = crypto.randomUUID() as AccountSpaceId; const created = account(id, workspaceValue as WorkspaceId, String(labelValue), colorValue as 'indigo'); state.accountSpaces.push(created); state.tabs.push(homeTab(`preview-${id}`, created.workspaceId, id)); state.activeAccountSpaceId = id; state.activeTabId = `preview-${id}`; publish(); return id; },
    updateAccountSpace: async (idValue, labelValue, colorValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { if (typeof labelValue === 'string') selected.label = labelValue; if (typeof colorValue === 'string') selected.color = colorValue as typeof selected.color; publish(); } },
    reorderAccountSpaces: async (_workspace, orderValue) => { (orderValue as AccountSpaceId[]).forEach((id, order) => { const item = state.accountSpaces.find((candidate) => candidate.id === id); if (item) item.order = order; }); publish(); },
    openInAccountSpace: async () => undefined,
    setAccountSpaceLocked: async (idValue, lockedValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.locked = Boolean(lockedValue); selected.googleConnection = selected.locked ? 'locked' : 'disconnected'; publish(); } },
    configureGoogle: async () => { state.googleConfiguration = { configured: true, source: 'encrypted-settings' }; publish(); },
    connectGoogleAccount: async (idValue, modulesValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.kind = 'google'; selected.email = selected.email ?? 'account@example.com'; selected.googleConnection = 'connected'; selected.enabledModules = [...modulesValue as typeof selected.enabledModules]; publish(); } return { ok: true }; },
    disconnectGoogleAccount: async (idValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.googleConnection = 'disconnected'; publish(); } return { ok: true }; },
    createBackupRecoveryCode: async () => `PB1-${'A'.repeat(43)}`,
    verifyAndEnableBackup: async (idValue, _code, includeOpenTabsValue, includeHistoryValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.backupEnabled = true; selected.backupIncludesOpenTabs = Boolean(includeOpenTabsValue); selected.backupIncludesHistory = Boolean(includeHistoryValue); publish(); } },
    uploadBackup: async () => ({ status: 'uploaded', etag: 'preview-etag' }),
    getAiProvider: async () => ({ configured: false }),
    getDefaultBrowserStatus: async () => false,
    getUpdateService: async () => ({ configured: false, currentVersion: '0.5.7', source: 'public' as const, endpoint: 'https://private-browser-downloads.digitronics-electro.workers.dev' }),
    checkForUpdates: async () => {
      const updateMode = new URLSearchParams(location.search).get('update');
      if (updateMode === 'loading') await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      if (updateMode === 'error') throw new Error('The public update service could not be reached');
      const latestVersion = updateMode === 'available' ? '0.5.8' : '0.5.7';
      return {
        state: updateMode === 'available' ? 'available' as const : 'up-to-date' as const,
        currentVersion: '0.5.7',
        latest: {
          schemaVersion: 1 as const,
          appId: 'private-browser' as const,
          version: latestVersion,
          buildNumber: 83,
          channel: 'stable' as const,
          publishedAt: '2026-09-12T18:20:00.000Z',
          filename: `Private-Browser-${latestVersion}-Setup.exe`,
          sizeBytes: 115_638_545,
          sha256: '259a374e199949d72b7fa87c6aed3eef9834340b99ed5dfd17da68038a922eec',
          commitSha: 'fabad9b310b10efcc7332e88599620db8d437b2a',
          releaseNotes: 'Latest stable security, privacy, and reliability improvements.',
          downloadUrl: 'https://private-browser-downloads.digitronics-electro.workers.dev/download/latest.exe?expires=9999999999&signature=preview',
          downloadPageUrl: 'https://private-browser-downloads.digitronics-electro.workers.dev/download?expires=9999999999&signature=preview',
          expiresAt: '2286-11-20T17:46:39.000Z',
        },
        checkedAt: new Date().toISOString(),
      };
    },
    listVault: async () => ({ available: true, items: [], lifecycle: 'unlocked', sync: 'idle', dirty: false, generation: 1 }),
    getVaultMigrationStatus: async () => ({ legacyAvailable: false }),
    // The Control Center link, paired, with one task (docs/systems/control-center-link.md).
    getControlCenterStatus: async () => ({ state: 'connected', url: 'http://127.0.0.1:4317', fingerprint: '4F1C 9A2E 77D0 13B8 C6E5 0A94 2D61 F3B7' }),
    listControlCenterRepositories: async () => ({ repositories: [{ id: 'repo-shop', name: 'shop', devOrigin: 'http://127.0.0.1:5173' }, { id: 'repo-site', name: 'site', devOrigin: null }], suggestedId: 'repo-shop' }),
    listControlCenterTasks: async () => [{ id: 'TASK-0042', title: 'The cart page crashes when it is empty', repositoryName: 'shop', status: 'COMPLETED', currentStageName: 'Complete', blocker: null, finalStatus: 'READY', createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:20:00.000Z', dashboardUrl: 'http://127.0.0.1:4317/tasks/TASK-0042' }],
    sendToControlCenter: async () => ({ id: 'TASK-0043', title: 'Preview task', repositoryName: 'shop', status: 'QUEUED', currentStageName: 'Investigate', blocker: null, finalStatus: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dashboardUrl: 'http://127.0.0.1:4317/tasks/TASK-0043' }),
    recheckControlCenterTask: async () => ({ name: 'browser-recheck-1.md' }),
    inspectVaultFormShape: async () => ({ hasUsername: false, hasPassword: false }),
  };
  const api = new Proxy(handlers, { get(target, property) { return target[String(property)] ?? (async () => undefined); } });
  Object.defineProperty(window, 'privateBrowser', { value: api as unknown as PrivateBrowserApi, configurable: true });
}
