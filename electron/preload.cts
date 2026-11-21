import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserRoutine, LocalAiModels, ReferenceSearchInput, RoutineRunResult, TabSetInput } from './types.js';
import type { AddressMatch, BrowsingDataInput, BrowsingDataReview, HistoryPage, HistoryQuery, TabBatchScope, TabOrganizationAction } from './types.js';
import type { PermissionCapability, PermissionGrantSummary, SitePermissionStatus } from './types.js';
import type { AiPreviewScope, AiProviderCheckResult, AiRequestReview, AssistantAnswer, AssistantSelectionEdit, AssistantSelectionSource, ChromeImportReview, GoogleConnectionHealth } from './types.js';
import type { BookmarkEntryKeyInput, BookmarkLevelInput, DownloadAction, FindResult, Shortcut, ShortcutTile, SideAppCommand, SideAppId, SideAppRect, UiPreferencesPatch, BrowserSettingsPatch } from './types.js';
import type { AccountSpaceColor, AccountSpaceId, AiApproval, AiPagePreview, AiProviderInput, AiProviderStatus, BridgeStatus, BrowserSnapshot, ControlCenterRecheckInput, ControlCenterRepository, ControlCenterSendInput, ControlCenterStatus, ControlCenterTask, CalendarEventSummary, ChromeImportOptions, ChromeImportResult, ChromeProfileSource, ContactSummary, DeveloperAiPreviewOptions, DeveloperBridgeAction, DeveloperDiagnosticReport, DeveloperPageInfo, DevToolsMode, DriveFileSummary, ExternalBrowserId, GmailMessageHeader, GmailOverview, GoogleModule, GoogleMutationConfirmation, GoogleOperationProgress, GoogleOperationResult, PermissionDecision, ProjectInfo, ProjectSummary, StateRecoveryAction, UpdateCheckResult, UpdateServiceInput, UpdateServiceStatus, VaultItemInput, VaultItemMeta, VaultStatus, WorkspaceId } from './types.js';
import type { CalendarWriteInput, DriveCreateInput, GmailSendInput } from './google-services.js';
import type { VaultFillReadiness, VaultHealthReport } from './types.js';
import type { BackupWriteResult } from './account-backup.js';
import type { AgentDecision, AgentUiStatus } from './agent-types.js';
import type { AgentPolicy } from './agent-policy.js';

const api = {
  getAgentStatus: (): Promise<AgentUiStatus> => ipcRenderer.invoke('agents:status'),
  setAgentsEnabled: (enabled: boolean): Promise<void> => ipcRenderer.invoke('agents:enable', enabled),
  beginAgentPairing: (): Promise<void> => ipcRenderer.invoke('agents:pair'),
  stopAgents: (): Promise<void> => ipcRenderer.invoke('agents:stop'),
  resumeAgents: (): Promise<void> => ipcRenderer.invoke('agents:resume'),
  openAgentWorkspace: (): Promise<void> => ipcRenderer.invoke('agents:open-workspace'),
  revokeAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:revoke', id),
  renewAgent: (id: string): Promise<void> => ipcRenderer.invoke('agents:renew', id),
  setAgentPolicy: (id: string, policy: AgentPolicy): Promise<void> => ipcRenderer.invoke('agents:set-policy', id, policy),
  grantAgentUploads: (id: string): Promise<void> => ipcRenderer.invoke('agents:grant-uploads', id),
  revokeAgentUploads: (id: string): Promise<void> => ipcRenderer.invoke('agents:revoke-uploads', id),
  addAgentSpace: (name: string): Promise<void> => ipcRenderer.invoke('agents:add-space', name),
  resetAgentSpace: (id: string): Promise<void> => ipcRenderer.invoke('agents:reset-space', id),
  clearAgentAudit: (): Promise<void> => ipcRenderer.invoke('agents:clear-audit'),
  exportAgentAudit: (): Promise<void> => ipcRenderer.invoke('agents:export-audit'),
  decideAgentAction: (id: string, decision: AgentDecision): Promise<void> => ipcRenderer.invoke('agents:decide', id, decision),
  selectAgentTab: (id: string): Promise<void> => ipcRenderer.invoke('agents:select', id),
  setAgentTabManual: (id: string, manual: boolean): Promise<void> => ipcRenderer.invoke('agents:manual', id, manual),
  closeAgentTab: (id: string): Promise<void> => ipcRenderer.invoke('agents:close-tab', id),
  lendAgentTab: (tabId: string, clientId: string): Promise<void> => ipcRenderer.invoke('agents:lend-tab', tabId, clientId),
  returnAgentTab: (): Promise<void> => ipcRenderer.invoke('agents:return-tab'),
  onAgentChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('agents:changed', listener);
    return () => { ipcRenderer.removeListener('agents:changed', listener); };
  },
  getState: (): Promise<BrowserSnapshot> => ipcRenderer.invoke('browser:get-state'),
  saveRoutine: (routine: BrowserRoutine): Promise<void> => ipcRenderer.invoke('routines:save', routine),
  saveTabSet: (input: TabSetInput): Promise<number> => ipcRenderer.invoke('routines:save-tabs', input),
  openReferenceSearch: (input: ReferenceSearchInput): Promise<void> => ipcRenderer.invoke('routines:open-reference', input),
  deleteRoutine: (id: string): Promise<void> => ipcRenderer.invoke('routines:delete', id),
  runRoutine: (id: string): Promise<RoutineRunResult> => ipcRenderer.invoke('routines:run', id),
  markRoutineChecklist: (id: string, index: number, done: boolean): Promise<void> => ipcRenderer.invoke('routines:mark-checklist', id, index, done),
  resetRoutineChecklist: (id: string): Promise<void> => ipcRenderer.invoke('routines:reset-checklist', id),
  navigate: (value: string): Promise<void> => ipcRenderer.invoke('browser:navigate', value),
  goHome: (): Promise<void> => ipcRenderer.invoke('browser:home'),
  back: (): Promise<void> => ipcRenderer.invoke('browser:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('browser:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
  restoreSelectedTabs: (ids: string[]): Promise<void> => ipcRenderer.invoke('browser:restore-selected-tabs', ids),
  organizeTab: (action: TabOrganizationAction): Promise<void> => ipcRenderer.invoke('browser:organize-tab', action),
  duplicateTab: (id: string): Promise<void> => ipcRenderer.invoke('browser:duplicate-tab', id),
  closeTabBatch: (id: string, scope: TabBatchScope, confirmedIds: string[]): Promise<void> => ipcRenderer.invoke('browser:close-tab-batch', id, scope, confirmedIds),
  undoTabBatch: (): Promise<void> => ipcRenderer.invoke('browser:undo-tab-batch'),
  stop: (): Promise<void> => ipcRenderer.invoke('browser:stop'),
  newTab: (workspaceId?: WorkspaceId, url?: string, accountSpaceId?: AccountSpaceId): Promise<void> => ipcRenderer.invoke('browser:new-tab', workspaceId, url, accountSpaceId),
  closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:close-tab', tabId),
  activateTab: (tabId: string): Promise<void> => ipcRenderer.invoke('browser:activate-tab', tabId),
  switchWorkspace: (workspaceId: WorkspaceId): Promise<void> => ipcRenderer.invoke('browser:switch-workspace', workspaceId),
  switchAccountSpace: (accountSpaceId: AccountSpaceId): Promise<void> => ipcRenderer.invoke('browser:switch-account-space', accountSpaceId),
  addressMatches: (accountSpaceId: AccountSpaceId, text: string): Promise<AddressMatch[]> => ipcRenderer.invoke('browser:address-matches', accountSpaceId, text),
  queryHistory: (accountSpaceId: AccountSpaceId, input: HistoryQuery): Promise<HistoryPage> => ipcRenderer.invoke('browser:query-history', accountSpaceId, input),
  reviewBrowsingData: (input: BrowsingDataInput): Promise<BrowsingDataReview> => ipcRenderer.invoke('browser:review-browsing-data', input),
  deleteReviewedBrowsingData: (id: string): Promise<number> => ipcRenderer.invoke('browser:delete-reviewed-data', id),
  deleteHistoryVisit: (accountId: AccountSpaceId, id: string): Promise<void> => ipcRenderer.invoke('browser:delete-history-visit', accountId, id),
  openAddressMatch: (accountSpaceId: AccountSpaceId, source: AddressMatch['source'], id: string): Promise<void> => ipcRenderer.invoke('browser:open-address-match', accountSpaceId, source, id),
  addLocalAccountSpace: (workspaceId: WorkspaceId, label: string, color: AccountSpaceColor): Promise<AccountSpaceId> => ipcRenderer.invoke('accounts:add-local', workspaceId, label, color),
  updateAccountSpace: (accountSpaceId: AccountSpaceId, label?: string, color?: AccountSpaceColor): Promise<void> => ipcRenderer.invoke('accounts:update', accountSpaceId, label, color),
  reorderAccountSpaces: (workspaceId: WorkspaceId, accountSpaceIds: AccountSpaceId[]): Promise<void> => ipcRenderer.invoke('accounts:reorder', workspaceId, accountSpaceIds),
  openInAccountSpace: (accountSpaceId: AccountSpaceId, url: string): Promise<void> => ipcRenderer.invoke('accounts:open-in', accountSpaceId, url),
  setAccountSpaceLocked: (accountSpaceId: AccountSpaceId, locked: boolean): Promise<void> => ipcRenderer.invoke('accounts:set-locked', accountSpaceId, locked),
  disconnectGoogleAccount: (accountSpaceId: AccountSpaceId, revoke = false): Promise<GoogleOperationResult> => ipcRenderer.invoke('accounts:disconnect-google', accountSpaceId, revoke),
  clearAccountSpaceData: (accountSpaceId: AccountSpaceId): Promise<void> => ipcRenderer.invoke('accounts:clear-data', accountSpaceId),
  deleteAccountSpace: (accountSpaceId: AccountSpaceId, confirmation: 'DELETE_ACCOUNT_SPACE'): Promise<void> => ipcRenderer.invoke('accounts:delete', accountSpaceId, confirmation),
  respondToPermissionPrompt: (promptId: string, decision: PermissionDecision, displaySourceId?: string): Promise<void> => ipcRenderer.invoke('permissions:respond', promptId, decision, displaySourceId),
  getSitePermissions: (tabId: string, origin: string): Promise<SitePermissionStatus[]> => ipcRenderer.invoke('permissions:site', tabId, origin),
  revokeSitePermission: (tabId: string, origin: string, capability: PermissionCapability): Promise<SitePermissionStatus[]> =>
    ipcRenderer.invoke('permissions:revoke-site', tabId, origin, capability),
  listAccountPermissionGrants: (id: AccountSpaceId): Promise<PermissionGrantSummary[]> => ipcRenderer.invoke('permissions:list-account', id),
  configureGoogle: (clientId: string): Promise<void> => ipcRenderer.invoke('google:configure', clientId),
  getGoogleConnectionHealth: (id: AccountSpaceId): Promise<GoogleConnectionHealth> => ipcRenderer.invoke('google:connection-health', id),
  clearGoogleConfiguration: (): Promise<void> => ipcRenderer.invoke('google:clear-configuration'),
  connectGoogleAccount: (accountSpaceId: AccountSpaceId, modules: GoogleModule[], browserId: ExternalBrowserId): Promise<GoogleOperationResult> => ipcRenderer.invoke('google:connect', accountSpaceId, modules, browserId),
  cancelGoogleConnection: (accountSpaceId: AccountSpaceId): Promise<boolean> => ipcRenderer.invoke('google:cancel', accountSpaceId),
  gmailOverview: (accountSpaceId: AccountSpaceId, operationId: string): Promise<GoogleOperationResult<GmailOverview>> => ipcRenderer.invoke('google:gmail-overview-run', accountSpaceId, operationId),
  searchGmail: (accountSpaceId: AccountSpaceId, operationId: string, query = ''): Promise<GoogleOperationResult<GmailMessageHeader[]>> => ipcRenderer.invoke('google:gmail-search-run', accountSpaceId, operationId, query),
  prepareGmailSend: (accountSpaceId: AccountSpaceId, input: GmailSendInput, sourceRevision?: string): Promise<GoogleMutationConfirmation> => ipcRenderer.invoke('google:gmail-prepare-send', accountSpaceId, input, sourceRevision),
  sendGmail: (accountSpaceId: AccountSpaceId, operationId: string, input: GmailSendInput, confirmationToken: string, sourceRevision?: string): Promise<GoogleOperationResult<{ id: string; threadId?: string }>> => ipcRenderer.invoke('google:gmail-send', accountSpaceId, operationId, input, confirmationToken, sourceRevision),
  listDriveFiles: (accountSpaceId: AccountSpaceId, operationId: string, query = '', wholeDrive = false): Promise<GoogleOperationResult<DriveFileSummary[]>> => ipcRenderer.invoke('google:drive-list-run', accountSpaceId, operationId, query, wholeDrive),
  createDriveFile: (accountSpaceId: AccountSpaceId, operationId: string, input: DriveCreateInput): Promise<GoogleOperationResult<DriveFileSummary>> => ipcRenderer.invoke('google:drive-create', accountSpaceId, operationId, input),
  prepareDriveShare: (accountSpaceId: AccountSpaceId, fileId: string, email: string, role: 'reader' | 'writer', sourceRevision?: string): Promise<GoogleMutationConfirmation> => ipcRenderer.invoke('google:drive-prepare-share', accountSpaceId, fileId, email, role, sourceRevision),
  shareDriveFile: (accountSpaceId: AccountSpaceId, operationId: string, fileId: string, email: string, role: 'reader' | 'writer', confirmationToken: string, sourceRevision?: string): Promise<GoogleOperationResult<{ id: string }>> => ipcRenderer.invoke('google:drive-share', accountSpaceId, operationId, fileId, email, role, confirmationToken, sourceRevision),
  listCalendarEvents: (accountSpaceId: AccountSpaceId, operationId: string, query = ''): Promise<GoogleOperationResult<CalendarEventSummary[]>> => ipcRenderer.invoke('google:calendar-list-run', accountSpaceId, operationId, query),
  prepareCalendarWrite: (accountSpaceId: AccountSpaceId, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, sourceRevision?: string): Promise<GoogleMutationConfirmation> => ipcRenderer.invoke('google:calendar-prepare-write', accountSpaceId, action, input, sourceRevision),
  writeCalendarEvent: (accountSpaceId: AccountSpaceId, operationId: string, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, confirmationToken: string, sourceRevision?: string): Promise<GoogleOperationResult<CalendarEventSummary | { deleted: true }>> => ipcRenderer.invoke('google:calendar-write', accountSpaceId, operationId, action, input, confirmationToken, sourceRevision),
  listContacts: (accountSpaceId: AccountSpaceId, operationId: string): Promise<GoogleOperationResult<ContactSummary[]>> => ipcRenderer.invoke('google:contacts-list-run', accountSpaceId, operationId),
  createBackupRecoveryCode: (accountSpaceId: AccountSpaceId): Promise<string> => ipcRenderer.invoke('backup:create-recovery', accountSpaceId),
  verifyAndEnableBackup: (accountSpaceId: AccountSpaceId, recoveryCode: string, includeOpenTabs: boolean, includeHistory: boolean): Promise<void> => ipcRenderer.invoke('backup:verify-enable', accountSpaceId, recoveryCode, includeOpenTabs, includeHistory),
  uploadBackup: (accountSpaceId: AccountSpaceId, operationId: string, conflictResolution?: 'merge' | 'overwrite'): Promise<BackupWriteResult> => ipcRenderer.invoke('backup:upload', accountSpaceId, operationId, conflictResolution),
  restoreBackup: (accountSpaceId: AccountSpaceId, operationId: string, recoveryCode?: string): Promise<void> => ipcRenderer.invoke('backup:restore', accountSpaceId, operationId, recoveryCode),
  disableBackup: (accountSpaceId: AccountSpaceId): Promise<void> => ipcRenderer.invoke('backup:disable', accountSpaceId),
  cancelOperation: (operationId: string): Promise<boolean> => ipcRenderer.invoke('operations:cancel', operationId),
  performRecoveryAction: (action: StateRecoveryAction, confirmation?: string): Promise<void> => ipcRenderer.invoke('recovery:act', action, confirmation),
  setLayout: (layout: { top: number; left: number; right: number; bottom: number }): Promise<void> => ipcRenderer.invoke('browser:set-layout', layout),
  setOverlayOpen: (open: boolean): Promise<void> => ipcRenderer.invoke('browser:set-overlay-open', open),
  setSideAppBounds: (id: SideAppId, rect: SideAppRect | null): Promise<void> => ipcRenderer.invoke('side-app:set-bounds', id, rect),
  sideAppCommand: (id: SideAppId, command: SideAppCommand): Promise<void> => ipcRenderer.invoke('side-app:command', id, command),
  clearSideAppData: (id: SideAppId): Promise<void> => ipcRenderer.invoke('side-app:clear-data', id),
  toggleBookmark: (): Promise<void> => ipcRenderer.invoke('browser:toggle-bookmark'),
  openBookmark: (id: string): Promise<void> => ipcRenderer.invoke('browser:open-bookmark', id),
  openBookmarksInBackground: (accountSpaceId: AccountSpaceId, ids: string[]): Promise<{ opened: number; reused: number; skipped: number }> =>
    ipcRenderer.invoke('browser:open-bookmarks-in-background', accountSpaceId, ids),
  toggleBookmarkBar: (): Promise<void> => ipcRenderer.invoke('browser:toggle-bookmark-bar'),
  setUiPreferences: (patch: UiPreferencesPatch): Promise<void> => ipcRenderer.invoke('ui:set-preferences', patch),
  setBrowserSettings: (patch: BrowserSettingsPatch, workspace?: WorkspaceId): Promise<void> => ipcRenderer.invoke('settings:set', patch, workspace),
  freezeContent: (): Promise<string | null> => ipcRenderer.invoke('browser:freeze-content'),
  moveTab: (tabId: string, toIndex: number): Promise<void> => ipcRenderer.invoke('browser:move-tab', tabId, toIndex),
  reopenClosedTab: (): Promise<void> => ipcRenderer.invoke('browser:reopen-closed-tab'),
  reopenRecentTab: (id: string): Promise<void> => ipcRenderer.invoke('browser:reopen-recent-tab', id),
  zoom: (direction: 'in' | 'out' | 'reset'): Promise<void> => ipcRenderer.invoke('browser:zoom', direction),
  print: (): Promise<void> => ipcRenderer.invoke('browser:print'),
  findInPage: (text: string, forward: boolean, findNext: boolean): Promise<void> => ipcRenderer.invoke('browser:find', text, forward, findNext),
  stopFindInPage: (): Promise<void> => ipcRenderer.invoke('browser:stop-find'),
  setTabMuted: (tabId: string, muted: boolean): Promise<void> => ipcRenderer.invoke('browser:set-tab-muted', tabId, muted),
  hardReload: (): Promise<void> => ipcRenderer.invoke('browser:hard-reload'),
  toggleFullscreen: (): Promise<void> => ipcRenderer.invoke('browser:toggle-fullscreen'),
  moveBookmark: (level: BookmarkLevelInput, key: BookmarkEntryKeyInput, toIndex: number): Promise<void> => ipcRenderer.invoke('bookmarks:move', level, key, toIndex),
  renameBookmark: (id: string, title: string): Promise<void> => ipcRenderer.invoke('bookmarks:rename', id, title),
  removeBookmark: (id: string): Promise<void> => ipcRenderer.invoke('bookmarks:remove', id),
  editBookmarkAddress: (id: string, url: string): Promise<void> => ipcRenderer.invoke('bookmarks:edit-address', id, url),
  changeBookmarks: (account: AccountSpaceId, ids: string[], destination?: BookmarkLevelInput): Promise<number> =>
    ipcRenderer.invoke('bookmarks:change-many', account, ids, destination),
  undoBookmarks: (account: AccountSpaceId): Promise<number> => ipcRenderer.invoke('bookmarks:undo-many', account),
  renameBookmarkFolder: (level: BookmarkLevelInput, name: string, nextName: string): Promise<void> => ipcRenderer.invoke('bookmarks:rename-folder', level, name, nextName),
  removeBookmarkFolder: (level: BookmarkLevelInput, name: string): Promise<void> => ipcRenderer.invoke('bookmarks:remove-folder', level, name),
  exportBookmarks: (): Promise<boolean> => ipcRenderer.invoke('bookmarks:export'),
  importBookmarkHtml: (accountSpaceId: AccountSpaceId): Promise<{ imported: number; skipped: number } | undefined> =>
    ipcRenderer.invoke('bookmarks:import-html', accountSpaceId),
  setShortcutTiles: (accountSpaceId: AccountSpaceId, tiles: ShortcutTile[] | null): Promise<void> => ipcRenderer.invoke('shortcuts:set', accountSpaceId, tiles),
  quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  listChromeProfiles: (): Promise<ChromeProfileSource[]> => ipcRenderer.invoke('browser:list-chrome-profiles'),
  importChrome: (options: ChromeImportOptions): Promise<ChromeImportResult> => ipcRenderer.invoke('browser:import-chrome', options),
  previewChromeImport: (options: ChromeImportOptions): Promise<ChromeImportReview> => ipcRenderer.invoke('browser:preview-chrome-import', options),
  confirmChromeImport: (id: string): Promise<ChromeImportResult> => ipcRenderer.invoke('browser:confirm-chrome-import', id),
  discardChromeImport: (id: string): Promise<void> => ipcRenderer.invoke('browser:discard-chrome-import', id),
  canUndoChromeImport: (id: AccountSpaceId): Promise<boolean> => ipcRenderer.invoke('browser:can-undo-chrome-import', id),
  undoChromeImport: (id: AccountSpaceId): Promise<{ bookmarks: number; history: number }> => ipcRenderer.invoke('browser:undo-chrome-import', id),
  importChromePasswords: (): Promise<ChromeImportResult> => ipcRenderer.invoke('browser:import-chrome-passwords'),
  toggleTrackerBlocking: (): Promise<void> => ipcRenderer.invoke('browser:toggle-tracker-blocking'),
  openDownload: (id: string): Promise<void> => ipcRenderer.invoke('browser:open-download', id),
  controlDownload: (id: string, action: DownloadAction): Promise<void> => ipcRenderer.invoke('browser:control-download', id, action),
  showDownload: (id: string): Promise<void> => ipcRenderer.invoke('browser:show-download', id),
  setDownloadHistory: (accountId: AccountSpaceId, enabled: boolean): Promise<void> => ipcRenderer.invoke('browser:set-download-history', accountId, enabled),
  removeDownloadEntry: (accountId: AccountSpaceId, id: string): Promise<void> => ipcRenderer.invoke('browser:remove-download-entry', accountId, id),
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
  getControlCenterStatus: (): Promise<ControlCenterStatus> => ipcRenderer.invoke('control-center:status'),
  pairControlCenter: (code: string): Promise<ControlCenterStatus> => ipcRenderer.invoke('control-center:pair', code),
  disconnectControlCenter: (): Promise<ControlCenterStatus> => ipcRenderer.invoke('control-center:disconnect'),
  listControlCenterRepositories: (): Promise<{ repositories: ControlCenterRepository[]; suggestedId: string | null }> => ipcRenderer.invoke('control-center:repositories'),
  listControlCenterTasks: (): Promise<ControlCenterTask[]> => ipcRenderer.invoke('control-center:tasks'),
  sendToControlCenter: (input: ControlCenterSendInput): Promise<ControlCenterTask> => ipcRenderer.invoke('control-center:send', input),
  recheckControlCenterTask: (input: ControlCenterRecheckInput): Promise<{ name: string }> => ipcRenderer.invoke('control-center:recheck', input),
  prepareAiPreview: (scope?: AiPreviewScope): Promise<AiPagePreview> => ipcRenderer.invoke('ai:prepare-preview', scope),
  prepareAssistantSource: (id: string, tabId: string): Promise<AssistantSelectionSource> => ipcRenderer.invoke('ai:prepare-source', id, tabId),
  reviewAssistantRequest: (id: string, text: string, question: string, withEvidence?: boolean, edits?: AssistantSelectionEdit[]): Promise<AiRequestReview> => ipcRenderer.invoke('ai:review-request', id, text, question, withEvidence, edits),
  sendReviewedAssistant: (id: string): Promise<AssistantAnswer> => ipcRenderer.invoke('ai:send-reviewed', id),
  cancelReviewedAssistant: (id: string): Promise<void> => ipcRenderer.invoke('ai:cancel-reviewed', id),
  setAssistantCloudAllowed: (accountId: AccountSpaceId, allowed: boolean): Promise<void> => ipcRenderer.invoke('ai:set-space-cloud', accountId, allowed),
  approveAiPreview: (previewId: string, mode?: 'cloud' | 'local'): Promise<AiApproval> => ipcRenderer.invoke('ai:approve-preview', previewId, mode),
  getAiProvider: (): Promise<AiProviderStatus> => ipcRenderer.invoke('ai:provider-status'),
  checkAiProvider: (): Promise<AiProviderCheckResult> => ipcRenderer.invoke('ai:check-provider'),
  getLocalAiModels: (): Promise<LocalAiModels> => ipcRenderer.invoke('ai:local-models'),
  configureAiProvider: (input: AiProviderInput): Promise<AiProviderStatus> => ipcRenderer.invoke('ai:configure-provider', input),
  clearAiProvider: (): Promise<AiProviderStatus> => ipcRenderer.invoke('ai:clear-provider'),
  askAi: (token: string, question: string): Promise<string> => ipcRenderer.invoke('ai:ask', token, question),
  revokeAiContext: (): Promise<void> => ipcRenderer.invoke('ai:revoke'),
  listVault: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:list'),
  requestVaultUnlock: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:request-unlock'),
  unlockVaultWithHello: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:hello-unlock'),
  enableVaultHello: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:hello-enable'),
  disableVaultHello: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:hello-disable'),
  requestVaultPairing: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:request-pairing'),
  lockVault: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:lock'),
  syncVaultNow: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:sync'),
  getVaultConflictReview: (): Promise<{ local: VaultItemMeta[]; cloud: VaultItemMeta[] }> => ipcRenderer.invoke('vault:conflict-review'),
  resolveVaultConflict: (choice: 'cloud' | 'local'): Promise<VaultStatus> => ipcRenderer.invoke('vault:resolve-conflict', choice),
  getVaultMigrationStatus: (): Promise<{ legacyAvailable: boolean }> => ipcRenderer.invoke('vault:migration-status'),
  migrateLegacyVault: (): Promise<{ sourceCount: number; importedCount: number; skippedCount: number; validatedCount: number; phase: string }> => ipcRenderer.invoke('vault:migrate-legacy'),
  cleanupLegacyVault: (): Promise<boolean> => ipcRenderer.invoke('vault:cleanup-legacy'),
  openVaultEditor: (origin?: string): Promise<VaultItemMeta | undefined> => ipcRenderer.invoke('vault:open-editor', origin),
  checkVaultHealth: (accountId: AccountSpaceId): Promise<VaultHealthReport> => ipcRenderer.invoke('vault:check-health', accountId),
  editVaultHealthLogin: (accountId: AccountSpaceId, id: string): Promise<boolean> => ipcRenderer.invoke('vault:edit-health-login', accountId, id),
  inspectVaultFormShape: (): Promise<{ hasUsername: boolean; hasPassword: boolean }> => ipcRenderer.invoke('vault:form-shape'),
  resetVaultPicks: (accountId: AccountSpaceId): Promise<boolean> => ipcRenderer.invoke('vault:reset-picks', accountId),
  vaultFillReadiness: (): Promise<VaultFillReadiness> => ipcRenderer.invoke('vault:fill-readiness'),
  requestSaveFromPage: (): Promise<VaultItemMeta | undefined> => ipcRenderer.invoke('vault:save-from-page'),
  requestVaultDelete: (id: string): Promise<boolean> => ipcRenderer.invoke('vault:request-delete', id),
  acknowledgeVaultRecovery: (): Promise<VaultStatus> => ipcRenderer.invoke('vault:acknowledge-recovery'),
  copyPassword: (id: string): Promise<void> => ipcRenderer.invoke('vault:copy-password', id),
  copyTotp: (id: string): Promise<{ secondsRemaining: number }> => ipcRenderer.invoke('vault:copy-totp', id),
  vaultClipboardDeadline: (): Promise<number | undefined> => ipcRenderer.invoke('vault:clipboard-deadline'),
  clearVaultClipboard: (): Promise<boolean> => ipcRenderer.invoke('vault:clipboard-clear'),
  copyGeneratedCredential: (kind: 'password' | 'passphrase' | 'pin'): Promise<void> => ipcRenderer.invoke('vault:copy-generated', kind),
  autofill: (id: string): Promise<void> => ipcRenderer.invoke('vault:autofill', id),
  copyText: (value: string): Promise<void> => ipcRenderer.invoke('system:copy', value),
  getDefaultBrowserStatus: (): Promise<boolean> => ipcRenderer.invoke('system:is-default-browser'),
  openDefaultBrowserSettings: (): Promise<void> => ipcRenderer.invoke('system:open-default-browser-settings'),
  testDefaultBrowser: (): Promise<void> => ipcRenderer.invoke('system:test-default-browser'),
  getUpdateService: (): Promise<UpdateServiceStatus> => ipcRenderer.invoke('updates:status'),
  configureUpdateService: (input: UpdateServiceInput): Promise<UpdateServiceStatus> => ipcRenderer.invoke('updates:configure', input),
  clearUpdateService: (): Promise<UpdateServiceStatus> => ipcRenderer.invoke('updates:clear'),
  checkForUpdates: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check'),
  openUpdatePage: (): Promise<void> => ipcRenderer.invoke('updates:open-page'),
  openReleaseHistory: (): Promise<void> => ipcRenderer.invoke('updates:open-history'),
  onState: (callback: (state: BrowserSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserSnapshot) => callback(state);
    ipcRenderer.on('browser:state', listener);
    return () => { ipcRenderer.removeListener('browser:state', listener); };
  },
  onCommand: (callback: (shortcut: Shortcut) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, shortcut: Shortcut) => callback(shortcut);
    ipcRenderer.on('browser:command', listener);
    return () => { ipcRenderer.removeListener('browser:command', listener); };
  },
  onFindResult: (callback: (result: FindResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: FindResult) => callback(result);
    ipcRenderer.on('browser:find-result', listener);
    return () => { ipcRenderer.removeListener('browser:find-result', listener); };
  },
  onUpdateAvailable: (callback: (result: UpdateCheckResult) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, result: UpdateCheckResult) => callback(result);
    ipcRenderer.on('updates:available', listener);
    return () => { ipcRenderer.removeListener('updates:available', listener); };
  },
  onGoogleOperationProgress: (callback: (progress: GoogleOperationProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: GoogleOperationProgress) => callback(progress);
    ipcRenderer.on('google:operation-progress', listener);
    return () => { ipcRenderer.removeListener('google:operation-progress', listener); };
  },
  onVaultState: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('vault:state', listener);
    return () => { ipcRenderer.removeListener('vault:state', listener); };
  },
};

contextBridge.exposeInMainWorld('privateBrowser', api);

window.addEventListener('online', () => { void ipcRenderer.invoke('vault:reconnect').catch(() => undefined); });

export type PrivateBrowserApi = typeof api;
