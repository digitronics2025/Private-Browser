import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  WebContentsView,
  type DownloadItem,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron';
import { downloadRisk, isAllowedRemoteUrl, isAllowedSitePermission, isAutofillTarget, isProtectedPage, navigationWarning, normalizeNavigationInput, redactSensitiveText, stripTrackingParameters, urlOriginForSharing } from './security.js';
import { ClipboardGuard } from './clipboard-guard.js';
import { verifyDownload, type ExpectedInstaller } from './download-verify.js';
import { AiProviderStore } from './ai-provider.js';
import { WORKSPACES } from './state-store.js';
import { AccountStore } from './account-store.js';
import { AccountSpaceStateStore } from './account-space-state.js';
import { RuntimeStateStore } from './runtime-state-store.js';
import type {
  AccountSpaceColor,
  AccountSpaceId,
  ExternalBrowserId,
  GoogleModule,
  AiApproval,
  AiPagePreview,
  AiProviderInput,
  BrowserSnapshot,
  BrowserTab,
  ChromeImportOptions,
  ChromeImportResult,
  ChromeProfileSource,
  DeveloperAiPreviewOptions,
  DeveloperConsoleEntry,
  DeveloperBridgeAction,
  DeveloperPageInfo,
  DeveloperNetworkIssue,
  DevToolsMode,
  DownloadEntry,
  PrivacyEvent,
  RuntimeBrowserStateV2,
  PermissionCapability,
  PermissionDecision,
  PermissionPrompt,
  UpdateServiceInput,
  WorkspaceId,
  StateRecoveryAction,
} from './types.js';
import type { ProjectInfo, ProjectSummary } from '@private-browser/bridge-protocol';
import { generateTotp } from './vault.js';
import { VaultBroker, type GeneratedCredentialKind } from './myvault/vault-broker.js';
import { MyVaultDiskStore } from './myvault/vault-store.js';
import { SecureVaultDialogs } from './myvault/secure-dialog.js';
import type { ConfirmDeleteDialogValue, EditLoginDialogValue, UnlockDialogValue } from './myvault/secure-dialog-contract.js';
import { FillCapabilityStore, normalizedWebOrigin, type FillContext } from './myvault/fill-capability.js';
import { captureLoginInIsolatedWorld, fillLoginAutomaticallyInIsolatedWorld, fillLoginInIsolatedWorld, inspectLoginFormShape } from './myvault/isolated-fill.js';
import { workspaceVaultPolicy } from './myvault/workspace-policy.js';
import { isAutomaticFillPageUrl, selectAutomaticFillEntry } from './myvault/automatic-fill.js';
import { MyVaultSyncClient } from './myvault/vault-sync.js';
import { VaultSyncController } from './myvault/sync-controller.js';
import type { PairDialogValue } from './myvault/secure-dialog-contract.js';
import { VaultMigrationService } from './myvault/vault-migration.js';
import { canInstallPasskeyProvider, InternalPasskeyController, type PasskeyOptIns } from './myvault/passkey-controller.js';
import { UpdateServiceStore } from './update-service.js';
import { readUpdateBootstrap, removeUpdateBootstrap } from './update-bootstrap.js';
import { canUseDeveloperTools, makeDeveloperReport, sanitizeDiagnosticText, sanitizeDiagnosticUrl } from './developer-tools.js';
import { IpcGuard } from './ipc-guard.js';
import { clearAndVerifyAccountSession } from './account-session.js';
import { AccountPermissionManager } from './account-permissions.js';
import { GoogleConfigurationStore } from './google-config.js';
import { ExternalBrowserLauncher } from './external-browser.js';
import { GoogleOAuthManager } from './google-oauth.js';
import { GoogleTokenBroker } from './google-token-broker.js';
import { GoogleServices, type CalendarWriteInput, type DriveCreateInput, type GmailSendInput } from './google-services.js';
import { AccountBackupManager, type BackupWriteResult } from './account-backup.js';
import { GoogleDriveAppDataTransport } from './google-backup-transport.js';
import { validateIpcArguments } from './ipc-contracts.js';
import { aiSourceRevision, classifyAiSource, maySendAiPreviewToCloud, sameAiSource } from './ai-account-spaces.js';
import { googleWebsiteStatus, isKnownGoogleWebHost } from './google-website-status.js';
import { listChromeProfiles, readChromeProfile } from './chrome-importer.js';
import { VscodeBridgeServer } from './vscode-bridge.js';

interface RuntimeTab {
  view?: WebContentsView;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon?: string;
  developerToolsOpen: boolean;
  console: Array<DeveloperConsoleEntry & { redactions: number }>;
  network: Array<DeveloperNetworkIssue & { redactions: number }>;
  navigationGeneration: number;
  certificateError: boolean;
  automaticFillGeneration?: number;
  automaticFillPending: boolean;
}

interface Layout {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

const FAVICON_TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_FAVICON_BYTES = 32 * 1024;
const AUTOMATIC_FILL_RETRY_DELAYS_MS = [0, 300, 1_000, 2_500] as const;

function safeOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return ''; }
}

function permissionCapability(
  permission: string,
  details: unknown,
): PermissionCapability | undefined {
  if (permission === 'notifications') return 'notifications';
  if (permission === 'media') {
    const mediaTypes = details && typeof details === 'object' && 'mediaTypes' in details && Array.isArray(details.mediaTypes)
      ? details.mediaTypes
      : [];
    const audio = mediaTypes.includes('audio');
    const video = mediaTypes.includes('video');
    if (audio && video) return 'camera-and-microphone';
    if (audio) return 'microphone';
    if (video) return 'camera';
    return undefined;
  }
  if (permission === 'clipboard-read') return 'clipboard-read';
  if (permission === 'clipboard-sanitized-write') return 'clipboard-write';
  if (permission === 'fileSystem') return 'file-system';
  if (permission === 'geolocation') return 'geolocation';
  return undefined;
}

const TRACKER_HOSTS = [
  '2mdn.net',
  'adnxs.com',
  'adsrvr.org',
  'amazon-adsystem.com',
  'app-measurement.com',
  'clarity.ms',
  'criteo.com',
  'criteo.net',
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googleadservices.com',
  'googletagmanager.com',
  'connect.facebook.net',
  'fullstory.com',
  'analytics.twitter.com',
  'hotjar.com',
  'mixpanel.com',
  'newrelic.com',
  'optimizely.com',
  'segment.io',
  'scorecardresearch.com',
  'sentry.io',
  'taboola.com',
  'quantserve.com',
  'mc.yandex.ru',
];

class BrowserController {
  private readonly runtimeTabs = new Map<string, RuntimeTab>();
  private readonly downloads = new Map<string, DownloadEntry>();
  private readonly downloadItems = new Map<string, DownloadItem>();
  private readonly configuredSessions = new Set<string>();
  private readonly pendingAiPreviews = new Map<string, { preview: AiPagePreview; expiresAt: number }>();
  private readonly aiApprovals = new Map<string, { preview: AiPagePreview; expiresAt: number }>();
  private readonly clipboardGuard = new ClipboardGuard(clipboard);
  private readonly permissions: AccountPermissionManager;
  private pendingPermission?: {
    prompt: PermissionPrompt;
    respond: (allowed: boolean, displaySourceId?: string) => void;
    retainAllowOnce: boolean;
  };
  private readonly faviconCache = new Map<string, string>();
  private readonly operations = new Map<string, { accountSpaceId: AccountSpaceId; controller: AbortController }>();
  private expectedInstaller?: ExpectedInstaller;
  private layout: Layout = { top: 158, left: 0, right: 366, bottom: 0 };
  private window!: BrowserWindow;
  private readonly secureDialogs = new SecureVaultDialogs(() => this.window);
  private readonly fillCapabilities = new FillCapabilityStore();
  private readonly preferredFillEntryByOrigin = new Map<string, string>();
  private readonly vaultSync: VaultSyncController;
  private dirtySyncTimer?: NodeJS.Timeout;
  private readonly passkeyController = new InternalPasskeyController();
  private readonly passkeyOptIns: PasskeyOptIns = { global: false, workspaces: {}, sites: {} };

  constructor(
    private readonly store: RuntimeStateStore,
    private readonly persistedState: AccountSpaceStateStore,
    private readonly accounts: AccountStore,
    private readonly googleConfiguration: GoogleConfigurationStore,
    private readonly externalBrowsers: ExternalBrowserLauncher,
    private readonly googleOAuth: GoogleOAuthManager,
    private readonly googleServices: GoogleServices,
    private readonly backups: AccountBackupManager,
    private readonly vault: VaultBroker,
    private readonly migration: VaultMigrationService,
    private readonly aiProvider: AiProviderStore,
    private readonly updates: UpdateServiceStore,
    private readonly vscodeBridge: VscodeBridgeServer,
  ) {
    this.permissions = new AccountPermissionManager(accounts);
    const state = this.store.get();
    const active = this.activeTab(state);
    this.runtimeTabs.set(active.id, this.newRuntimeTab());
    this.vaultSync = new VaultSyncController(vault, new MyVaultSyncClient());
    this.vault.subscribe((status) => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send('vault:state');
      if (status.lifecycle === 'unlocked' && this.window && !this.window.isDestroyed()) {
        const activeTabId = this.activeTab(this.store.get()).id;
        this.scheduleAutomaticFill(activeTabId);
      }
      if (status.lifecycle === 'unlocked' && status.dirty && !this.dirtySyncTimer) {
        this.dirtySyncTimer = setTimeout(() => {
          this.dirtySyncTimer = undefined;
          void this.vaultSync.syncNow().catch(() => undefined);
        }, 45_000);
        this.dirtySyncTimer.unref();
      }
    });
  }

  async createWindow(): Promise<void> {
    this.window = new BrowserWindow({
      width: 1500,
      height: 940,
      minWidth: 1050,
      minHeight: 680,
      backgroundColor: '#0b0d12',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#10131a', symbolColor: '#aeb6c8', height: 39 },
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    Menu.setApplicationMenu(null);
    this.window.on('resize', () => this.applyLayout());
    this.window.on('closed', () => {
      for (const runtime of this.runtimeTabs.values()) {
        runtime.view?.webContents.close();
        runtime.view = undefined;
      }
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    const productionUrl = pathToFileURL(join(import.meta.dirname, '../dist/index.html')).toString();
    const trustedDevelopmentOrigin = devUrl ? new URL(devUrl).origin : undefined;
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    this.window.webContents.on('will-navigate', (event, url) => {
      let allowed = url === productionUrl;
      try { allowed ||= Boolean(trustedDevelopmentOrigin && new URL(url).origin === trustedDevelopmentOrigin); } catch { allowed = false; }
      if (!allowed) event.preventDefault();
    });
    await this.window.loadURL(devUrl ?? productionUrl);

    this.window.once('ready-to-show', () => this.window.show());
    await this.showActiveTab();
  }

  getSnapshot(): BrowserSnapshot {
    const persisted = this.store.get();
    const tabs: BrowserTab[] = persisted.tabs.map((tab) => {
      const runtime = this.runtimeTabs.get(tab.id);
      return {
        ...tab,
        loading: runtime?.loading ?? false,
        canGoBack: runtime?.canGoBack ?? false,
        canGoForward: runtime?.canGoForward ?? false,
        favicon: runtime?.favicon,
        developerToolsAllowed: canUseDeveloperTools(tab.workspaceId, tab.isHome, tab.url),
        developerToolsOpen: runtime?.developerToolsOpen ?? false,
        securityWarning: tab.isHome ? undefined : navigationWarning(tab.url),
      };
    });
    return {
      workspaces: WORKSPACES,
      activeWorkspaceId: persisted.activeWorkspaceId,
      activeTabId: this.activeTab(persisted).id,
      tabs,
      bookmarks: persisted.bookmarks,
      history: persisted.history.slice(0, 100),
      downloads: [...this.downloads.values()],
      privacyLog: persisted.privacyLog.slice(0, 50),
      trackerBlocking: persisted.trackerBlocking,
      activeAccountSpaceId: this.activeAccountSpaceId(persisted),
      accountSpaces: persisted.accountSpaces,
      accountHealth: persisted.accountHealth,
      recovery: persisted.recovery,
      pendingPermission: this.pendingPermission?.prompt,
      googleConfiguration: this.googleConfiguration.status(),
      externalBrowsers: this.externalBrowsers.discover().map(({ id, name }) => ({ id, name })),
      bookmarkBarVisible: persisted.bookmarkBarVisible,
    };
  }

  broadcast(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send('browser:state', this.getSnapshot());
  }

  isTrustedSender(event: IpcMainInvokeEvent): boolean {
    return !this.window.isDestroyed()
      && event.sender === this.window.webContents
      && event.senderFrame === this.window.webContents.mainFrame;
  }

  focus(): void {
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  setLayout(layout: Layout): void {
    this.layout = {
      top: Math.max(80, Math.round(layout.top)),
      left: Math.max(0, Math.round(layout.left)),
      right: Math.max(0, Math.round(layout.right)),
      bottom: Math.max(0, Math.round(layout.bottom)),
    };
    this.applyLayout();
  }

  async navigate(value: string): Promise<void> {
    const url = normalizeNavigationInput(value);
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (url === 'private://home') {
      this.store.update((next) => {
        const target = next.tabs.find((candidate) => candidate.id === tab.id);
        if (target) Object.assign(target, { url, title: 'New tab', isHome: true });
      });
      const runtime = this.runtimeTabs.get(tab.id);
      runtime?.view?.webContents.closeDevTools();
      runtime?.view?.setVisible(false);
      this.broadcast();
      return;
    }
    if (!isAllowedRemoteUrl(url)) throw new Error('Only HTTP and HTTPS pages are allowed');
    this.store.update((next) => {
      const target = next.tabs.find((candidate) => candidate.id === tab.id);
      if (target) Object.assign(target, { url, isHome: false });
    });
    const view = this.ensureView(tab.id);
    view.setVisible(true);
    this.applyLayout();
    await view.webContents.loadURL(url);
    this.broadcast();
  }

  async newTab(workspaceId?: WorkspaceId, url = 'private://home', accountSpaceId?: AccountSpaceId): Promise<void> {
    const state = this.store.get();
    const targetWorkspace = WORKSPACES.some((item) => item.id === workspaceId) ? workspaceId! : state.activeWorkspaceId;
    const targetAccount = accountSpaceId ?? state.activeAccountSpaceByWorkspace[targetWorkspace];
    if (!targetAccount || !state.accountSpaces.some((account) => account.id === targetAccount && account.workspaceId === targetWorkspace)) {
      throw new Error('Account Space does not belong to the selected workspace');
    }
    const id = randomUUID();
    this.hideAllViews();
    this.store.update((next) => {
      next.activeWorkspaceId = targetWorkspace;
      next.activeAccountSpaceByWorkspace[targetWorkspace] = targetAccount;
      next.tabs.push({
        id,
        accountSpaceId: targetAccount,
        workspaceId: targetWorkspace,
        title: 'New tab',
        url: 'private://home',
        isHome: true,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        developerToolsAllowed: false,
        developerToolsOpen: false,
      });
      next.activeTabByAccountSpace[targetAccount] = id;
    });
    this.runtimeTabs.set(id, this.newRuntimeTab());
    this.broadcast();
    if (url !== 'private://home') await this.navigate(url);
  }

  async closeTab(tabId: string): Promise<void> {
    this.fillCapabilities.invalidateTab(tabId);
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const accountTabs = state.tabs.filter((candidate) => candidate.accountSpaceId === tab.accountSpaceId);
    const closedIndex = accountTabs.findIndex((candidate) => candidate.id === tabId);
    const siblings = accountTabs.filter((candidate) => candidate.id !== tab.id);
    const nextId = siblings[Math.min(closedIndex, siblings.length - 1)]?.id;
    const wasActive = state.activeTabByAccountSpace[tab.accountSpaceId] === tabId;
    const runtime = this.runtimeTabs.get(tabId);
    if (runtime?.view) {
      this.window.contentView.removeChildView(runtime.view);
      runtime.view.webContents.close();
    }
    this.runtimeTabs.delete(tabId);
    this.store.update((next) => {
      next.tabs = next.tabs.filter((candidate) => candidate.id !== tabId);
      if (wasActive && nextId) next.activeTabByAccountSpace[tab.accountSpaceId] = nextId;
    });
    if (!nextId) await this.newTab(tab.workspaceId, 'private://home', tab.accountSpaceId);
    else if (wasActive) await this.activateTab(nextId);
    else this.broadcast();
  }

  async activateTab(tabId: string): Promise<void> {
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    this.fillCapabilities.invalidateAll();
    this.hideAllViews();
    this.store.update((next) => {
      next.activeWorkspaceId = tab.workspaceId;
      next.activeAccountSpaceByWorkspace[tab.workspaceId] = tab.accountSpaceId;
      next.activeTabByAccountSpace[tab.accountSpaceId] = tab.id;
    });
    await this.showActiveTab();
  }

  async switchWorkspace(workspaceId: WorkspaceId): Promise<void> {
    if (!WORKSPACES.some((item) => item.id === workspaceId)) return;
    this.fillCapabilities.invalidateAll();
    this.hideAllViews();
    this.store.update((state) => { state.activeWorkspaceId = workspaceId; });
    await this.showActiveTab();
  }

  async setOverlayOpen(open: boolean): Promise<void> {
    if (open) this.hideAllViews();
    else await this.showActiveTab();
  }

  async recoveryAction(action: StateRecoveryAction, confirmation?: string): Promise<void> {
    const recovery = this.store.get().recovery;
    if (!recovery || !recovery.actions.includes(action)) throw new Error('Recovery action is not available');
    if (action === 'open-backup-location') {
      shell.showItemInFolder(this.persistedState.recoveryTargetPath(recovery.accountSpaceId));
      return;
    }
    if (action === 'restore-v1') {
      if (confirmation !== 'RESTORE_V1') throw new Error('Exact restore confirmation is required');
      this.persistedState.prepareRestoreV1();
    } else if (action === 'fresh-start') {
      if (confirmation !== 'FRESH_START') throw new Error('Exact fresh-start confirmation is required');
      this.persistedState.prepareFreshStart(recovery.accountSpaceId);
    }
    app.relaunch();
    app.exit(0);
  }

  async switchAccountSpace(accountSpaceId: AccountSpaceId): Promise<void> {
    const state = this.store.get();
    const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
    if (!account || account.workspaceId !== state.activeWorkspaceId) {
      throw new Error('Account Space does not belong to the active workspace');
    }
    if (account.locked || state.recovery?.accountSpaceId === accountSpaceId) {
      throw new Error('Account Space is locked or unavailable');
    }
    this.hideAllViews();
    this.store.update((next) => {
      next.activeAccountSpaceByWorkspace[next.activeWorkspaceId] = accountSpaceId;
    });
    await this.showActiveTab();
  }

  async addLocalAccountSpace(workspaceId: WorkspaceId, label: string, color: AccountSpaceColor): Promise<AccountSpaceId> {
    const state = this.store.get();
    if (!WORKSPACES.some((workspace) => workspace.id === workspaceId)) throw new Error('Unknown workspace');
    const order = state.accountSpaces.filter((account) => account.workspaceId === workspaceId).length;
    const record = this.accounts.createLocal({ workspaceId, label, color, order });
    try {
      this.hideAllViews();
      this.store.addAccount(record);
      await this.showActiveTab();
    } catch (error) {
      this.accounts.remove(record.id);
      throw error;
    }
    return record.id;
  }

  updateAccountSpace(accountSpaceId: AccountSpaceId, label?: string, color?: AccountSpaceColor): void {
    this.requireAccountMembership(accountSpaceId);
    const record = this.accounts.update(accountSpaceId, (account) => {
      if (label !== undefined) account.label = label;
      if (color !== undefined) account.color = color;
    });
    this.store.refreshAccount(record);
    this.broadcast();
  }

  reorderAccountSpaces(workspaceId: WorkspaceId, accountSpaceIds: AccountSpaceId[]): void {
    if (workspaceId !== this.store.get().activeWorkspaceId) throw new Error('Only the active workspace can be reordered');
    this.store.reorder(workspaceId, accountSpaceIds);
    this.broadcast();
  }

  async openInAccountSpace(accountSpaceId: AccountSpaceId, value: string): Promise<void> {
    const account = this.requireAccountMembership(accountSpaceId);
    const url = normalizeNavigationInput(value);
    if (url !== 'private://home' && !isAllowedRemoteUrl(url)) throw new Error('Only HTTP and HTTPS pages are allowed');
    await this.newTab(account.workspaceId, url, accountSpaceId);
  }

  async setAccountSpaceLocked(accountSpaceId: AccountSpaceId, locked: boolean): Promise<void> {
    this.requireAccountMembership(accountSpaceId);
    if (locked) {
      this.closeAccountViews(accountSpaceId);
      this.cancelAccountOperations(accountSpaceId);
      await session.fromPartition(this.store.partitionFor(accountSpaceId)).closeAllConnections();
    }
    const record = this.accounts.update(accountSpaceId, (account) => {
      account.locked = locked;
      account.googleConnection = locked ? 'locked' : account.refreshToken ? 'connected' : 'disconnected';
    });
    this.store.refreshAccount(record);
    this.broadcast();
    if (!locked) await this.showActiveTab();
  }

  configureGoogle(clientId: string) {
    const status = this.googleConfiguration.configure(clientId);
    this.broadcast();
    return status;
  }

  clearGoogleConfiguration() {
    const status = this.googleConfiguration.clear();
    this.broadcast();
    return status;
  }

  async connectGoogleAccount(accountSpaceId: AccountSpaceId, modules: GoogleModule[], browserId: ExternalBrowserId) {
    this.requireAccountMembership(accountSpaceId);
    const connecting = this.accounts.update(accountSpaceId, (account) => { account.googleConnection = 'connecting'; });
    this.store.refreshAccount(connecting);
    this.broadcast();
    const allAccountIds = this.store.get().accountSpaces.map((account) => account.id);
    const result = await this.googleOAuth.connect(accountSpaceId, modules, browserId, allAccountIds);
    if (!result.ok) {
      const status = result.error?.code === 'GOOGLE_CONFIGURATION_REQUIRED' ? 'not-configured'
        : result.error?.code === 'GOOGLE_SCOPE_MISSING' ? 'partial-scopes'
          : result.error?.code === 'GOOGLE_RECONNECT_REQUIRED' ? 'reconnect-required'
            : result.error?.code === 'GOOGLE_OFFLINE' ? 'offline'
              : 'disconnected';
      this.accounts.update(accountSpaceId, (account) => { account.googleConnection = status; });
    }
    this.store.refreshAccount(this.accounts.require(accountSpaceId));
    this.broadcast();
    return result;
  }

  cancelGoogleConnection(accountSpaceId: AccountSpaceId): boolean {
    this.requireAccountMembership(accountSpaceId);
    const cancelled = this.googleOAuth.cancel(accountSpaceId);
    if (cancelled) {
      const record = this.accounts.update(accountSpaceId, (account) => { account.googleConnection = 'disconnected'; });
      this.store.refreshAccount(record);
      this.broadcast();
    }
    return cancelled;
  }

  async disconnectGoogleAccount(accountSpaceId: AccountSpaceId, revoke = false) {
    this.requireAccountMembership(accountSpaceId);
    this.cancelAccountOperations(accountSpaceId);
    const result = await this.googleOAuth.disconnect(accountSpaceId, revoke);
    const record = this.accounts.require(accountSpaceId);
    this.store.refreshAccount(record);
    this.addPrivacyEvent('vault', revoke ? 'Google access revoked' : 'Google API disconnected', revoke ? 'Google grant was revoked; local website data was retained' : 'Local browsing data was retained');
    return result;
  }

  async clearAccountSpaceData(accountSpaceId: AccountSpaceId): Promise<void> {
    const account = this.requireAccountMembership(accountSpaceId);
    this.closeAccountViews(accountSpaceId);
    this.cancelAccountOperations(accountSpaceId);
    const partition = this.store.partitionFor(accountSpaceId);
    await clearAndVerifyAccountSession(session.fromPartition(partition));
    this.store.update((state) => {
      state.history = state.history.filter((entry) => entry.accountSpaceId !== accountSpaceId);
      for (const tab of state.tabs.filter((candidate) => candidate.accountSpaceId === accountSpaceId)) {
        tab.title = 'New tab';
        tab.url = 'private://home';
        tab.isHome = true;
      }
    });
    this.addPrivacyEvent('vault', 'Account Space data cleared', `${account.label} website data and history were removed`);
    await this.showActiveTab();
  }

  async deleteAccountSpace(accountSpaceId: AccountSpaceId, confirmation: string): Promise<void> {
    if (confirmation !== 'DELETE_ACCOUNT_SPACE') throw new Error('Exact Account Space deletion confirmation is required');
    const account = this.requireAccountMembership(accountSpaceId);
    const state = this.store.get();
    if (state.accountSpaces.filter((candidate) => candidate.workspaceId === account.workspaceId).length <= 1) {
      throw new Error('Create a replacement Account Space before removing the only one in this workspace');
    }
    const partition = this.store.partitionFor(accountSpaceId);
    this.closeAccountViews(accountSpaceId);
    this.cancelAccountOperations(accountSpaceId);
    if (this.accounts.require(accountSpaceId).refreshToken) {
      const revoked = await this.googleOAuth.disconnect(accountSpaceId, true);
      if (!revoked.ok) throw new Error(revoked.error?.message ?? 'Google revocation must complete before deletion');
    }
    await clearAndVerifyAccountSession(session.fromPartition(partition));
    this.configuredSessions.delete(partition);
    this.store.removeAccount(accountSpaceId);
    await this.showActiveTab();
  }

  async respondToPermissionPrompt(promptId: string, decision: PermissionDecision, displaySourceId?: string): Promise<void> {
    const pending = this.pendingPermission;
    if (!pending || pending.prompt.id !== promptId) throw new Error('Permission prompt is no longer active');
    this.pendingPermission = undefined;
    let allowed = false;
    try {
      allowed = this.permissions.applyDecision(pending.prompt, decision, pending.retainAllowOnce);
      if (allowed && pending.prompt.capability === 'display-capture'
        && !pending.prompt.displaySources?.some((source) => source.id === displaySourceId)) {
        allowed = false;
      }
    } finally {
      pending.respond(allowed, displaySourceId);
      this.broadcast();
      await this.showActiveTab();
      this.activeContents()?.focus();
    }
  }

  prepareGmailSend(accountSpaceId: AccountSpaceId, input: GmailSendInput, sourceRevision?: string) {
    this.requireAccountMembership(accountSpaceId);
    return this.googleServices.prepareGmailSend(accountSpaceId, input, sourceRevision);
  }

  gmailOverview(accountSpaceId: AccountSpaceId, operationId: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'gmail', (signal) => this.googleServices.gmailOverview(accountSpaceId, signal));
  }

  searchGmail(accountSpaceId: AccountSpaceId, operationId: string, query?: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'gmail', (signal) => this.googleServices.searchGmail(accountSpaceId, query ?? '', signal));
  }

  sendGmail(accountSpaceId: AccountSpaceId, operationId: string, input: GmailSendInput, confirmationToken: string, sourceRevision?: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'gmail', (signal) => this.googleServices.sendGmail(accountSpaceId, input, confirmationToken, sourceRevision, signal));
  }

  listDriveFiles(accountSpaceId: AccountSpaceId, operationId: string, query?: string, wholeDrive?: boolean) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'drive', (signal) => this.googleServices.listDriveFiles(accountSpaceId, query ?? '', wholeDrive === true, signal));
  }

  createDriveFile(accountSpaceId: AccountSpaceId, operationId: string, input: DriveCreateInput) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'drive', (signal) => this.googleServices.createDriveFile(accountSpaceId, input, signal));
  }

  prepareDriveShare(accountSpaceId: AccountSpaceId, fileId: string, email: string, role: 'reader' | 'writer', sourceRevision?: string) {
    this.requireAccountMembership(accountSpaceId);
    return this.googleServices.prepareDriveShare(accountSpaceId, fileId, email, role, sourceRevision);
  }

  shareDriveFile(accountSpaceId: AccountSpaceId, operationId: string, fileId: string, email: string, role: 'reader' | 'writer', confirmationToken: string, sourceRevision?: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'drive', (signal) => this.googleServices.shareDriveFile(accountSpaceId, fileId, email, role, confirmationToken, sourceRevision, signal));
  }

  listCalendarEvents(accountSpaceId: AccountSpaceId, operationId: string, query?: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'calendar', (signal) => this.googleServices.upcomingCalendarEvents(accountSpaceId, query ?? '', signal));
  }

  prepareCalendarWrite(accountSpaceId: AccountSpaceId, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, sourceRevision?: string) {
    this.requireAccountMembership(accountSpaceId);
    return this.googleServices.prepareCalendarWrite(accountSpaceId, action, input, sourceRevision);
  }

  writeCalendarEvent(accountSpaceId: AccountSpaceId, operationId: string, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, confirmationToken: string, sourceRevision?: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'calendar', (signal) => this.googleServices.writeCalendarEvent(accountSpaceId, action, input, confirmationToken, sourceRevision, signal));
  }

  listContacts(accountSpaceId: AccountSpaceId, operationId: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'contacts', (signal) => this.googleServices.listContacts(accountSpaceId, signal));
  }

  createBackupRecoveryCode(accountSpaceId: AccountSpaceId): string {
    this.requireAccountMembership(accountSpaceId);
    return this.backups.createRecoveryCode(accountSpaceId);
  }

  verifyAndEnableBackup(accountSpaceId: AccountSpaceId, recoveryCode: string, includeOpenTabs: boolean, includeHistory: boolean): void {
    this.requireAccountMembership(accountSpaceId);
    this.backups.verifyAndEnable(accountSpaceId, recoveryCode, includeOpenTabs, includeHistory);
    this.store.refreshAccount(this.accounts.require(accountSpaceId));
    this.broadcast();
  }

  disableBackup(accountSpaceId: AccountSpaceId): void {
    this.requireAccountMembership(accountSpaceId);
    this.backups.disable(accountSpaceId);
    this.store.refreshAccount(this.accounts.require(accountSpaceId));
    this.broadcast();
  }

  uploadBackup(accountSpaceId: AccountSpaceId, operationId: string, conflictResolution?: 'merge' | 'overwrite'): Promise<BackupWriteResult> {
    const state = this.store.get();
    const payload = this.backups.buildPayload(accountSpaceId, {
      bookmarks: state.bookmarks,
      trackerBlocking: state.trackerBlocking,
      openTabs: state.tabs,
      history: state.history,
    });
    return this.runGoogleOperation(accountSpaceId, operationId, 'backup', (signal) => this.backups.upload(accountSpaceId, payload, conflictResolution, signal));
  }

  restoreBackup(accountSpaceId: AccountSpaceId, operationId: string, recoveryCode?: string): Promise<void> {
    const account = this.requireAccountMembership(accountSpaceId);
    return this.runGoogleOperation(accountSpaceId, operationId, 'backup', async (signal) => {
      const restored = await this.backups.restore(accountSpaceId, recoveryCode, signal);
      const validBookmark = (item: { accountSpaceId: AccountSpaceId; workspaceId: WorkspaceId }) => item.accountSpaceId === accountSpaceId && item.workspaceId === account.workspaceId;
      if (!restored.bookmarks.every(validBookmark) || restored.history?.some((item) => !validBookmark(item)) || restored.openTabs?.some((item) => !validBookmark(item))) {
        throw new Error('Backup belongs to another Account Space');
      }
      this.closeAccountViews(accountSpaceId);
      this.store.update((state) => {
        state.bookmarks = [...state.bookmarks.filter((item) => item.accountSpaceId !== accountSpaceId), ...restored.bookmarks];
        if (restored.history) state.history = [...state.history.filter((item) => item.accountSpaceId !== accountSpaceId), ...restored.history];
        if (restored.openTabs?.length) {
          state.tabs = [...state.tabs.filter((item) => item.accountSpaceId !== accountSpaceId), ...restored.openTabs.map((tab) => ({ ...tab, loading: false, canGoBack: false, canGoForward: false, developerToolsAllowed: false, developerToolsOpen: false }))];
          state.activeTabByAccountSpace[accountSpaceId] = restored.openTabs[0].id;
        }
        state.trackerBlocking = restored.settings.trackerBlocking;
      });
      this.broadcast();
    });
  }

  cancelOperation(operationId: string): boolean {
    const operation = this.operations.get(operationId);
    if (!operation) return false;
    operation.controller.abort();
    return true;
  }

  private async runGoogleOperation<T>(
    accountSpaceId: AccountSpaceId,
    operationId: string,
    service: 'gmail' | 'drive' | 'calendar' | 'contacts' | 'backup',
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.requireAccountMembership(accountSpaceId);
    if (this.operations.has(operationId)) throw new Error('Operation identifier is already active');
    const operation = new AbortController();
    this.operations.set(operationId, { accountSpaceId, controller: operation });
    this.sendOperationProgress(operationId, accountSpaceId, service, 'started');
    try {
      const result = await task(operation.signal);
      this.sendOperationProgress(operationId, accountSpaceId, service, operation.signal.aborted ? 'cancelled' : 'completed');
      return result;
    } catch (error) {
      this.sendOperationProgress(operationId, accountSpaceId, service, operation.signal.aborted ? 'cancelled' : 'failed');
      throw error;
    } finally {
      this.operations.delete(operationId);
    }
  }

  private sendOperationProgress(operationId: string, accountSpaceId: AccountSpaceId, service: 'gmail' | 'drive' | 'calendar' | 'contacts' | 'backup', phase: 'started' | 'completed' | 'cancelled' | 'failed'): void {
    if (!this.window.isDestroyed()) this.window.webContents.send('google:operation-progress', { operationId, accountSpaceId, service, phase });
  }

  private requireAccountMembership(accountSpaceId: AccountSpaceId) {
    const state = this.store.get();
    const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
    if (!account || account.workspaceId !== state.activeWorkspaceId) throw new Error('Account Space does not belong to the active workspace');
    return account;
  }

  private closeAccountViews(accountSpaceId: AccountSpaceId): void {
    const ids = new Set(this.store.get().tabs.filter((tab) => tab.accountSpaceId === accountSpaceId).map((tab) => tab.id));
    for (const id of ids) {
      const runtime = this.runtimeTabs.get(id);
      if (runtime?.view) {
        this.window.contentView.removeChildView(runtime.view);
        runtime.view.webContents.close();
      }
      this.runtimeTabs.delete(id);
    }
    for (const key of [...this.faviconCache.keys()]) if (key.startsWith(`${accountSpaceId}:`)) this.faviconCache.delete(key);
  }

  private cancelAccountOperations(accountSpaceId: AccountSpaceId): void {
    this.pendingAiPreviews.clear();
    this.aiApprovals.clear();
    this.permissions.clearAccount(accountSpaceId);
    this.googleOAuth.clearMemory(accountSpaceId);
    this.googleServices.clearAccount(accountSpaceId);
    this.backups.clearAccount(accountSpaceId);
    for (const [operationId, operation] of this.operations) {
      if (operation.accountSpaceId !== accountSpaceId) continue;
      operation.controller.abort();
      this.operations.delete(operationId);
    }
    if (this.pendingPermission?.prompt.accountSpaceId === accountSpaceId) {
      const pending = this.pendingPermission;
      this.pendingPermission = undefined;
      pending.respond(false);
    }
    for (const [id, item] of this.downloadItems) {
      if (this.downloads.get(id)?.accountSpaceId !== accountSpaceId) continue;
      item.cancel();
      this.downloadItems.delete(id);
      this.downloads.delete(id);
    }
  }

  private queuePermissionPrompt(prompt: PermissionPrompt, respond: (allowed: boolean, displaySourceId?: string) => void, retainAllowOnce = false): void {
    if (this.pendingPermission) {
      respond(false);
      return;
    }
    this.pendingPermission = { prompt, respond, retainAllowOnce };
    const active = this.activeTab(this.store.get());
    this.runtimeTabs.get(active.id)?.view?.setVisible(false);
    this.broadcast();
  }

  goBack(): void {
    const contents = this.activeContents();
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  }

  goForward(): void {
    const contents = this.activeContents();
    if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  }

  reload(): void {
    this.activeContents()?.reload();
  }

  stop(): void {
    this.activeContents()?.stop();
  }

  toggleBookmark(): void {
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (tab.isHome) return;
    this.store.update((next) => {
      const existing = next.bookmarks.findIndex((item) => item.url === tab.url && item.accountSpaceId === tab.accountSpaceId);
      if (existing >= 0) next.bookmarks.splice(existing, 1);
      else {
        const order = next.bookmarks.filter((item) => item.accountSpaceId === tab.accountSpaceId && item.location === 'bar').length;
        next.bookmarks.unshift({ id: randomUUID(), title: tab.title, url: tab.url, workspaceId: tab.workspaceId, accountSpaceId: tab.accountSpaceId, createdAt: new Date().toISOString(), location: 'bar', folderPath: [], order, orderPath: [order] });
      }
    });
    this.broadcast();
  }

  async openBookmark(id: string): Promise<void> {
    const bookmark = this.store.get().bookmarks.find((item) => item.id === id);
    if (!bookmark) return;
    await this.newTab(bookmark.workspaceId, bookmark.url, bookmark.accountSpaceId);
  }

  toggleBookmarkBar(): void {
    this.store.update((state) => { state.bookmarkBarVisible = !state.bookmarkBarVisible; });
    this.broadcast();
  }

  listChromeProfiles(): ChromeProfileSource[] {
    return listChromeProfiles();
  }

  importChrome(options: ChromeImportOptions): ChromeImportResult {
    if (!options || typeof options.profileId !== 'string') throw new Error('Choose a Chrome profile');
    const account = this.requireAccountMembership(options.accountSpaceId);
    if (account.workspaceId !== options.workspaceId) throw new Error('Chrome imports cannot cross workspace boundaries');
    const data = readChromeProfile(options.profileId, options.workspaceId, options.accountSpaceId, options.bookmarks === true, options.history === true);
    this.store.update((state) => {
      const bookmarkKeys = new Set(state.bookmarks.map((item) => `${item.accountSpaceId}\u0000${item.location}\u0000${item.folderPath.join('\u0001')}\u0000${item.title}\u0000${item.url}`));
      for (const bookmark of data.bookmarks) {
        const key = `${bookmark.accountSpaceId}\u0000${bookmark.location}\u0000${bookmark.folderPath.join('\u0001')}\u0000${bookmark.title}\u0000${bookmark.url}`;
        if (bookmarkKeys.has(key) || state.bookmarks.length >= 25_000) data.result.skipped.bookmarks += 1;
        else { state.bookmarks.push(bookmark); bookmarkKeys.add(key); data.result.imported.bookmarks += 1; }
      }
      const historyKeys = new Set(state.history.map((item) => `${item.accountSpaceId}\u0000${item.url}\u0000${item.visitedAt}`));
      for (const entry of data.history) {
        const key = `${entry.accountSpaceId}\u0000${entry.url}\u0000${entry.visitedAt}`;
        if (historyKeys.has(key) || state.history.length >= 10_000) data.result.skipped.history += 1;
        else { state.history.push(entry); historyKeys.add(key); data.result.imported.history += 1; }
      }
      state.history.sort((left, right) => right.visitedAt.localeCompare(left.visitedAt));
    });
    this.addPrivacyEvent('local-read', 'Chrome data imported', `${data.result.imported.bookmarks} bookmarks and ${data.result.imported.history} history entries imported locally`);
    this.broadcast();
    return data.result;
  }

  toggleTrackerBlocking(): void {
    this.store.update((state) => { state.trackerBlocking = !state.trackerBlocking; });
    this.broadcast();
  }

  toggleDeveloperTools(mode: DevToolsMode): void {
    if (!['right', 'bottom', 'detach'].includes(mode)) throw new Error('Unsupported DevTools position');
    const target = this.requireDeveloperTarget();
    if (target.contents.isDevToolsOpened()) target.contents.closeDevTools();
    else target.contents.openDevTools({ mode, activate: true, title: `Private Browser DevTools — ${target.tab.title}` });
  }

  async captureDeveloperDiagnostics() {
    const target = this.requireDeveloperTarget();
    const sourceUrl = target.tab.url;
    const rawPage = await target.contents.executeJavaScript(`(() => ({
      title: document.title || '',
      readyState: document.readyState,
      language: document.documentElement.lang || '',
      scripts: document.scripts.length,
      stylesheets: document.styleSheets.length,
      images: document.images.length,
      links: document.links.length,
      forms: document.forms.length,
      iframes: document.querySelectorAll('iframe').length
    }))()`, true) as {
      title: string;
      readyState: string;
      language: string;
      scripts: number;
      stylesheets: number;
      images: number;
      links: number;
      forms: number;
      iframes: number;
    };

    const current = this.requireDeveloperTarget();
    if (current.tab.id !== target.tab.id || current.tab.url !== sourceUrl) throw new Error('The page changed; capture diagnostics again');
    const title = sanitizeDiagnosticText(rawPage.title, 300);
    const language = sanitizeDiagnosticText(String(rawPage.language ?? ''), 50);
    const url = sanitizeDiagnosticUrl(sourceUrl);
    const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), 1_000_000) : 0;
    const console = current.runtime.console.slice(-50).map(({ redactions: _redactions, ...entry }) => entry);
    const network = current.runtime.network.slice(-50).map(({ redactions: _redactions, ...entry }) => entry);
    const redactions = title.redactions + language.redactions + url.redactions
      + current.runtime.console.slice(-50).reduce((sum, entry) => sum + entry.redactions, 0)
      + current.runtime.network.slice(-50).reduce((sum, entry) => sum + entry.redactions, 0);
    const report = makeDeveloperReport({
      capturedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      page: {
        title: title.text,
        url: url.text,
        readyState: ['loading', 'interactive', 'complete'].includes(rawPage.readyState) ? rawPage.readyState : 'unknown',
        language: language.text,
        scripts: count(rawPage.scripts),
        stylesheets: count(rawPage.stylesheets),
        images: count(rawPage.images),
        links: count(rawPage.links),
        forms: count(rawPage.forms),
        iframes: count(rawPage.iframes),
      },
      console,
      network,
      redactions,
    });
    this.addPrivacyEvent('local-read', 'Developer diagnostics captured', `${title.text || 'Untitled'} · ${redactions} redaction(s)`);
    return report;
  }

  clearDeveloperDiagnostics(): void {
    const target = this.requireDeveloperTarget();
    target.runtime.console.length = 0;
    target.runtime.network.length = 0;
    this.broadcast();
  }

  getBridgeStatus() { return this.vscodeBridge.status(); }

  beginBridgePairing() { this.requireDeveloperWorkspace(); return this.vscodeBridge.beginPairing(); }

  async disconnectBridge(revoke: boolean) {
    await this.vscodeBridge.disconnect(Boolean(revoke));
    return this.vscodeBridge.status();
  }

  async listBridgeProjects(): Promise<ProjectSummary[]> {
    this.requireDeveloperWorkspace();
    return await this.vscodeBridge.request('project.list', {}) as ProjectSummary[];
  }

  async selectBridgeProject(projectId: string): Promise<ProjectInfo> {
    this.requireDeveloperWorkspace();
    if (!/^[a-f\d]{32}$/i.test(projectId)) throw new Error('Invalid project id');
    const info = await this.vscodeBridge.request('project.authorize', { projectId }) as ProjectInfo;
    this.vscodeBridge.setProject(info);
    return info;
  }

  async runBridgeAction(action: DeveloperBridgeAction, payload: Record<string, unknown>): Promise<unknown> {
    this.requireDeveloperWorkspace();
    const allowed: ReadonlySet<string> = new Set(['project.open', 'source.open', 'server.discover', 'server.start', 'server.stop', 'server.restart', 'inspect.page', 'inspect.open-source', 'test.run', 'test.cancel', 'test.rerun', 'test.save-artifact', 'ai.handoff', 'ai.apply-edits', 'reports.list', 'reports.get', 'reports.delete', 'reports.clear', 'reports.open', 'reports.retention']);
    if (!allowed.has(action)) throw new Error('Unsupported VS Code action');
    const projectId = this.vscodeBridge.status().project?.project.id;
    let safePayload: Record<string, unknown> = { ...payload, ...(projectId ? { projectId } : {}) };
    if (action === 'ai.handoff') {
      const preview = this.consumeAiApproval(String(payload.approvalToken ?? ''));
      safePayload = { projectId, action: String(payload.action ?? 'Diagnose').slice(0, 100), context: `${preview.text}${preview.dom ? `\n\nStructural DOM:\n${preview.dom}` : ''}` };
      this.addPrivacyEvent('cloud-approved', 'VS Code AI handoff approved', preview.title);
    }
    const result = await this.vscodeBridge.request(action, safePayload);
    if ((action === 'server.start' || action === 'server.restart') && result && typeof result === 'object' && 'url' in result) {
      const url = new URL(String((result as { url: unknown }).url));
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('VS Code reported an invalid development-server URL');
      const current = this.vscodeBridge.status().project;
      if (current) this.vscodeBridge.setProject({ ...current, devServerUrl: url.toString() });
      await this.navigate(url.toString());
    }
    return result;
  }

  async inspectDeveloperPage(selectElement: boolean): Promise<DeveloperPageInfo> {
    const target = this.requireDeveloperTarget();
    const expression = selectElement ? `new Promise((resolve) => {
      const finish = (value) => { document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); resolve(value); };
      const selector = (node) => { if (node.id) return '#' + CSS.escape(node.id); const parts = []; for (let item = node; item && item.nodeType === 1 && parts.length < 5; item = item.parentElement) { let part = item.tagName.toLowerCase(); if (item.classList.length) part += '.' + [...item.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.'); parts.unshift(part); } return parts.join(' > '); };
      const click = (event) => { event.preventDefault(); event.stopPropagation(); const node = event.target; finish({ route: location.pathname, framework: window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ? 'React' : 'Unknown', viewport: innerWidth + '?' + innerHeight, selector: selector(node), element: node.tagName.toLowerCase() }); };
      const key = (event) => { if (event.key === 'Escape') finish({ route: location.pathname, framework: 'Unknown', viewport: innerWidth + '?' + innerHeight }); };
      document.addEventListener('click', click, true); document.addEventListener('keydown', key, true); setTimeout(() => finish({ route: location.pathname, framework: 'Unknown', viewport: innerWidth + '?' + innerHeight }), 60000);
    })` : `(() => ({ route: location.pathname, framework: window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ? 'React' : 'Unknown', viewport: innerWidth + '?' + innerHeight }))()`;
    const raw = await this.evaluateWithCdp(target.contents, expression, selectElement) as Record<string, unknown>;
    const clean = (value: unknown, limit: number) => sanitizeDiagnosticText(String(value ?? ''), limit).text;
    const selector = clean(raw.selector, 500);
    const page: DeveloperPageInfo = { route: clean(raw.route, 1_000), framework: clean(raw.framework, 100), viewport: clean(raw.viewport, 50), ...(selector ? { selector, element: clean(raw.element, 100), confidence: 'nearest' as const } : {}) };
    if (this.vscodeBridge.status().state !== 'connected' || !this.vscodeBridge.status().project) return page;
    const sourceUrl = target.runtime.console.at(-1)?.source;
    return await this.vscodeBridge.request('inspect.page', { ...page, ...(sourceUrl ? { sourceUrl } : {}) }) as DeveloperPageInfo;
  }

  private async evaluateWithCdp(contents: Electron.WebContents, expression: string, awaitPromise: boolean): Promise<unknown> {
    const wasAttached = contents.debugger.isAttached();
    try {
      if (!wasAttached) contents.debugger.attach('1.3');
      const response = await contents.debugger.sendCommand('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture: true }) as { result?: { value?: unknown }; exceptionDetails?: unknown };
      if (response.exceptionDetails) throw new Error('The page refused element inspection');
      return response.result?.value;
    } catch (error) {
      if (!contents.isDevToolsOpened()) throw error;
      return contents.executeJavaScript(expression, true);
    } finally {
      if (!wasAttached && contents.debugger.isAttached()) contents.debugger.detach();
    }
  }

  async prepareDeveloperAiPreview(options: DeveloperAiPreviewOptions): Promise<AiPagePreview> {
    const report = await this.captureDeveloperDiagnostics();
    const bridge = this.vscodeBridge.status();
    const text = redactSensitiveText(JSON.stringify({
      project: bridge.project ? { name: bridge.project.project.name, types: bridge.project.types, framework: bridge.project.framework, packageManager: bridge.project.packageManager, activeFile: bridge.project.activeFile } : undefined,
      page: report.page, console: report.console, network: report.network,
      exclusions: ['cookies', 'passwords', 'TOTP values', 'API keys', 'tokens', 'authorization headers', 'request and response bodies', 'form values', 'browser storage', 'environment files'],
    }, null, 2));
    const state = this.store.get(); const tab = this.activeTab(state);
    let dom: string | undefined;
    let screenshotDataUrl: string | undefined;
    if (options?.includeDom) {
      const rawDom = await this.requireDeveloperTarget().contents.executeJavaScript(`(() => [...document.querySelectorAll('main,section,form,button,input,textarea,select,a,[role]')].slice(0, 250).map((node) => ({ tag: node.tagName.toLowerCase(), id: node.id || undefined, classes: [...node.classList].slice(0, 4), role: node.getAttribute('role') || undefined, type: node.getAttribute('type') || undefined, name: node.getAttribute('name') || undefined })).filter((node) => node.type !== 'password'))()`, true);
      dom = redactSensitiveText(JSON.stringify(rawDom)).text.slice(0, 12_000);
    }
    if (options?.includeScreenshot) {
      const contents = this.requireDeveloperTarget().contents;
      const mask = await contents.insertCSS('input, textarea, [contenteditable="true"] { color: transparent !important; text-shadow: 0 0 10px #777 !important; caret-color: transparent !important; }');
      try {
        const image = await contents.capturePage();
        const resized = image.getSize().width > 1280 ? image.resize({ width: 1280 }) : image;
        const encoded = resized.toJPEG(70).toString('base64');
        if (encoded.length <= 1_400_000) screenshotDataUrl = `data:image/jpeg;base64,${encoded}`;
      } finally {
        await contents.removeInsertedCSS(mask);
      }
    }
    const previewText = text.text.slice(0, 12_000);
    const preview: AiPagePreview = {
      id: randomUUID(),
      accountSpaceId: tab.accountSpaceId,
      tabId: tab.id,
      service: 'browser',
      sourceRevision: aiSourceRevision(tab.accountSpaceId, tab, previewText),
      sourceUrl: tab.url,
      title: `Developer diagnosis - ${sanitizeDiagnosticText(tab.title, 200).text}`,
      url: sanitizeDiagnosticUrl(tab.url).text,
      text: previewText,
      redactions: report.redactions + text.redactions,
      protectedPage: false,
      ...(dom ? { dom } : {}),
      ...(screenshotDataUrl ? { screenshotDataUrl } : {}),
    };
    this.pendingAiPreviews.set(preview.id, { preview, expiresAt: Date.now() + 5 * 60_000 });
    return preview;
  }

  async installBridgeExtension(): Promise<string> {
    this.requireDeveloperWorkspace();
    const packaged = join(process.resourcesPath, 'private-browser-bridge.vsix');
    const development = join(app.getAppPath(), 'build', 'private-browser-bridge.vsix');
    const vsix = existsSync(packaged) ? packaged : development;
    if (!existsSync(vsix)) throw new Error('Build the private VSIX first with npm run extension:package');
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    const code = [localAppData ? join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe') : '', programFiles ? join(programFiles, 'Microsoft VS Code', 'Code.exe') : ''].find((candidate) => candidate && existsSync(candidate));
    if (!code) { shell.showItemInFolder(vsix); return 'VSIX revealed. In VS Code choose Extensions: Install from VSIX.'; }
    const child = spawn(code, ['--install-extension', vsix, '--force'], { shell: false, windowsHide: true, stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', (value) => value === 0 ? resolve() : reject(new Error('VS Code extension installation failed'))); });
    return 'Private Browser Bridge installed. Reload VS Code if it was already open.';
  }

  async prepareAiPreview(): Promise<AiPagePreview> {
    if (!workspaceVaultPolicy(this.store.get().activeWorkspaceId).aiExtraction) throw new Error('AI extraction is disabled in this workspace');
    this.pruneAiCapabilities();
    const state = this.store.get();
    const tab = this.activeTab(state);
    const workspace = WORKSPACES.find((item) => item.id === tab.workspaceId)!;
    if (workspace.protected || isProtectedPage(tab.url)) {
      this.addPrivacyEvent('blocked', 'AI access blocked', `Protected page: ${tab.title}`);
      throw new Error('AI access is disabled for protected and banking pages');
    }
    const contents = this.activeContents();
    if (!contents || tab.isHome) throw new Error('Open a webpage first');
    const rawText = await contents.executeJavaScript(`document.body ? document.body.innerText.slice(0, 20000) : ''`, true) as string;
    const result = redactSensitiveText(rawText);
    this.addPrivacyEvent('local-read', 'Local page preview', `${tab.title} · ${result.redactions} redaction(s)`);
    const safeTitle = redactSensitiveText(tab.title);
    const text = result.text.slice(0, 12000);
    const preview: AiPagePreview = {
      id: randomUUID(),
      accountSpaceId: tab.accountSpaceId,
      tabId: tab.id,
      service: classifyAiSource(tab.url),
      sourceRevision: aiSourceRevision(tab.accountSpaceId, tab, text),
      sourceUrl: tab.url,
      title: safeTitle.text,
      url: urlOriginForSharing(tab.url),
      text,
      redactions: result.redactions + safeTitle.redactions,
      protectedPage: false,
    };
    this.pendingAiPreviews.set(preview.id, { preview, expiresAt: Date.now() + 5 * 60_000 });
    return preview;
  }

  approveAiPreview(previewId: string): AiApproval {
    const pending = this.pendingAiPreviews.get(previewId);
    this.pendingAiPreviews.delete(previewId);
    if (!pending || pending.expiresAt < Date.now()) throw new Error('The page preview expired; read the page again');
    const preview = pending.preview;
    const state = this.store.get();
    const tab = this.activeTab(state);
    const accountSpaceId = this.activeAccountSpaceId(state);
    if (!sameAiSource(preview, accountSpaceId, tab) || isProtectedPage(tab.url)) throw new Error('The page, tab, or Account Space changed or is protected');
    if (!maySendAiPreviewToCloud(preview)) throw new Error('Mailbox contents never leave this device or enter an AI model');
    const token = randomUUID();
    this.aiApprovals.set(token, { preview, expiresAt: Date.now() + 5 * 60_000 });
    this.addPrivacyEvent('cloud-approved', 'Cloud context approved', `${preview.title} · ${preview.redactions} redaction(s)`);
    return { token, preview };
  }

  getAiProvider() {
    return this.aiProvider.status();
  }

  configureAiProvider(input: AiProviderInput) {
    const status = this.aiProvider.configure(input);
    this.addPrivacyEvent('vault', 'AI provider configured', status.endpoint ?? 'Encrypted provider');
    return status;
  }

  clearAiProvider() {
    const status = this.aiProvider.clear();
    this.addPrivacyEvent('vault', 'AI provider removed', 'Encrypted provider credentials cleared');
    return status;
  }

  async askAi(token: string, questionValue: string): Promise<string> {
    const question = questionValue.trim();
    if (!question || question.length > 2000) throw new Error('Enter a question under 2,000 characters');
    const preview = this.consumeAiApproval(token);
    const answer = await this.aiProvider.ask(preview, question);
    this.addPrivacyEvent('cloud-approved', 'Cloud AI request completed', preview.title);
    return answer;
  }

  private consumeAiApproval(token: string): AiPagePreview {
    const approval = this.aiApprovals.get(token);
    this.aiApprovals.delete(token);
    if (!approval || approval.expiresAt < Date.now()) throw new Error('AI approval expired; approve the page again');
    const state = this.store.get();
    const tab = this.activeTab(state);
    const accountSpaceId = this.activeAccountSpaceId(state);
    if (!sameAiSource(approval.preview, accountSpaceId, tab) || isProtectedPage(tab.url)) throw new Error('The page, tab, or Account Space changed or is protected');
    return approval.preview;
  }

  /**
   * Drop every pending preview and live approval.
   *
   * Clearing the panel used to only make the renderer forget the token, leaving
   * the captured page text and the capability itself alive in this process for
   * the full five minutes. There was no way for the UI to undo an approval it
   * had just offered.
   */
  revokeAiContext(): void {
    const had = this.pendingAiPreviews.size + this.aiApprovals.size;
    this.pendingAiPreviews.clear();
    this.aiApprovals.clear();
    if (had) this.addPrivacyEvent('blocked', 'Cloud context revoked', 'The approved page text was discarded before it was used');
  }

  listVault() {
    const status = this.vault.status();
    const items = status.lifecycle === 'unlocked' && this.activeVaultPolicy().vaultSurface
      ? this.vault.searchMetadata().map((item) => ({ ...item, label: item.title, url: item.url ?? '' }))
      : [];
    return {
      available: status.credentialPersistenceAvailable && status.lifecycle !== 'recovery-required',
      reason: !status.credentialPersistenceAvailable
        ? 'os-encryption-unavailable' as const
        : status.blockedReason === 'envelope-unsupported'
          ? 'vault-unsupported' as const
          : status.blockedReason
            ? 'vault-corrupt' as const
            : undefined,
      items,
      lifecycle: status.lifecycle,
      sync: status.sync,
      dirty: status.dirty,
      generation: status.generation,
    };
  }

  async requestVaultUnlock() {
    this.assertVaultSurface();
    const value = await this.secureDialogs.open('unlock') as UnlockDialogValue | undefined;
    if (!value) return this.listVault();
    await this.vault.unlock(value.password);
    void this.vaultSync.syncNow().catch(() => undefined);
    this.addPrivacyEvent('vault', 'MyVault unlocked', 'Decrypted state is held only by the trusted broker');
    return this.listVault();
  }

  async lockVault() {
    this.secureDialogs.closeAll();
    this.fillCapabilities.invalidateAll();
    if (this.dirtySyncTimer) clearTimeout(this.dirtySyncTimer);
    this.dirtySyncTimer = undefined;
    for (const runtime of this.runtimeTabs.values()) if (runtime.view) this.passkeyController.detach(runtime.view.webContents);
    this.vault.lock();
    await this.clipboardGuard.flush();
    this.addPrivacyEvent('vault', 'MyVault locked', 'Pending vault actions and clipboard state were invalidated');
    return this.listVault();
  }

  async requestVaultPairing() {
    this.assertVaultSurface();
    const value = await this.secureDialogs.open('pair') as PairDialogValue | undefined;
    if (!value) return this.listVault();
    await this.vaultSync.pair(value.endpoint, value.enrollmentCode, value.password);
    this.addPrivacyEvent('vault', 'MyVault device connected', new URL(value.endpoint).origin);
    return this.listVault();
  }

  async syncVaultNow() {
    this.assertVaultSurface();
    await this.vaultSync.syncNow();
    return this.listVault();
  }

  async getVaultConflictReview() {
    this.assertVaultSurface();
    const review = await this.vault.conflictReview();
    const project = (item: (typeof review.local)[number]) => ({ ...item, label: item.title, url: item.url ?? '' });
    return { local: review.local.map(project), cloud: review.cloud.map(project) };
  }

  async resolveVaultConflict(choice: 'cloud' | 'local') {
    this.assertVaultSurface();
    if (choice === 'cloud') await this.vaultSync.chooseCloud();
    else if (choice === 'local') await this.vaultSync.chooseLocal();
    else throw new Error('Choose the cloud or local vault explicitly');
    return this.listVault();
  }

  migrationStatus() {
    return { legacyAvailable: this.migration.isLegacyAvailable() };
  }

  async migrateLegacyVault() {
    this.assertVaultSurface();
    let report = await this.migration.migrateLegacy();
    if (report.conflicts.length) {
      const decisions: Record<string, 'replace' | 'skip'> = {};
      for (const conflict of report.conflicts) {
        const confirmation = await this.secureDialogs.open('confirm-replace', `${conflict.origin} — ${conflict.username}`) as ConfirmDeleteDialogValue | undefined;
        decisions[conflict.sourceId] = confirmation?.confirmed ? 'replace' : 'skip';
      }
      report = await this.migration.migrateLegacy(decisions);
    }
    this.addPrivacyEvent('vault', 'Legacy vault migration completed', `${report.validatedCount} records validated; report contains no secret values`);
    return { sourceCount: report.sourceCount, importedCount: report.importedCount, skippedCount: report.skippedCount, validatedCount: report.validatedCount, phase: report.journalPhase };
  }

  async cleanupLegacyVault() {
    this.assertVaultSurface();
    const confirmation = await this.secureDialogs.open('confirm-cleanup') as ConfirmDeleteDialogValue | undefined;
    return this.migration.cleanupLegacyAfterConfirmation(Boolean(confirmation?.confirmed));
  }

  async importChromePasswords(): Promise<ChromeImportResult> {
    this.assertVaultSurface();
    const selected = await dialog.showOpenDialog(this.window, { title: 'Import Chrome passwords into MyVault', properties: ['openFile'], filters: [{ name: 'Chrome password CSV', extensions: ['csv'] }] });
    if (selected.canceled || !selected.filePaths[0]) throw new Error('Password import cancelled');
    const report = await this.migration.importChromeCsv(selected.filePaths[0]);
    this.addPrivacyEvent('vault', 'Chrome passwords imported into MyVault', `${report.validatedCount} rows processed; the source CSV was retained`);
    return {
      imported: { bookmarks: 0, history: 0, passwords: report.importedCount },
      skipped: { bookmarks: 0, history: 0, passwords: report.skippedCount },
      warnings: ['The plaintext Chrome CSV was retained. Delete it explicitly after verifying MyVault.'],
    };
  }

  async openVaultEditor(origin?: string) {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.saveCapture) throw new Error('Saving passwords is disabled in this workspace');
    const value = await this.secureDialogs.open('edit-login', origin) as EditLoginDialogValue | undefined;
    if (!value) return undefined;
    const result = await this.vault.saveLogin({
      title: value.title,
      url: value.url,
      username: value.username,
      password: value.password,
      totp: value.totpSecret ? { secret: value.totpSecret, algorithm: 'SHA-1', digits: 6, period: 30 } : undefined,
    });
    this.addPrivacyEvent('vault', 'MyVault login saved', value.url);
    return { ...result, label: result.title, url: result.url ?? '' };
  }

  async requestVaultDelete(id: string): Promise<boolean> {
    this.assertVaultSurface();
    const value = await this.secureDialogs.open('confirm-delete') as ConfirmDeleteDialogValue | undefined;
    if (!value?.confirmed) return false;
    const removed = await this.vault.deleteEntry(id);
    if (removed) this.addPrivacyEvent('vault', 'Vault entry removed', 'A credential was deleted');
    return removed;
  }

  acknowledgeVaultRecovery() {
    this.vault.acknowledgeRecovery();
    this.addPrivacyEvent('vault', 'Vault recovery acknowledged', 'The unreadable encrypted file remains preserved');
    return this.listVault();
  }

  copyPassword(id: string): void {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.passwordClipboard) throw new Error('Password clipboard is disabled in this workspace');
    this.copySensitiveValue(this.vault.resolveSecretForTrustedOperation(id, 'password'));
    this.addPrivacyEvent('vault', 'Password copied', 'Clipboard clears automatically after 30 seconds');
  }

  copyTotp(id: string): { secondsRemaining: number } {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.passwordClipboard) throw new Error('Vault clipboard is disabled in this workspace');
    const now = Math.floor(Date.now() / 1000);
    const code = generateTotp(this.vault.resolveSecretForTrustedOperation(id, 'totp-secret'), now);
    this.copySensitiveValue(code);
    this.addPrivacyEvent('vault', 'Authenticator code copied', 'Generated locally; clipboard auto-clear enabled');
    return { secondsRemaining: 30 - (now % 30) };
  }

  /** Clear a still-pending copied secret now — used on quit, so exiting inside
   *  the 30-second window does not leave a password on the clipboard. */
  async flushClipboard(): Promise<void> {
    await this.clipboardGuard.flush();
  }

  async autofill(id: string): Promise<void> {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.manualFill) throw new Error('Vault fill is disabled in this workspace');
    const initial = this.currentFillContext();
    if (policy.requireFillConfirmation) {
      const approval = await this.secureDialogs.open('confirm-fill', initial.origin) as ConfirmDeleteDialogValue | undefined;
      if (!approval?.confirmed) return;
      if (JSON.stringify(this.currentFillContext()) !== JSON.stringify(initial)) throw new Error('Vault fill expired because the page context changed');
    }
    const capability = this.fillCapabilities.issue(initial, id, 'fill-login');
    this.fillCapabilities.redeem(capability, this.currentFillContext(), id, 'fill-login');
    const match = this.vault.searchMetadata('', initial.origin).find((entry) => entry.id === id);
    if (!match?.url || !isAutofillTarget(match.url, initial.origin)) throw new Error('This credential belongs to another website, or this page is not secure');
    const username = this.vault.resolveSecretForTrustedOperation(id, 'username');
    const password = this.vault.resolveSecretForTrustedOperation(id, 'password');
    const beforeInjection = this.currentFillContext();
    if (JSON.stringify(beforeInjection) !== JSON.stringify(initial)) throw new Error('Vault fill expired because the page context changed');
    const contents = this.activeContents();
    if (!contents || contents.id !== initial.webContentsId) throw new Error('Vault fill expired because the page context changed');
    await fillLoginInIsolatedWorld(contents, username, password);
    this.preferredFillEntryByOrigin.set(initial.origin, id);
    const runtime = this.runtimeTabs.get(initial.tabId);
    if (runtime) runtime.automaticFillGeneration = initial.navigationGeneration;
    this.addPrivacyEvent('vault', 'Credential autofilled', new URL(initial.origin).hostname);
  }

  private scheduleAutomaticFill(tabId: string): void {
    const generation = this.runtimeTabs.get(tabId)?.navigationGeneration;
    if (generation === undefined) return;
    for (const delay of AUTOMATIC_FILL_RETRY_DELAYS_MS) {
      const timer = setTimeout(() => {
        const runtime = this.runtimeTabs.get(tabId);
        if (!runtime || runtime.navigationGeneration !== generation || runtime.automaticFillGeneration === generation) return;
        void this.tryAutomaticFill(tabId, generation);
      }, delay);
      timer.unref();
    }
  }

  private async tryAutomaticFill(tabId: string, generation: number): Promise<void> {
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    const active = this.activeTab(state);
    const runtime = this.runtimeTabs.get(tabId);
    const contents = runtime?.view?.webContents;
    if (!tab || active.id !== tabId || !runtime || !contents || tab.isHome) return;
    if (!workspaceVaultPolicy(tab.workspaceId).automaticFill || this.vault.status().lifecycle !== 'unlocked') return;
    if (runtime.navigationGeneration !== generation || runtime.automaticFillGeneration === generation || runtime.automaticFillPending || runtime.certificateError) return;
    if (!isAutomaticFillPageUrl(contents.getURL())) return;

    runtime.automaticFillPending = true;
    try {
      const initial = this.currentFillContext();
      if (initial.tabId !== tabId || initial.navigationGeneration !== generation || !initial.origin.startsWith('https://')) return;
      const match = selectAutomaticFillEntry(
        this.vault.searchMetadata('', initial.origin),
        this.preferredFillEntryByOrigin.get(initial.origin),
      );
      if (!match?.url || !isAutofillTarget(match.url, initial.origin)) return;
      const capability = this.fillCapabilities.issue(initial, match.id, 'fill-login');
      this.fillCapabilities.redeem(capability, this.currentFillContext(), match.id, 'fill-login');
      const username = this.vault.resolveSecretForTrustedOperation(match.id, 'username');
      const password = this.vault.resolveSecretForTrustedOperation(match.id, 'password');
      if (JSON.stringify(this.currentFillContext()) !== JSON.stringify(initial)) return;
      const result = await fillLoginAutomaticallyInIsolatedWorld(contents, username, password);
      if (JSON.stringify(this.currentFillContext()) !== JSON.stringify(initial)) return;
      if (result === 'no-login-form') return;
      runtime.automaticFillGeneration = generation;
      if (result === 'filled') {
        this.addPrivacyEvent('vault', 'Credential autofilled automatically', new URL(initial.origin).hostname);
      }
    } catch {
      // Locked vaults, disappearing forms and navigations are ordinary races.
      // Automatic fill stays silent and fail-closed; deliberate Fill reports errors.
    } finally {
      runtime.automaticFillPending = false;
    }
  }

  async inspectVaultFormShape() {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.saveCapture) return { hasUsername: false, hasPassword: false };
    const contents = this.activeContents();
    if (!contents) return { hasUsername: false, hasPassword: false };
    return inspectLoginFormShape(contents);
  }

  async requestSaveFromPage() {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.saveCapture) throw new Error('Password capture is disabled in this workspace');
    const initial = this.currentFillContext();
    const capability = this.fillCapabilities.issue(initial, 'page-capture', 'capture-login');
    this.fillCapabilities.redeem(capability, this.currentFillContext(), 'page-capture', 'capture-login');
    const contents = this.activeContents();
    if (!contents) throw new Error('Open a login page first');
    const captured = await captureLoginInIsolatedWorld(contents);
    if (JSON.stringify(this.currentFillContext()) !== JSON.stringify(initial)) throw new Error('Password capture expired because the page context changed');
    const approval = await this.secureDialogs.open('confirm-capture', `${initial.origin} — ${captured.username || 'No username detected'}`) as ConfirmDeleteDialogValue | undefined;
    if (!approval?.confirmed) return undefined;
    const current = this.vault.searchMetadata('', initial.origin).find((entry) => entry.username === captured.username);
    const saved = await this.vault.saveLogin({ id: current?.id, title: new URL(initial.origin).hostname, url: initial.origin, username: captured.username, password: captured.password });
    this.addPrivacyEvent('vault', current ? 'MyVault login updated' : 'MyVault login saved', initial.origin);
    return { ...saved, label: saved.title, url: saved.url ?? '' };
  }

  copyGeneratedCredential(kind: GeneratedCredentialKind): void {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.passwordClipboard) throw new Error('Credential clipboard is disabled in this workspace');
    if (!['password', 'passphrase', 'pin'].includes(kind)) throw new Error('Unsupported generator type');
    this.copySensitiveValue(this.vault.generateCredential(kind));
    this.addPrivacyEvent('vault', 'Generated credential copied', 'Generated by the broker; clipboard auto-clear enabled');
  }

  openDownload(id: string): void {
    const item = this.downloads.get(id);
    if (!item || item.state !== 'completed' || !item.savePath) return;
    // A file whose checksum did not match the manifest is the one case where the
    // app knows something is wrong; opening it anyway would waste the check.
    if (item.checksum === 'mismatch') throw new Error('This download does not match the published checksum and will not be opened. Delete it and download again.');
    if (item.risk !== 'ordinary' && item.checksum !== 'verified') {
      throw new Error('Private Browser will not open executable or deceptive downloads unless they match a verified Private Browser release. Review the file in its folder and scan it first.');
    }
    void shell.openPath(item.savePath);
  }

  showDownload(id: string): void {
    const item = this.downloads.get(id);
    if (item?.savePath) shell.showItemInFolder(item.savePath);
  }

  isDefaultBrowser(): boolean {
    return app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https');
  }

  setDefaultBrowser(): boolean {
    const http = app.setAsDefaultProtocolClient('http');
    const https = app.setAsDefaultProtocolClient('https');
    return http && https;
  }

  getUpdateService() {
    return this.updates.status(app.getVersion());
  }

  configureUpdateService(input: UpdateServiceInput) {
    const status = this.updates.configure(input, app.getVersion());
    this.addPrivacyEvent('vault', 'Download service connected', status.endpoint ?? 'Encrypted update service');
    return status;
  }

  clearUpdateService() {
    const status = this.updates.clear(app.getVersion());
    this.addPrivacyEvent('vault', 'Download service disconnected', 'Encrypted access token removed');
    return status;
  }

  async checkForUpdates() {
    const result = await this.updates.check(app.getVersion());
    this.expectedInstaller = { filename: result.latest.filename, sha256: result.latest.sha256.toLowerCase(), sizeBytes: result.latest.sizeBytes };
    return result;
  }

  async openUpdatePage(): Promise<void> {
    const result = await this.checkForUpdates();
    await this.newTab('development', result.latest.downloadPageUrl);
  }

  async checkForUpdatesInBackground(): Promise<void> {
    if (!this.getUpdateService().configured || this.window.isDestroyed()) return;
    try {
      const result = await this.checkForUpdates();
      if (result.state === 'available') this.window.webContents.send('updates:available', result);
    } catch {
      // Background checks stay quiet; explicit checks show actionable errors.
    }
  }

  private activeAccountSpaceId(state: RuntimeBrowserStateV2): AccountSpaceId {
    const id = state.activeAccountSpaceByWorkspace[state.activeWorkspaceId];
    if (!id) throw new Error('The active workspace has no Account Space');
    return id;
  }

  private activeTab(state: RuntimeBrowserStateV2) {
    const accountSpaceId = this.activeAccountSpaceId(state);
    const id = state.activeTabByAccountSpace[accountSpaceId];
    const tab = state.tabs.find((candidate) => candidate.id === id && candidate.accountSpaceId === accountSpaceId)
      ?? state.tabs.find((candidate) => candidate.accountSpaceId === accountSpaceId);
    if (!tab) throw new Error('The active Account Space has no tab');
    return tab;
  }

  private newRuntimeTab(): RuntimeTab {
    return { loading: false, canGoBack: false, canGoForward: false, developerToolsOpen: false, console: [], network: [], navigationGeneration: 0, certificateError: false, automaticFillPending: false };
  }

  markCertificateError(webContentsId: number): void {
    for (const runtime of this.runtimeTabs.values()) {
      if (runtime.view?.webContents.id === webContentsId) runtime.certificateError = true;
    }
    this.fillCapabilities.invalidateAll();
  }

  private activeVaultPolicy() {
    return workspaceVaultPolicy(this.store.get().activeWorkspaceId);
  }

  private assertVaultSurface(): void {
    if (!this.activeVaultPolicy().vaultSurface) throw new Error('MyVault is unavailable in this workspace');
  }

  private currentFillContext(): FillContext {
    const state = this.store.get();
    const tab = this.activeTab(state);
    const runtime = this.runtimeTabs.get(tab.id);
    const contents = runtime?.view?.webContents;
    if (!runtime || !contents || tab.isHome) throw new Error('Open the saved website first');
    if (runtime.certificateError) throw new Error('Vault fill is blocked after a certificate error');
    const origin = normalizedWebOrigin(contents.getURL());
    if (origin !== normalizedWebOrigin(tab.url)) throw new Error('Vault fill expired because the page context changed');
    return {
      webContentsId: contents.id,
      tabId: tab.id,
      navigationGeneration: runtime.navigationGeneration,
      workspaceId: tab.workspaceId,
      accountSpaceId: tab.accountSpaceId,
      origin,
    };
  }

  private developerTarget(tabId = this.activeTab(this.store.get()).id) {
    const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId);
    const runtime = this.runtimeTabs.get(tabId);
    const contents = runtime?.view?.webContents;
    if (!tab || !runtime || !contents || !canUseDeveloperTools(tab.workspaceId, tab.isHome, tab.url)) return undefined;
    return { tab, runtime, contents };
  }

  private requireDeveloperTarget() {
    const target = this.developerTarget();
    if (!target) throw new Error('Developer tools are available only for non-protected pages in the Development workspace');
    return target;
  }

  private requireDeveloperWorkspace(): void {
    const tab = this.activeTab(this.store.get());
    if (tab.workspaceId !== 'development' || isProtectedPage(tab.url)) {
      throw new Error('The VS Code bridge is available only in the non-protected Development workspace');
    }
  }

  private recordConsoleMessage(tabId: string, details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void {
    if (details.level !== 'warning' && details.level !== 'error') return;
    const target = this.developerTarget(tabId);
    if (!target || (details.sourceId && isProtectedPage(details.sourceId))) return;
    const message = sanitizeDiagnosticText(details.message);
    const source = sanitizeDiagnosticUrl(details.sourceId);
    target.runtime.console.push({
      at: new Date().toISOString(),
      level: details.level,
      message: message.text,
      source: source.text,
      line: Math.max(0, details.lineNumber || 0),
      redactions: message.redactions + source.redactions,
    });
    if (target.runtime.console.length > 100) target.runtime.console.splice(0, target.runtime.console.length - 100);
  }

  private recordNetworkIssue(details: Electron.OnCompletedListenerDetails | Electron.OnErrorOccurredListenerDetails): void {
    if (!details.webContentsId || isProtectedPage(details.url)) return;
    const match = [...this.runtimeTabs.entries()].find(([, runtime]) => runtime.view?.webContents.id === details.webContentsId);
    if (!match) return;
    const target = this.developerTarget(match[0]);
    if (!target) return;
    const url = sanitizeDiagnosticUrl(details.url);
    const error = sanitizeDiagnosticText(details.error || '', 300);
    target.runtime.network.push({
      at: new Date().toISOString(),
      method: details.method.slice(0, 16),
      resourceType: details.resourceType,
      url: url.text,
      ...('statusCode' in details ? { status: details.statusCode } : {}),
      ...(error.text ? { error: error.text } : {}),
      redactions: url.redactions + error.redactions,
    });
    if (target.runtime.network.length > 100) target.runtime.network.splice(0, target.runtime.network.length - 100);
  }

  private activeContents() {
    const tab = this.activeTab(this.store.get());
    return this.runtimeTabs.get(tab.id)?.view?.webContents;
  }

  private ensureView(tabId: string): WebContentsView {
    let runtime = this.runtimeTabs.get(tabId);
    if (!runtime) {
      runtime = this.newRuntimeTab();
      this.runtimeTabs.set(tabId, runtime);
    }
    if (runtime.view) return runtime.view;
    const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId)!;
    const partition = this.store.partitionFor(tab.accountSpaceId);
    const ses = session.fromPartition(partition);
    this.configureSession(ses, partition, tab.workspaceId, tab.accountSpaceId);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    runtime.view = view;
    this.window.contentView.addChildView(view);
    if (canInstallPasskeyProvider(tab.workspaceId, normalizedWebOrigin(tab.url === 'private://home' ? 'https://invalid.local' : tab.url), this.passkeyOptIns, false)) {
      void this.passkeyController.installAtDocumentStart(view.webContents).catch(() => this.passkeyController.detach(view.webContents));
    }
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (tab.workspaceId === 'banking') {
        this.addPrivacyEvent('blocked', 'Popup blocked in Banking', 'Banking pages cannot open new tabs');
      } else if (isAllowedRemoteUrl(url)) {
        void this.newTab(tab.workspaceId, stripTrackingParameters(url), tab.accountSpaceId);
      }
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedRemoteUrl(url)) {
        event.preventDefault();
        return;
      }
      const sanitized = stripTrackingParameters(url);
      if (sanitized !== url) {
        event.preventDefault();
        void view.webContents.loadURL(sanitized);
      }
    });
    view.webContents.on('will-redirect', (event, url) => {
      if (!isAllowedRemoteUrl(url)) {
        event.preventDefault();
        return;
      }
      const sanitized = stripTrackingParameters(url);
      if (sanitized !== url) {
        event.preventDefault();
        void view.webContents.loadURL(sanitized);
      }
    });
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    view.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      runtime.navigationGeneration += 1;
      runtime.certificateError = false;
      runtime.automaticFillGeneration = undefined;
      runtime.automaticFillPending = false;
      this.fillCapabilities.invalidateTab(tabId);
      this.secureDialogs.closeAll();
    });
    view.webContents.on('did-start-loading', () => this.updateRuntime(tabId, { loading: true }));
    view.webContents.on('did-stop-loading', () => this.updateRuntime(tabId, { loading: false }));
    view.webContents.on('did-finish-load', () => {
      void this.updateGoogleWebsiteState(tabId, view);
      this.scheduleAutomaticFill(tabId);
    });
    view.webContents.on('did-navigate', (_event, url) => this.commitNavigation(tabId, url));
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.commitNavigation(tabId, url, false);
      this.scheduleAutomaticFill(tabId);
    });
    view.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      this.store.update((state) => {
        const target = state.tabs.find((candidate) => candidate.id === tabId);
        if (target) target.title = title || 'Untitled';
      });
      this.broadcast();
    });
    view.webContents.on('page-favicon-updated', (_event, favicons) => void this.updateFavicon(tabId, ses, favicons[0]));
    view.webContents.on('devtools-opened', () => { this.passkeyController.detach(view.webContents); this.updateRuntime(tabId, { developerToolsOpen: true }); });
    view.webContents.on('devtools-closed', () => this.updateRuntime(tabId, { developerToolsOpen: false }));
    view.webContents.on('console-message', (details) => this.recordConsoleMessage(tabId, details));
    view.webContents.on('context-menu', (_event, params) => {
      if (!this.developerTarget(tabId)) return;
      Menu.buildFromTemplate([
        { label: 'Inspect element', click: () => {
          view.webContents.inspectElement(params.x, params.y);
          if (!view.webContents.isDevToolsOpened()) view.webContents.openDevTools({ mode: 'right', activate: true });
        } },
        { type: 'separator' },
        { label: 'Reload', click: () => view.webContents.reload() },
      ]).popup({ window: this.window });
    });
    view.webContents.on('before-input-event', (event, input) => this.handleShortcut(event, input));
    view.webContents.on('render-process-gone', () => this.updateRuntime(tabId, { loading: false }));
    return view;
  }

  private async updateGoogleWebsiteState(tabId: string, view: WebContentsView): Promise<void> {
    const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId);
    if (!tab || !isKnownGoogleWebHost(tab.url)) return;
    try {
      const [cookies, pageText] = await Promise.all([
        view.webContents.session.cookies.get({ domain: '.google.com' }),
        view.webContents.executeJavaScript(`document.body ? document.body.innerText.slice(0, 20000) : ''`, true) as Promise<string>,
      ]);
      const status = googleWebsiteStatus(typeof pageText === 'string' ? pageText : '', cookies.length > 0);
      const record = this.accounts.update(tab.accountSpaceId, (account) => { account.websiteStatus = status; });
      this.store.refreshAccount(record);
      this.broadcast();
    } catch {
      const record = this.accounts.update(tab.accountSpaceId, (account) => { account.websiteStatus = 'unknown'; });
      this.store.refreshAccount(record);
      this.broadcast();
    }
  }

  private configureSession(ses: Session, partition: string, workspaceId: WorkspaceId, accountSpaceId: AccountSpaceId): void {
    if (this.configuredSessions.has(partition)) return;
    this.configuredSessions.add(partition);
    ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/\S+/g, '').replace(/\sPrivate Browser\/\S+/g, ''));
    const protectedWorkspace = WORKSPACES.find((workspace) => workspace.id === workspaceId)!.protected;
    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      if (protectedWorkspace || !details.isMainFrame) {
        callback(false);
        return;
      }
      const capability = permissionCapability(permission, details);
      if (!capability) {
        callback(isAllowedSitePermission(permission, details.requestingUrl, false, details.isMainFrame));
        return;
      }
      const origin = safeOrigin(details.requestingUrl);
      const evaluation = this.permissions.evaluate(accountSpaceId, workspaceId, origin, capability);
      if (evaluation !== 'prompt') {
        callback(evaluation === 'granted');
        return;
      }
      try {
        this.queuePermissionPrompt(this.permissions.createPrompt(accountSpaceId, workspaceId, origin, capability), callback);
      } catch {
        callback(false);
      }
    });
    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
      if (protectedWorkspace || !details.isMainFrame) return false;
      const capability = permissionCapability(permission, details);
      if (!capability) return isAllowedSitePermission(permission, details.requestingUrl ?? requestingOrigin, false, details.isMainFrame);
      const origin = safeOrigin(details.requestingUrl ?? requestingOrigin);
      return this.permissions.evaluate(accountSpaceId, workspaceId, origin, capability, false) === 'granted';
    });
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      const deny = () => callback({});
      const state = this.store.get();
      const active = this.activeTab(state);
      const activeView = this.runtimeTabs.get(active.id)?.view;
      const origin = safeOrigin(request.securityOrigin);
      if (protectedWorkspace
        || active.accountSpaceId !== accountSpaceId
        || origin !== 'https://meet.google.com'
        || !request.userGesture
        || !request.videoRequested
        || !activeView?.getVisible()
        || request.frame !== activeView.webContents.mainFrame) {
        deny();
        return;
      }
      if (this.permissions.evaluate(accountSpaceId, workspaceId, origin, 'display-capture', false) === 'denied') {
        deny();
        return;
      }
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        if (sources.length === 0) {
          deny();
          return;
        }
        const prompt = this.permissions.createPrompt(accountSpaceId, workspaceId, origin, 'display-capture');
        prompt.displaySources = sources.slice(0, 100).map((source) => ({ id: source.id, name: source.name.slice(0, 200) }));
        this.queuePermissionPrompt(prompt, (allowed, sourceId) => {
          const source = allowed ? sources.find((candidate) => candidate.id === sourceId) : undefined;
          callback(source ? { video: source } : {});
        });
      } catch {
        deny();
      }
    }, { useSystemPicker: false });
    ses.webRequest.onBeforeRequest((details, callback) => {
      const blocking = this.store.get().trackerBlocking;
      let blocked = false;
      if (blocking) {
        try {
          const hostname = new URL(details.url).hostname;
          blocked = TRACKER_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
        } catch { blocked = false; }
      }
      callback({ cancel: blocked });
    });
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } });
    });
    ses.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400) this.recordNetworkIssue(details);
    });
    ses.webRequest.onErrorOccurred((details) => this.recordNetworkIssue(details));
    ses.on('will-download', (event, item, sourceContents) => {
      if (protectedWorkspace) {
        event.preventDefault();
        this.addPrivacyEvent('blocked', 'Download blocked in Banking', item.getFilename().slice(0, 300));
        return;
      }
      const downloadOrigin = safeOrigin(item.getURL());
      const evaluation = this.permissions.evaluate(accountSpaceId, workspaceId, downloadOrigin, 'download');
      if (evaluation === 'denied') {
        event.preventDefault();
        return;
      }
      if (evaluation === 'prompt') {
        event.preventDefault();
        try {
          const prompt = this.permissions.createPrompt(accountSpaceId, workspaceId, downloadOrigin, 'download');
          const downloadUrl = item.getURL();
          this.queuePermissionPrompt(prompt, (allowed) => {
            if (allowed && !sourceContents.isDestroyed()) sourceContents.downloadURL(downloadUrl);
          }, true);
        } catch {
          // Invalid and untrustworthy download origins fail closed.
        }
        return;
      }
      const id = randomUUID();
      const entry: DownloadEntry = {
        id,
        accountSpaceId,
        filename: item.getFilename(),
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
        risk: downloadRisk(item.getFilename()),
      };
      this.downloads.set(id, entry);
      this.downloadItems.set(id, item);
      item.on('updated', (_downloadEvent, state) => {
        Object.assign(entry, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state });
        this.broadcast();
      });
      item.once('done', (_downloadEvent, state) => {
        this.downloadItems.delete(id);
        Object.assign(entry, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state, savePath: item.getSavePath() });
        this.broadcast();
        if (state !== 'completed') return;
        void verifyDownload(entry.savePath ?? '', entry.filename, this.expectedInstaller).then((checksum) => {
          if (checksum === 'unchecked') return;
          entry.checksum = checksum;
          this.addPrivacyEvent(
            checksum === 'verified' ? 'vault' : 'blocked',
            checksum === 'verified' ? 'Installer checksum verified' : 'Installer checksum did NOT match',
            checksum === 'verified'
              ? `${entry.filename} matches the signed release manifest`
              : `${entry.filename} does not match the published checksum — do not run it`,
          );
          this.broadcast();
        });
      });
      this.broadcast();
    });
  }

  private async showActiveTab(): Promise<void> {
    const tab = this.activeTab(this.store.get());
    if (!tab.isHome && isAllowedRemoteUrl(tab.url)) {
      const view = this.ensureView(tab.id);
      view.setVisible(true);
      this.applyLayout();
      if (!view.webContents.getURL()) await view.webContents.loadURL(tab.url);
      this.scheduleAutomaticFill(tab.id);
    }
    this.broadcast();
  }

  private hideAllViews(): void {
    for (const runtime of this.runtimeTabs.values()) {
      runtime.view?.webContents.closeDevTools();
      runtime.view?.setVisible(false);
    }
  }

  private applyLayout(): void {
    const state = this.store.get();
    const active = this.activeTab(state);
    const runtime = this.runtimeTabs.get(active.id);
    if (!runtime?.view || active.isHome || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    runtime.view.setBounds({
      x: this.layout.left,
      y: this.layout.top,
      width: Math.max(100, width - this.layout.left - this.layout.right),
      height: Math.max(100, height - this.layout.top - this.layout.bottom),
    });
  }

  /**
   * Fetch a page's favicon inside that page's OWN session partition and hand the
   * renderer an inert `data:` URL.
   *
   * The chrome window has no partition of its own, so rendering the page-chosen
   * URL directly in an `<img>` made the trusted window fetch it on the default
   * session: outside tracker blocking, and shared by all five workspaces, which
   * let a site correlate activity across them — including Banking. Doing the
   * fetch here keeps it inside the workspace's cookie jar and behind the same
   * request filter as the page itself, and lets the renderer CSP drop `https:`
   * from `img-src` entirely.
   */
  private async updateFavicon(tabId: string, ses: Session, url?: string): Promise<void> {
    if (!url) {
      this.updateRuntime(tabId, { favicon: undefined });
      return;
    }
    const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const cacheKey = `${tab.accountSpaceId}:${url}`;
    const cached = this.faviconCache.get(cacheKey);
    if (cached) {
      this.updateRuntime(tabId, { favicon: cached });
      return;
    }
    if (!isAllowedRemoteUrl(url)) return;
    try {
      const response = await ses.fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'follow' });
      if (!response.ok) return;
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!FAVICON_TYPES.has(type)) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      // The icon rides along in every state broadcast, so keep it small.
      if (!bytes.byteLength || bytes.byteLength > MAX_FAVICON_BYTES) return;
      const dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
      if (this.faviconCache.size >= 200) this.faviconCache.delete(this.faviconCache.keys().next().value!);
      this.faviconCache.set(cacheKey, dataUrl);
      this.updateRuntime(tabId, { favicon: dataUrl });
    } catch {
      // A site without a reachable icon is ordinary, not an error worth showing.
    }
  }

  private updateRuntime(tabId: string, patch: Partial<RuntimeTab>): void {
    const runtime = this.runtimeTabs.get(tabId);
    if (!runtime) return;
    Object.assign(runtime, patch);
    if (runtime.view) {
      runtime.canGoBack = runtime.view.webContents.navigationHistory.canGoBack();
      runtime.canGoForward = runtime.view.webContents.navigationHistory.canGoForward();
    }
    this.broadcast();
  }

  private commitNavigation(tabId: string, url: string, addHistory = true): void {
    if (!isAllowedRemoteUrl(url)) return;
    const sanitizedUrl = stripTrackingParameters(url);
    if (isProtectedPage(sanitizedUrl)) this.runtimeTabs.get(tabId)?.view?.webContents.closeDevTools();
    this.store.update((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      tab.url = sanitizedUrl;
      tab.isHome = false;
      if (addHistory && tab.workspaceId !== 'banking') {
        state.history.unshift({ id: randomUUID(), title: tab.title, url: sanitizedUrl, workspaceId: tab.workspaceId, accountSpaceId: tab.accountSpaceId, visitedAt: new Date().toISOString() });
        state.history = state.history.slice(0, 2500);
      }
    });
    this.updateRuntime(tabId, {});
  }

  private addPrivacyEvent(kind: PrivacyEvent['kind'], title: string, detail: string): void {
    this.store.update((state) => {
      const accountSpaceId = state.activeAccountSpaceByWorkspace[state.activeWorkspaceId];
      state.privacyLog.unshift({ id: randomUUID(), at: new Date().toISOString(), kind, title, detail, accountSpaceId, service: kind === 'vault' ? 'vault' : 'browser' });
      state.privacyLog = state.privacyLog.slice(0, 100);
    });
    this.broadcast();
  }

  private copySensitiveValue(value: string): void {
    this.clipboardGuard.copy(value);
  }

  private pruneAiCapabilities(): void {
    const now = Date.now();
    for (const [id, item] of this.pendingAiPreviews) if (item.expiresAt < now) this.pendingAiPreviews.delete(id);
    for (const [id, item] of this.aiApprovals) if (item.expiresAt < now) this.aiApprovals.delete(id);
    while (this.pendingAiPreviews.size > 20) this.pendingAiPreviews.delete(this.pendingAiPreviews.keys().next().value!);
    while (this.aiApprovals.size > 20) this.aiApprovals.delete(this.aiApprovals.keys().next().value!);
  }

  private handleShortcut(event: Electron.Event, input: Electron.Input): void {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const command = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (input.key === 'F12' || (command && input.shift && key === 'i')) {
      event.preventDefault();
      void Promise.resolve().then(() => this.toggleDeveloperTools('right')).catch(() => undefined);
    } else if (command && key === 'l') {
      event.preventDefault();
      this.window.webContents.send('browser:focus-address');
    } else if (command && key === 't') {
      event.preventDefault();
      void this.newTab();
    } else if (command && key === 'w') {
      event.preventDefault();
      void this.closeTab(this.activeTab(this.store.get()).id);
    } else if (command && key === 'r') {
      event.preventDefault();
      this.reload();
    } else if (command && input.shift && key === 'b') {
      event.preventDefault();
      this.toggleBookmarkBar();
    } else if (input.alt && input.key === 'Left') {
      event.preventDefault();
      this.goBack();
    } else if (input.alt && input.key === 'Right') {
      event.preventDefault();
      this.goForward();
    }
  }
}

let controller: BrowserController | undefined;
let vscodeBridge: VscodeBridgeServer | undefined;
let pendingLaunchUrl = process.argv.find((argument) => isAllowedRemoteUrl(argument));
app.enableSandbox();
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_interface_only');
app.on('certificate-error', (event, webContents, _url, _error, _certificate, callback) => {
  event.preventDefault();
  controller?.markCertificateError(webContents.id);
  callback(false);
});
const e2eUserData = process.env.PRIVATE_BROWSER_E2E_USER_DATA;
if (!app.isPackaged && e2eUserData) app.setPath('userData', e2eUserData);

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const url = commandLine.find((argument) => isAllowedRemoteUrl(argument));
    if (url) void controller?.newTab(undefined, url);
    controller?.focus();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (isAllowedRemoteUrl(url)) {
      if (controller) void controller.newTab(undefined, url);
      else pendingLaunchUrl = url;
    }
  });
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!controller?.isTrustedSender(event)) throw new Error('Untrusted IPC sender');
}

const ipcGuard = new IpcGuard();

function handle<TArgs extends unknown[], TResult>(channel: string, callback: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrusted(event);
    ipcGuard.check(event.sender.id, channel, args);
    validateIpcArguments(channel, args);
    return callback(event, ...args as TArgs);
  });
}

if (hasSingleInstanceLock) void app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  const accountStore = new AccountStore(join(userDataPath, 'account-spaces'), safeStorage);
  const googleConfiguration = new GoogleConfigurationStore(join(userDataPath, 'google-configuration.enc'), safeStorage);
  const externalBrowsers = new ExternalBrowserLauncher();
  const googleOAuth = new GoogleOAuthManager(googleConfiguration, accountStore, externalBrowsers);
  const googleTokens = new GoogleTokenBroker(googleConfiguration, accountStore);
  const googleServices = new GoogleServices(googleTokens);
  const backups = new AccountBackupManager(accountStore, safeStorage, new GoogleDriveAppDataTransport(googleTokens));
  const persistedState = new AccountSpaceStateStore({
    paths: {
      legacyFilePath: join(userDataPath, 'browser-state.json'),
      manifestFilePath: join(userDataPath, 'browser-state-v2.json'),
      accountStateDirectory: join(userDataPath, 'account-browsing'),
      migrationJournalPath: join(userDataPath, 'browser-state-v2.migration.json'),
    },
    accountStore,
  });
  const store = new RuntimeStateStore(persistedState, accountStore, persistedState.initialize());
  const vault = new VaultBroker(new MyVaultDiskStore(userDataPath, safeStorage));
  vault.initialize();
  const aiProvider = new AiProviderStore(join(userDataPath, 'ai-provider.enc'));
  const updates = new UpdateServiceStore(join(userDataPath, 'update-service.enc'));
  const bridgeDataRoot = join(process.env.LOCALAPPDATA ?? userDataPath, 'Private Browser Bridge');
  vscodeBridge = new VscodeBridgeServer(join(userDataPath, 'vscode-bridge.enc'), join(bridgeDataRoot, 'rendezvous.json'), app.getVersion(), () => controller?.broadcast());
  try {
    await vscodeBridge.start();
  } catch (error) {
    dialog.showErrorBox('Private Browser could not start securely', `The local VS Code bridge failed closed. Restart Private Browser as your normal Windows user and check that operating-system credential protection is available.\n\n${error instanceof Error ? error.message : 'Unknown bridge error'}`);
    app.quit();
    return;
  }
  const updateBootstrapPath = join(process.resourcesPath, 'private-browser-update.json');
  try {
    const updateBootstrap = readUpdateBootstrap(updateBootstrapPath);
    if (updateBootstrap) updates.bootstrap(updateBootstrap, app.getVersion());
  } catch {
    console.error('update_bootstrap_invalid');
  } finally {
    // Remove the plaintext bootstrap whatever happened to it. Previously it was
    // deleted only when it had been stored successfully, so on a machine with no
    // OS encryption — exactly the machine least able to protect it — the shared
    // download token stayed readable in the install directory forever. Losing the
    // convenience of first-launch enrolment is the cheaper failure.
    removeUpdateBootstrap(updateBootstrapPath);
  }
  const migration = new VaultMigrationService(join(userDataPath, 'vault.enc'), join(userDataPath, 'myvault', 'migration-journal.enc'), safeStorage, vault);
  controller = new BrowserController(store, persistedState, accountStore, googleConfiguration, externalBrowsers, googleOAuth, googleServices, backups, vault, migration, aiProvider, updates, vscodeBridge);

  handle('browser:get-state', () => controller!.getSnapshot());
  handle('browser:navigate', (_event, value: string) => controller!.navigate(value));
  handle('browser:back', () => controller!.goBack());
  handle('browser:forward', () => controller!.goForward());
  handle('browser:reload', () => controller!.reload());
  handle('browser:stop', () => controller!.stop());
  handle('browser:new-tab', (_event, workspaceId?: WorkspaceId, url?: string, accountSpaceId?: AccountSpaceId) => controller!.newTab(workspaceId, url, accountSpaceId));
  handle('browser:close-tab', (_event, id: string) => controller!.closeTab(id));
  handle('browser:activate-tab', (_event, id: string) => controller!.activateTab(id));
  handle('browser:switch-workspace', (_event, id: WorkspaceId) => controller!.switchWorkspace(id));
  handle('browser:switch-account-space', (_event, id: AccountSpaceId) => controller!.switchAccountSpace(id));
  handle('accounts:add-local', (_event, workspaceId: WorkspaceId, label: string, color: AccountSpaceColor) => controller!.addLocalAccountSpace(workspaceId, label, color));
  handle('accounts:update', (_event, id: AccountSpaceId, label?: string, color?: AccountSpaceColor) => controller!.updateAccountSpace(id, label, color));
  handle('accounts:reorder', (_event, workspaceId: WorkspaceId, ids: AccountSpaceId[]) => controller!.reorderAccountSpaces(workspaceId, ids));
  handle('accounts:open-in', (_event, id: AccountSpaceId, url: string) => controller!.openInAccountSpace(id, url));
  handle('accounts:set-locked', (_event, id: AccountSpaceId, locked: boolean) => controller!.setAccountSpaceLocked(id, locked));
  handle('accounts:disconnect-google', (_event, id: AccountSpaceId, revoke?: boolean) => controller!.disconnectGoogleAccount(id, revoke));
  handle('accounts:clear-data', (_event, id: AccountSpaceId) => controller!.clearAccountSpaceData(id));
  handle('accounts:delete', (_event, id: AccountSpaceId, confirmation: string) => controller!.deleteAccountSpace(id, confirmation));
  handle('permissions:respond', (_event, promptId: string, decision: PermissionDecision, displaySourceId?: string) => controller!.respondToPermissionPrompt(promptId, decision, displaySourceId));
  handle('google:configure', (_event, clientId: string) => controller!.configureGoogle(clientId));
  handle('google:clear-configuration', () => controller!.clearGoogleConfiguration());
  handle('google:connect', (_event, id: AccountSpaceId, modules: GoogleModule[], browserId: ExternalBrowserId) => controller!.connectGoogleAccount(id, modules, browserId));
  handle('google:cancel', (_event, id: AccountSpaceId) => controller!.cancelGoogleConnection(id));
  handle('google:gmail-overview-run', (_event, id: AccountSpaceId, operationId: string) => controller!.gmailOverview(id, operationId));
  handle('google:gmail-search-run', (_event, id: AccountSpaceId, operationId: string, query?: string) => controller!.searchGmail(id, operationId, query));
  handle('google:gmail-prepare-send', (_event, id: AccountSpaceId, input: GmailSendInput, sourceRevision?: string) => controller!.prepareGmailSend(id, input, sourceRevision));
  handle('google:gmail-send', (_event, id: AccountSpaceId, operationId: string, input: GmailSendInput, confirmationToken: string, sourceRevision?: string) => controller!.sendGmail(id, operationId, input, confirmationToken, sourceRevision));
  handle('google:drive-list-run', (_event, id: AccountSpaceId, operationId: string, query?: string, wholeDrive?: boolean) => controller!.listDriveFiles(id, operationId, query, wholeDrive));
  handle('google:drive-create', (_event, id: AccountSpaceId, operationId: string, input: DriveCreateInput) => controller!.createDriveFile(id, operationId, input));
  handle('google:drive-prepare-share', (_event, id: AccountSpaceId, fileId: string, email: string, role: 'reader' | 'writer', sourceRevision?: string) => controller!.prepareDriveShare(id, fileId, email, role, sourceRevision));
  handle('google:drive-share', (_event, id: AccountSpaceId, operationId: string, fileId: string, email: string, role: 'reader' | 'writer', confirmationToken: string, sourceRevision?: string) => controller!.shareDriveFile(id, operationId, fileId, email, role, confirmationToken, sourceRevision));
  handle('google:calendar-list-run', (_event, id: AccountSpaceId, operationId: string, query?: string) => controller!.listCalendarEvents(id, operationId, query));
  handle('google:calendar-prepare-write', (_event, id: AccountSpaceId, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, sourceRevision?: string) => controller!.prepareCalendarWrite(id, action, input, sourceRevision));
  handle('google:calendar-write', (_event, id: AccountSpaceId, operationId: string, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, confirmationToken: string, sourceRevision?: string) => controller!.writeCalendarEvent(id, operationId, action, input, confirmationToken, sourceRevision));
  handle('google:contacts-list-run', (_event, id: AccountSpaceId, operationId: string) => controller!.listContacts(id, operationId));
  handle('backup:create-recovery', (_event, id: AccountSpaceId) => controller!.createBackupRecoveryCode(id));
  handle('backup:verify-enable', (_event, id: AccountSpaceId, recoveryCode: string, includeOpenTabs: boolean, includeHistory: boolean) => controller!.verifyAndEnableBackup(id, recoveryCode, includeOpenTabs, includeHistory));
  handle('backup:upload', (_event, id: AccountSpaceId, operationId: string, conflictResolution?: 'merge' | 'overwrite') => controller!.uploadBackup(id, operationId, conflictResolution));
  handle('backup:restore', (_event, id: AccountSpaceId, operationId: string, recoveryCode?: string) => controller!.restoreBackup(id, operationId, recoveryCode));
  handle('backup:disable', (_event, id: AccountSpaceId) => controller!.disableBackup(id));
  handle('operations:cancel', (_event, operationId: string) => controller!.cancelOperation(operationId));
  handle('recovery:act', (_event, action: StateRecoveryAction, confirmation?: string) => controller!.recoveryAction(action, confirmation));
  handle('browser:set-layout', (_event, layout: Layout) => controller!.setLayout(layout));
  handle('browser:set-overlay-open', (_event, open: boolean) => controller!.setOverlayOpen(open));
  handle('browser:toggle-bookmark', () => controller!.toggleBookmark());
  handle('browser:open-bookmark', (_event, id: string) => controller!.openBookmark(id));
  handle('browser:toggle-bookmark-bar', () => controller!.toggleBookmarkBar());
  handle('browser:list-chrome-profiles', () => controller!.listChromeProfiles());
  handle('browser:import-chrome', (_event, options: ChromeImportOptions) => controller!.importChrome(options));
  handle('browser:import-chrome-passwords', () => controller!.importChromePasswords());
  handle('browser:toggle-tracker-blocking', () => controller!.toggleTrackerBlocking());
  handle('browser:open-download', (_event, id: string) => controller!.openDownload(id));
  handle('browser:show-download', (_event, id: string) => controller!.showDownload(id));
  handle('developer:toggle-tools', (_event, mode: DevToolsMode) => controller!.toggleDeveloperTools(mode));
  handle('developer:capture-diagnostics', () => controller!.captureDeveloperDiagnostics());
  handle('developer:clear-diagnostics', () => controller!.clearDeveloperDiagnostics());
  handle('developer:bridge-status', () => controller!.getBridgeStatus());
  handle('developer:bridge-pair', () => controller!.beginBridgePairing());
  handle('developer:bridge-disconnect', (_event, revoke: boolean) => controller!.disconnectBridge(revoke));
  handle('developer:bridge-projects', () => controller!.listBridgeProjects());
  handle('developer:bridge-select-project', (_event, projectId: string) => controller!.selectBridgeProject(projectId));
  handle('developer:bridge-action', (_event, action: DeveloperBridgeAction, payload: Record<string, unknown>) => controller!.runBridgeAction(action, payload));
  handle('developer:inspect-page', (_event, selectElement: boolean) => controller!.inspectDeveloperPage(Boolean(selectElement)));
  handle('developer:prepare-ai-preview', (_event, options: DeveloperAiPreviewOptions) => controller!.prepareDeveloperAiPreview({ includeDom: Boolean(options?.includeDom), includeScreenshot: Boolean(options?.includeScreenshot) }));
  handle('developer:install-extension', () => controller!.installBridgeExtension());
  handle('ai:prepare-preview', () => controller!.prepareAiPreview());
  handle('ai:approve-preview', (_event, previewId: string) => controller!.approveAiPreview(previewId));
  handle('ai:provider-status', () => controller!.getAiProvider());
  handle('ai:configure-provider', (_event, input: AiProviderInput) => controller!.configureAiProvider(input));
  handle('ai:clear-provider', () => controller!.clearAiProvider());
  handle('ai:ask', (_event, token: string, question: string) => controller!.askAi(token, question));
  handle('ai:revoke', () => controller!.revokeAiContext());
  handle('vault:list', () => controller!.listVault());
  handle('vault:request-unlock', () => controller!.requestVaultUnlock());
  handle('vault:request-pairing', () => controller!.requestVaultPairing());
  handle('vault:lock', () => controller!.lockVault());
  handle('vault:sync', () => controller!.syncVaultNow());
  handle('vault:reconnect', () => controller!.listVault().lifecycle === 'unlocked' ? controller!.syncVaultNow() : undefined);
  handle('vault:conflict-review', () => controller!.getVaultConflictReview());
  handle('vault:resolve-conflict', (_event, choice: 'cloud' | 'local') => controller!.resolveVaultConflict(choice));
  handle('vault:migration-status', () => controller!.migrationStatus());
  handle('vault:migrate-legacy', () => controller!.migrateLegacyVault());
  handle('vault:cleanup-legacy', () => controller!.cleanupLegacyVault());
  handle('vault:open-editor', (_event, origin?: string) => controller!.openVaultEditor(origin));
  handle('vault:form-shape', () => controller!.inspectVaultFormShape());
  handle('vault:save-from-page', () => controller!.requestSaveFromPage());
  handle('vault:request-delete', (_event, id: string) => controller!.requestVaultDelete(id));
  handle('vault:acknowledge-recovery', () => controller!.acknowledgeVaultRecovery());
  handle('vault:copy-password', (_event, id: string) => controller!.copyPassword(id));
  handle('vault:copy-totp', (_event, id: string) => controller!.copyTotp(id));
  handle('vault:copy-generated', (_event, kind: GeneratedCredentialKind) => controller!.copyGeneratedCredential(kind));
  handle('vault:autofill', (_event, id: string) => controller!.autofill(id));
  handle('system:copy', (_event, value: string) => clipboard.writeText(String(value).slice(0, 100_000)));
  handle('system:is-default-browser', () => controller!.isDefaultBrowser());
  handle('system:set-default-browser', () => controller!.setDefaultBrowser());
  handle('updates:status', () => controller!.getUpdateService());
  handle('updates:configure', (_event, input: UpdateServiceInput) => controller!.configureUpdateService(input));
  handle('updates:clear', () => controller!.clearUpdateService());
  handle('updates:check', () => controller!.checkForUpdates());
  handle('updates:open-page', () => controller!.openUpdatePage());

  await controller.createWindow();
  setTimeout(() => void controller?.checkForUpdatesInBackground(), 10_000).unref();
  setInterval(() => void controller?.checkForUpdatesInBackground(), 24 * 60 * 60_000).unref();
  if (pendingLaunchUrl) {
    const url = pendingLaunchUrl;
    pendingLaunchUrl = undefined;
    await controller.newTab(undefined, url);
  }
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await controller!.createWindow();
  });
});

app.on('before-quit', () => {
  void controller?.flushClipboard();
  void vscodeBridge?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
