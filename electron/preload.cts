import { contextBridge, ipcRenderer } from 'electron';
import type { AccountSpaceColor, AccountSpaceId, AiApproval, AiPagePreview, AiProviderInput, AiProviderStatus, BrowserSnapshot, DeveloperDiagnosticReport, DevToolsMode, UpdateCheckResult, UpdateServiceInput, UpdateServiceStatus, VaultItemInput, VaultItemMeta, VaultStatus, WorkspaceId } from './types.js';

const api = {
  getState: (): Promise<BrowserSnapshot> => ipcRenderer.invoke('browser:get-state'),
  navigate: (value: string): Promise<void> => ipcRenderer.invoke('browser:navigate', value),
  back: (): Promise<void> => ipcRenderer.invoke('browser:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('browser:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
  stop: (): Promise<void> => ipcRenderer.invoke('browser:stop'),
  newTab: (workspaceId?: WorkspaceId, url?: string, accountSpaceId?: AccountSpaceId): Promise<void> => ipcRenderer.invoke('browser:new-tab', workspaceId, url, accountSpaceId),
  closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:close-tab', tabId),
  activateTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:activate-tab', tabId),
  switchWorkspace: (workspaceId: WorkspaceId): Promise<void> => ipcRenderer.invoke('browser:switch-workspace', workspaceId),
  switchAccountSpace: (accountSpaceId: AccountSpaceId): Promise<void> => ipcRenderer.invoke('browser:switch-account-space', accountSpaceId),
  addLocalAccountSpace: (workspaceId: WorkspaceId, label: string, color: AccountSpaceColor): Promise<void> => ipcRenderer.invoke('accounts:add-local', workspaceId, label, color),
  updateAccountSpace: (accountSpaceId: AccountSpaceId, label?: string, color?: AccountSpaceColor): Promise<void> => ipcRenderer.invoke('accounts:update', accountSpaceId, label, color),
  reorderAccountSpaces: (workspaceId: WorkspaceId, accountSpaceIds: AccountSpaceId[]): Promise<void> => ipcRenderer.invoke('accounts:reorder', workspaceId, accountSpaceIds),
  openInAccountSpace: (accountSpaceId: AccountSpaceId, url: string): Promise<void> => ipcRenderer.invoke('accounts:open-in', accountSpaceId, url),
  setAccountSpaceLocked: (accountSpaceId: AccountSpaceId, locked: boolean): Promise<void> => ipcRenderer.invoke('accounts:set-locked', accountSpaceId, locked),
  disconnectGoogleAccount: (accountSpaceId: AccountSpaceId): Promise<void> => ipcRenderer.invoke('accounts:disconnect-google', accountSpaceId),
  clearAccountSpaceData: (accountSpaceId: AccountSpaceId): Promise<void> => ipcRenderer.invoke('accounts:clear-data', accountSpaceId),
  deleteAccountSpace: (accountSpaceId: AccountSpaceId, confirmation: 'DELETE_ACCOUNT_SPACE'): Promise<void> => ipcRenderer.invoke('accounts:delete', accountSpaceId, confirmation),
  setLayout: (layout: { top: number; left: number; right: number; bottom: number }): Promise<void> => ipcRenderer.invoke('browser:set-layout', layout),
  toggleBookmark: (): Promise<void> => ipcRenderer.invoke('browser:toggle-bookmark'),
  openBookmark: (id: string): Promise<void> => ipcRenderer.invoke('browser:open-bookmark', id),
  toggleTrackerBlocking: (): Promise<void> => ipcRenderer.invoke('browser:toggle-tracker-blocking'),
  openDownload: (id: string): Promise<void> => ipcRenderer.invoke('browser:open-download', id),
  showDownload: (id: string): Promise<void> => ipcRenderer.invoke('browser:show-download', id),
  toggleDeveloperTools: (mode: DevToolsMode): Promise<void> => ipcRenderer.invoke('developer:toggle-tools', mode),
  captureDeveloperDiagnostics: (): Promise<DeveloperDiagnosticReport> => ipcRenderer.invoke('developer:capture-diagnostics'),
  clearDeveloperDiagnostics: (): Promise<void> => ipcRenderer.invoke('developer:clear-diagnostics'),
  prepareAiPreview: (): Promise<AiPagePreview> => ipcRenderer.invoke('ai:prepare-preview'),
  approveAiPreview: (previewId: string): Promise<AiApproval> => ipcRenderer.invoke('ai:approve-preview', previewId),
  getAiProvider: (): Promise<AiProviderStatus> => ipcRenderer.invoke('ai:provider-status'),
  configureAiProvider: (input: AiProviderInput): Promise<AiProviderStatus> => ipcRenderer.invoke('ai:configure-provider', input),
  clearAiProvider: (): Promise<AiProviderStatus> => ipcRenderer.invoke('ai:clear-provider'),
  askAi: (token: string, question: string): Promise<string> => ipcRenderer.invoke('ai:ask', token, question),
  revokeAiContext: (): Promise<void> => ipcRenderer.invoke('ai:revoke'),
  listVault: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:list'),
  addVaultItem: (input: VaultItemInput): Promise<VaultItemMeta> => ipcRenderer.invoke('vault:add', input),
  removeVaultItem: (id: string): Promise<boolean> => ipcRenderer.invoke('vault:remove', id),
  resetCorruptVault: (): Promise<boolean> => ipcRenderer.invoke('vault:reset-corrupt'),
  copyPassword: (id: string): Promise<void> => ipcRenderer.invoke('vault:copy-password', id),
  copyTotp: (id: string): Promise<{ secondsRemaining: number }> => ipcRenderer.invoke('vault:copy-totp', id),
  autofill: (id: string): Promise<void> => ipcRenderer.invoke('vault:autofill', id),
  copyText: (value: string): Promise<void> => ipcRenderer.invoke('system:copy', value),
  getDefaultBrowserStatus: (): Promise<boolean> => ipcRenderer.invoke('system:is-default-browser'),
  setDefaultBrowser: (): Promise<boolean> => ipcRenderer.invoke('system:set-default-browser'),
  getUpdateService: (): Promise<UpdateServiceStatus> => ipcRenderer.invoke('updates:status'),
  configureUpdateService: (input: UpdateServiceInput): Promise<UpdateServiceStatus> => ipcRenderer.invoke('updates:configure', input),
  clearUpdateService: (): Promise<UpdateServiceStatus> => ipcRenderer.invoke('updates:clear'),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
  openUpdatePage: (): Promise<void> => ipcRenderer.invoke('updates:open-page'),
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
  onUpdateAvailable: (callback: (result: UpdateCheckResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: UpdateCheckResult) => callback(result);
    ipcRenderer.on('updates:available', listener);
    return () => { ipcRenderer.removeListener('updates:available', listener); };
  },
};

contextBridge.exposeInMainWorld('privateBrowser', api);

export type PrivateBrowserApi = typeof api;
