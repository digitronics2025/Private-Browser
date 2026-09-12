import type { PrivateBrowserApi } from '../electron/preload.cjs';
import type { AccountSpaceId, BrowserSnapshot, Workspace, WorkspaceId } from '../electron/types';

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

export function installPreviewApi(): void {
  if (!import.meta.env.DEV || 'privateBrowser' in window) return;
  const accounts = [
    account(ids.digitronics, 'digitronics', 'Digitronics', 'indigo'), account(ids.tenten, 'tenten', 'TenTen', 'amber'), account(ids.development, 'development', 'Development', 'violet'),
    account(ids.personal, 'personal', 'Personal', 'emerald'),
    { ...account(ids.google, 'personal', 'Operations', 'sky', 1), kind: 'google' as const, email: 'operations@example.com', displayName: 'Operations Team', googleConnection: 'connected' as const, websiteStatus: 'session-data-present' as const, enabledModules: ['identity', 'gmail-metadata', 'drive-files', 'calendar-read'] as const, grantedScopes: ['openid', 'email', 'profile'] },
    account(ids.banking, 'banking', 'Banking', 'rose'),
  ];
  const state: BrowserSnapshot = {
    workspaces: WORKSPACES,
    activeWorkspaceId: 'personal',
    activeAccountSpaceId: ids.google as AccountSpaceId,
    activeTabId: `preview-${ids.google}`,
    tabs: accounts.map((item) => ({ id: `preview-${item.id}`, workspaceId: item.workspaceId, accountSpaceId: item.id, title: 'New tab', url: 'private://home', loading: false, canGoBack: false, canGoForward: false, isHome: true, developerToolsAllowed: false, developerToolsOpen: false })),
    bookmarks: [{ id: 'preview-bookmark', workspaceId: 'personal', accountSpaceId: ids.google as AccountSpaceId, title: 'Google Drive', url: 'https://drive.google.com/', createdAt: '2026-09-12T11:00:00Z' }],
    history: [{ id: 'preview-history', workspaceId: 'personal', accountSpaceId: ids.google as AccountSpaceId, title: 'Calendar', url: 'https://calendar.google.com/', visitedAt: new Date().toISOString() }],
    downloads: [], privacyLog: [], trackerBlocking: true,
    accountSpaces: accounts.map((item) => ({ ...item, enabledModules: [...item.enabledModules], grantedScopes: [...item.grantedScopes] })),
    accountHealth: accounts.map((item) => ({ accountSpaceId: item.id, status: item.googleConnection, checkedAt: '2026-09-12T12:00:00Z' })),
    googleConfiguration: { configured: true, source: 'encrypted-settings' },
    externalBrowsers: [{ id: 'edge', name: 'Microsoft Edge' }, { id: 'chrome', name: 'Google Chrome' }],
  };
  const listeners = new Set<(snapshot: BrowserSnapshot) => void>();
  const publish = () => listeners.forEach((listener) => listener(structuredClone(state)));
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    getState: async () => structuredClone(state),
    onState: (callback) => { listeners.add(callback as (snapshot: BrowserSnapshot) => void); return () => listeners.delete(callback as (snapshot: BrowserSnapshot) => void); },
    onFocusAddress: () => () => undefined,
    onUpdateAvailable: () => () => undefined,
    onGoogleOperationProgress: () => () => undefined,
    setLayout: async () => undefined,
    setOverlayOpen: async () => undefined,
    switchAccountSpace: async (value) => { const id = value as AccountSpaceId; const selected = state.accountSpaces.find((item) => item.id === id); if (!selected || selected.locked) throw new Error('Account Space is unavailable'); state.activeAccountSpaceId = id; state.activeWorkspaceId = selected.workspaceId; state.activeTabId = state.tabs.find((tab) => tab.accountSpaceId === id)!.id; publish(); },
    switchWorkspace: async (value) => { const workspaceId = value as WorkspaceId; state.activeWorkspaceId = workspaceId; state.activeAccountSpaceId = state.accountSpaces.find((item) => item.workspaceId === workspaceId)!.id; state.activeTabId = state.tabs.find((tab) => tab.accountSpaceId === state.activeAccountSpaceId)!.id; publish(); },
    addLocalAccountSpace: async (workspaceValue, labelValue, colorValue) => { const id = crypto.randomUUID() as AccountSpaceId; const created = account(id, workspaceValue as WorkspaceId, String(labelValue), colorValue as 'indigo'); state.accountSpaces.push(created); state.tabs.push({ id: `preview-${id}`, workspaceId: created.workspaceId, accountSpaceId: id, title: 'New tab', url: 'private://home', loading: false, canGoBack: false, canGoForward: false, isHome: true, developerToolsAllowed: false, developerToolsOpen: false }); state.activeAccountSpaceId = id; state.activeTabId = `preview-${id}`; publish(); return id; },
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
    getUpdateService: async () => ({ configured: false, currentVersion: '0.3.1' }),
    listVault: async () => ({ available: true, items: [] }),
  };
  const api = new Proxy(handlers, { get(target, property) { return target[String(property)] ?? (async () => undefined); } });
  Object.defineProperty(window, 'privateBrowser', { value: api as unknown as PrivateBrowserApi, configurable: true });
}
