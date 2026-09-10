import { contextBridge, ipcRenderer } from 'electron';
import type { AiPagePreview, BrowserSnapshot, VaultItemInput, VaultItemMeta, WorkspaceId } from './types.js';

const api = {
  getState: (): Promise<BrowserSnapshot> => ipcRenderer.invoke('browser:get-state'),
  navigate: (value: string): Promise<void> => ipcRenderer.invoke('browser:navigate', value),
  back: (): Promise<void> => ipcRenderer.invoke('browser:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('browser:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
  stop: (): Promise<void> => ipcRenderer.invoke('browser:stop'),
  newTab: (workspaceId?: WorkspaceId, url?: string): Promise<void> => ipcRenderer.invoke('browser:new-tab', workspaceId, url),
  closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:close-tab', tabId),
  activateTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:activate-tab', tabId),
  switchWorkspace: (workspaceId: WorkspaceId): Promise<void> => ipcRenderer.invoke('browser:switch-workspace', workspaceId),
  setLayout: (layout: { top: number; left: number; right: number; bottom: number }): Promise<void> => ipcRenderer.invoke('browser:set-layout', layout),
  toggleBookmark: (): Promise<void> => ipcRenderer.invoke('browser:toggle-bookmark'),
  openBookmark: (id: string): Promise<void> => ipcRenderer.invoke('browser:open-bookmark', id),
  toggleTrackerBlocking: (): Promise<void> => ipcRenderer.invoke('browser:toggle-tracker-blocking'),
  openDownload: (id: string): Promise<void> => ipcRenderer.invoke('browser:open-download', id),
  showDownload: (id: string): Promise<void> => ipcRenderer.invoke('browser:show-download', id),
  prepareAiPreview: (): Promise<AiPagePreview> => ipcRenderer.invoke('ai:prepare-preview'),
  approveAiPreview: (preview: AiPagePreview): Promise<AiPagePreview> => ipcRenderer.invoke('ai:approve-preview', preview),
  listVault: (): Promise<{ available: boolean; items: VaultItemMeta[] }> => ipcRenderer.invoke('vault:list'),
  addVaultItem: (input: VaultItemInput): Promise<VaultItemMeta> => ipcRenderer.invoke('vault:add', input),
  removeVaultItem: (id: string): Promise<boolean> => ipcRenderer.invoke('vault:remove', id),
  revealPassword: (id: string): Promise<string> => ipcRenderer.invoke('vault:reveal', id),
  getTotp: (id: string): Promise<{ code: string; secondsRemaining: number }> => ipcRenderer.invoke('vault:totp', id),
  autofill: (id: string): Promise<void> => ipcRenderer.invoke('vault:autofill', id),
  copyText: (value: string): Promise<void> => ipcRenderer.invoke('system:copy', value),
  onState: (callback: (state: BrowserSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserSnapshot) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => { ipcRenderer.removeListener('browser:state', listener); };
  },
  onFocusAddress: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('browser:focus-address', listener);
    return () => { ipcRenderer.removeListener('browser:focus-address', listener); };
  },
};

contextBridge.exposeInMainWorld('privateBrowser', api);

export type PrivateBrowserApi = typeof api;
