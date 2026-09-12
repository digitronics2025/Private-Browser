import type { PrivateBrowserApi } from '../electron/preload.cjs';
import type { AccountSpaceId, BridgeStatus, BrowserSnapshot } from '../electron/types';

export function installLocalBridgePreview(): void {
  if (window.privateBrowser || !['127.0.0.1', 'localhost'].includes(location.hostname) || new URLSearchParams(location.search).get('preview') !== 'bridge') return;
  const workspaces = [
    { id: 'digitronics' as const, name: 'Digitronics', color: '#5b8cff', icon: 'D', protected: false },
    { id: 'tenten' as const, name: 'TenTen', color: '#ffbd59', icon: 'T', protected: false },
    { id: 'development' as const, name: 'Development', color: '#a78bfa', icon: '</>', protected: false },
    { id: 'personal' as const, name: 'Personal', color: '#4fd1a5', icon: 'P', protected: false },
    { id: 'banking' as const, name: 'Banking', color: '#ff6b7a', icon: '$', protected: true },
  ];
  const accounts = workspaces.map((workspace, order) => ({ id: `00000000-0000-4000-8000-00000000000${order}` as AccountSpaceId, workspaceId: workspace.id, label: workspace.name, color: 'indigo' as const, order: 0, kind: 'local' as const, createdAt: '2026-09-12T10:00:00Z', lastUsedAt: '2026-09-12T10:00:00Z', locked: false, googleConnection: 'disconnected' as const, websiteStatus: 'not-visited' as const, enabledModules: [], grantedScopes: [], backupEnabled: false, backupIncludesOpenTabs: false, backupIncludesHistory: false }));
  const tabs = workspaces.map((workspace, index) => ({ id: workspace.id, workspaceId: workspace.id, accountSpaceId: accounts[index].id, title: workspace.id === 'development' ? 'Developer Preview' : 'New tab', url: workspace.id === 'development' ? 'http://127.0.0.1:4173/' : 'private://home', loading: false, canGoBack: false, canGoForward: false, isHome: workspace.id !== 'development', developerToolsAllowed: workspace.id === 'development', developerToolsOpen: false }));
  const developmentAccount = accounts.find((account) => account.workspaceId === 'development')!;
  const snapshot: BrowserSnapshot = { workspaces, activeWorkspaceId: 'development', activeAccountSpaceId: developmentAccount.id, activeTabId: 'development', tabs, bookmarks: [], history: [], downloads: [], privacyLog: [], trackerBlocking: true, bookmarkBarVisible: true, accountSpaces: accounts, accountHealth: accounts.map((account) => ({ accountSpaceId: account.id, status: 'disconnected', checkedAt: '2026-09-12T10:00:00Z' })), googleConfiguration: { configured: false }, externalBrowsers: [] };
  let bridge: BridgeStatus = { state: 'disconnected', browserVersion: '0.4.0' };
  const target = {
    getState: async () => snapshot,
    onState: () => () => undefined,
    onFocusAddress: () => () => undefined,
    onUpdateAvailable: () => () => undefined,
    setLayout: async () => undefined,
    getAiProvider: async () => ({ configured: false as const }),
    getBridgeStatus: async () => bridge,
    beginBridgePairing: async () => (bridge = { state: 'pairing', browserVersion: '0.4.0', pairingCode: '12345678', pairingExpiresAt: Date.now() + 300_000 }),
    listBridgeProjects: async () => [],
  };
  window.privateBrowser = new Proxy(target, { get: (value, property) => property in value ? value[property as keyof typeof value] : async () => undefined }) as unknown as PrivateBrowserApi;
}
