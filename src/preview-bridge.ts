import type { PrivateBrowserApi } from '../electron/preload.cjs';
import type { BridgeStatus, BrowserSnapshot } from '../electron/types';

export function installLocalBridgePreview(): void {
  if (window.privateBrowser || !['127.0.0.1', 'localhost'].includes(location.hostname) || new URLSearchParams(location.search).get('preview') !== 'bridge') return;
  const workspaces = [
    { id: 'digitronics' as const, name: 'Digitronics', color: '#5b8cff', icon: 'D', protected: false },
    { id: 'tenten' as const, name: 'TenTen', color: '#ffbd59', icon: 'T', protected: false },
    { id: 'development' as const, name: 'Development', color: '#a78bfa', icon: '</>', protected: false },
    { id: 'personal' as const, name: 'Personal', color: '#4fd1a5', icon: 'P', protected: false },
    { id: 'banking' as const, name: 'Banking', color: '#ff6b7a', icon: '$', protected: true },
  ];
  const tabs = workspaces.map((workspace) => ({ id: workspace.id, workspaceId: workspace.id, title: workspace.id === 'development' ? 'Developer Preview' : 'New tab', url: workspace.id === 'development' ? 'http://127.0.0.1:4173/' : 'private://home', loading: false, canGoBack: false, canGoForward: false, isHome: workspace.id !== 'development', developerToolsAllowed: workspace.id === 'development', developerToolsOpen: false }));
  const snapshot: BrowserSnapshot = { workspaces, activeWorkspaceId: 'development', activeTabId: 'development', tabs, bookmarks: [], history: [], downloads: [], privacyLog: [], trackerBlocking: true, bookmarkBarVisible: true };
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
