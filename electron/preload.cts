import { contextBridge, ipcRenderer } from 'electron';
import type { AiApproval, AiPagePreview, AiProviderInput, AiProviderStatus, BridgeStatus, BrowserSnapshot, ChromeImportOptions, ChromeImportResult, ChromeProfileSource, DeveloperAiPreviewOptions, DeveloperBridgeAction, DeveloperDiagnosticReport, DeveloperPageInfo, DevToolsMode, ProjectInfo, ProjectSummary, UpdateCheckResult, UpdateServiceInput, UpdateServiceStatus, VaultItemInput, VaultItemMeta, VaultStatus, WorkspaceId } from './types.js';

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
  toggleBookmarkBar: (): Promise<void> => ipcRenderer.invoke('browser:toggle-bookmark-bar'),
  listChromeProfiles: (): Promise<ChromeProfileSource[]> => ipcRenderer.invoke('browser:list-chrome-profiles'),
  importChrome: (options: ChromeImportOptions): Promise<ChromeImportResult> => ipcRenderer.invoke('browser:import-chrome', options),
  importChromePasswords: (): Promise<ChromeImportResult> => ipcRenderer.invoke('browser:import-chrome-passwords'),
  toggleTrackerBlocking: (): Promise<void> => ipcRenderer.invoke('browser:toggle-tracker-blocking'),
  openDownload: (id: string): Promise<void> => ipcRenderer.invoke('browser:open-download', id),
  showDownload: (id: string): Promise<void> => ipcRenderer.invoke('browser:show-download', id),
  toggleDeveloperTools: (mode: DevToolsMode): Promise<void> => ipcRenderer.invoke('developer:toggle-tools', mode),
  captureDeveloperDiagnostics: (): Promise<DeveloperDiagnosticReport> => ipcRenderer.invoke('developer:capture-diagnostics'),
  clearDeveloperDiagnostics: (): Promise<void> => ipcRenderer.invoke('developer:clear-diagnostics'),
  getBridgeStatus: (): Promise<BridgeStatus> => ipcRenderer.invoke('developer:bridge-status'),
  beginBridgePairing: (): Promise<BridgeStatus> => ipcRenderer.invoke('developer:bridge-pair'),
  disconnectBridge: (revoke = false): Promise<BridgeStatus> => ipcRenderer.invoke('developer:bridge-disconnect', revoke),
  listBridgeProjects: (): Promise<ProjectSummary[]> => ipcRenderer.invoke('developer:bridge-projects'),
  selectBridgeProject: (projectId: string): Promise<ProjectInfo> => ipcRenderer.invoke('developer:bridge-select-project', projectId),
  runBridgeAction: (action: DeveloperBridgeAction, payload: Record<string, unknown> = {}): Promise<unknown> => ipcRenderer.invoke('developer:bridge-action', action, payload),
  inspectDeveloperPage: (selectElement = false): Promise<DeveloperPageInfo> => ipcRenderer.invoke('developer:inspect-page', selectElement),
  prepareDeveloperAiPreview: (options: DeveloperAiPreviewOptions): Promise<AiPagePreview> => ipcRenderer.invoke('developer:prepare-ai-preview', options),
  installBridgeExtension: (): Promise<string> => ipcRenderer.invoke('developer:install-extension'),
  prepareAiPreview: (): Promise<AiPagePreview> => ipcRenderer.invoke('ai:prepare-preview'),
  approveAiPreview: (previewId: string): Promise<AiApproval> => ipcRenderer.invoke('ai:approve-preview', previewId),
  getAiProvider: (): Promise<AiProviderStatus> => ipcRenderer.invoke('ai:provider-status'),
  configureAiProvider: (input: AiProviderInput): Promise<AiProviderStatus> => ipcRenderer.invoke('ai:configure-provider', input),
  clearAiProvider: (): Promise<AiProviderStatus> => ipcRenderer.invoke('ai:clear-provider'),
  askAi: (token: string, question: string): Promise<string> => ipcRenderer.invoke('ai:ask', token, question),
  revokeAiContext: (): Promise<void> => ipcRenderer.invoke('ai:revoke'),
  listVault: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:list'),
  requestVaultUnlock: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:request-unlock'),
  lockVault: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:lock'),
  openVaultEditor: (origin?: string): Promise<VaultItemMeta | undefined> => ipcRenderer.invoke('vault:open-editor', origin),
  requestVaultDelete: (id: string): Promise<boolean> => ipcRenderer.invoke('vault:request-delete', id),
  acknowledgeVaultRecovery: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:acknowledge-recovery'),
  copyPassword: (id: string): Promise<void> => ipcRenderer.invoke('vault:copy-password', id),
  copyTotp: (id: string): Promise<{ secondsRemaining: number }> => ipcRenderer.invoke('vault:copy-totp', id),
  copyGeneratedCredential: (kind: 'password' | 'passphrase' | 'pin'): Promise<void> => ipcRenderer.invoke('vault:copy-generated', kind),
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
  onVaultState: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('vault:state', listener);
    return () => { ipcRenderer.removeListener('vault:state', listener); };
  },
};

contextBridge.exposeInMainWorld('privateBrowser', api);

export type PrivateBrowserApi = typeof api;
