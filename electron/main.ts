import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentDataRoot } from '@private-browser/bridge-protocol/agent-location';
import { AgentHost } from './agent-host.js';
import type { AgentDecision } from './agent-types.js';
import { agentUrl } from './agent-policy.js';
import type { AgentSpaceSettings, ClientLimits } from '@private-browser/bridge-protocol/agent-permissions';
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  safeStorage,
  screen,
  session,
  shell,
  WebContentsView,
  type DownloadItem,
  type HandlerDetails,
  type IpcMainInvokeEvent,
  type Session,
  type WindowOpenHandlerResponse,
} from 'electron';
import { downloadRisk, isAllowedRemoteUrl, isAllowedSitePermission, isAutofillTarget, isProtectedPage, navigationWarning, parseWebAddress, redactSensitiveText, stripTrackingParameters, urlOriginForSharing } from './security.js';
import { externalLinkAccounts, isAvailableRegularAccount, preferredExternalLinkAccount } from './external-link-routing.js';
import { ClipboardGuard } from './clipboard-guard.js';
import { downloadFileStamp, inspectDownloadPublisher, verifyDownload, type ExpectedInstaller } from './download-verify.js';
import { downloadExtension, downloadOpenBlock } from './download-safety.js';
import { DownloadHistoryStore } from './download-history.js';
import { getDomain } from 'tldts';
import { AiProviderStore } from './ai-provider.js';
import { AI_SYSTEM_PROMPT, MAX_ASSISTANT_CONTEXT, MAX_ASSISTANT_SOURCE_TEXT, assistantQuestion, aiUserPrompt, formatAssistantExcerpts, readAssistantAnswer } from './ai-prompt.js';
import { WORKSPACES } from './state-store.js';
import { AccountStore, MAX_ASSISTANT_RECEIPTS } from './account-store.js';
import { AccountSpaceStateStore } from './account-space-state.js';
import { RuntimeStateStore } from './runtime-state-store.js';
import { problemForFailedLoad, StartupRestoreJournal } from './startup-restore.js';
import { keepTabBlockIndex, orderAccountTabs, organizeTabs, replaceAccountTabOrder, tabBatchTargets } from './tab-organization.js';
import { CHROME, contentBounds, DEFAULT_CONTENT_INSETS, FRAME_COLORS, sanitizeContentInsets, ZERO_INSETS, type ContentInsets } from './chrome-layout.js';
import { needsChromeFocus, resolveShortcut } from './shortcuts.js';
import { FAVICON_TYPES, MAX_FAVICON_BYTES, rememberBookmarkIcon } from './bookmark-icons.js';
import { appendImportedBookmarks, exportBookmarksHtml, moveTabWithinAccountSpace, removeBookmark, removeBookmarkFolder, renameBookmark, renameBookmarkFolder, reorderBookmarkEntry } from './bookmark-tree.js';
import { readBookmarkHtml } from './bookmark-html.js';
import { mergeBrowserSettings, nextZoomPercent, referenceSearchUrl, resolveHomeUrl, resolveWorkspaceNavigation, settingsForWorkspace, SPELLCHECK_LANGUAGES, spellingDictionary, type BrowserSettingsPatch, type SpellcheckLanguage, type SpellcheckSettings } from './browser-settings.js';
import { browsingDataVisitIds, requireBrowsingDataInput } from './browsing-data.js';
import { mergeUiPreferences, type UiPreferencesPatch } from './ui-preferences.js';
import { sanitizeShortcutTiles } from './account-space-state.js';
import type {
  AccountSpaceColor,
  AccountSpaceBrowserTab,
  AccountSpaceBookmark,
  AccountSpaceId,
  ExternalBrowserId,
  GoogleModule,
  AiApproval,
  AiPagePreview,
  AiPreviewScope,
  AiRequestReview,
  AssistantAnswer,
  AssistantReceipt,
  AssistantSelectionEdit,
  AssistantSelectionSource,
  AssistantSpacePolicy,
  ControlCenterRecheckInput,
  ControlCenterSendInput,
  AiProviderInput,
  BookmarkEntryKeyInput,
  BookmarkLevelInput,
  BrowserSnapshot,
  BrowserTab,
  BrowserRoutine,
  RoutineRunResult,
  ChromeImportOptions,
  ChromeImportResult,
  ChromeProfileSource,
  DeveloperAiPreviewOptions,
  DeveloperConsoleEntry,
  DeveloperBridgeAction,
  DeveloperPageInfo,
  DeveloperNetworkIssue,
  DevToolsMode,
  DownloadAction,
  DownloadEntry,
  AddressMatch,
  HistoryQuery,
  RecentlyClosedTab,
  PrivacyEvent,
  RuntimeBrowserStateV2,
  PermissionCapability,
  PermissionDecision,
  PermissionPrompt,
  ShortcutTile,
  UpdateServiceInput,
  WorkspaceId,
  StateRecoveryAction,
  StartupTabRecovery,
  TabProblem,
  TabOrganizationAction,
  TabBatchScope,
  TabGroup,
} from './types.js';
import type { ProjectInfo, ProjectSummary } from '@private-browser/bridge-protocol';
import { generateTotp } from './vault.js';
import { VaultBroker, type GeneratedCredentialKind } from './myvault/vault-broker.js';
import { MyVaultDiskStore } from './myvault/vault-store.js';
import { SecureVaultDialogs } from './myvault/secure-dialog.js';
import { SECURE_CREDENTIAL_PRESETS, type ConfirmDeleteDialogValue, type EditLoginDialogValue, type SecureCredentialPreset, type UnlockDialogValue } from './myvault/secure-dialog-contract.js';
import { FillCapabilityStore, normalizedWebOrigin, type FillContext } from './myvault/fill-capability.js';
import { captureLoginInIsolatedWorld, fillLoginAutomaticallyInIsolatedWorld, fillLoginInIsolatedWorld, hasSupportedLoginForm, inspectLoginFormShape, probeFocusedLoginField } from './myvault/isolated-fill.js';
import type { VaultFillReadiness } from './types.js';
import { FillPicker } from './myvault/fill-picker.js';
import { FillPreferenceStore } from './myvault/fill-preferences.js';
import { isSameSiteFillCandidate } from './myvault/site-match.js';
import { fillPickerBounds, type FillPickerChoice } from './myvault/fill-picker-model.js';
import { workspaceVaultPolicy } from './myvault/workspace-policy.js';
import { FILL_PICKER_MAX_ROWS, isAutomaticFillPageUrl, orderFillCandidates, selectAutomaticFillEntry } from './myvault/automatic-fill.js';
import { MyVaultSyncClient } from './myvault/vault-sync.js';
import { VaultSyncController } from './myvault/sync-controller.js';
import type { PairDialogValue } from './myvault/secure-dialog-contract.js';
import { VaultMigrationService } from './myvault/vault-migration.js';
import { canInstallPasskeyProvider, InternalPasskeyController, type PasskeyOptIns } from './myvault/passkey-controller.js';
import { PlatformUnlockError, WindowsHelloSigner } from './myvault/windows-hello.js';
import { PUBLIC_UPDATE_ENDPOINT, UpdateServiceStore } from './update-service.js';
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
import { healthFromGoogleConnection, observeGoogleHealth } from './google-connection-health.js';
import type { GoogleConnectionHealth } from './types.js';
import { AccountBackupManager, restorableItems, type BackupWriteResult } from './account-backup.js';
import { GoogleDriveAppDataTransport } from './google-backup-transport.js';
import { validateIpcArguments } from './ipc-contracts.js';
import { ControlCenterLink, developerEvidence } from './control-center-link.js';
import { aiSourceRevision, classifyAiSource, maySendAiPreviewToCloud, sameAiSource } from './ai-account-spaces.js';
import { googleWebsiteStatus, isKnownGoogleWebHost } from './google-website-status.js';
import { listChromeProfiles, readChromeProfile, type ChromeProfileData } from './chrome-importer.js';
import { chromeImportBookmarkStamp, chromeImportKey, planChromeImport } from './chrome-import-review.js';
import type { ChromeImportReview } from './types.js';
import { VscodeBridgeServer } from './vscode-bridge.js';
import { adoptPopupWindow, guardPageNavigation, popupWindowResponse, wantsPopupWindow } from './popup-windows.js';
import { SideAppHost } from './side-apps.js';
import { isSideAppId, type SideAppCommand, type SideAppId, type SideAppRect } from './side-app-registry.js';
import { canonicalRoutineUrl, defaultBrowserRoutines, MAX_ROUTINES, requireBrowserRoutine } from './browser-routines.js';
import { appendTabSetBookmarks, resolveTabSet } from './tab-sets.js';
import type {
  BrowsingDataInput,
  BrowsingDataReview,
  ChromePasswordImportResult,
  ChromePasswordImportReview,
  ReferenceSearchInput,
  TabSetInput,
} from './types.js';
import { showPageContextMenu } from './page-context-menu.js';
import { planBookmarkBatch } from './bookmark-batch.js';
import { changeBookmarkBatch, editBookmarkAddress, restoreBookmarkBatch, type BookmarkUndo } from './bookmark-maintenance.js';

interface AssistantCapture {
  preview: AiPagePreview;
  navigationGeneration: number;
}

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
  problem?: TabProblem;
  failedUrl?: string;
  automaticFillGeneration?: number;
  automaticFillPending: boolean;
}

type Layout = ContentInsets;

const WHEEL_ZOOM_INTERVAL_MS = 100;
const MAX_CLOSED_TABS = 25;

const AUTOMATIC_FILL_RETRY_DELAYS_MS = [0, 300, 1_000, 2_500] as const;
/** At most this many popups per page view in any rolling window. */
const MAX_POPUPS_PER_WINDOW = 5;
const POPUP_WINDOW_MS = 10_000;

/**
 * The origin a passkey opt-in is keyed by, or a placeholder that matches no
 * opt-in. Never throws: `normalizedWebOrigin` refuses punycode hosts, and a
 * throw during view creation used to leave the view without its guards.
 */
/** A response body, or undefined as soon as it grows past `limit` bytes. */
async function readAtMost(response: Response, limit: number): Promise<Buffer | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    total += value.byteLength;
    if (total > limit) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
}

function passkeyOriginFor(url: string): string {
  try {
    return url === 'private://home' ? 'https://invalid.local' : normalizedWebOrigin(url);
  } catch {
    return 'https://invalid.local';
  }
}

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

type LocalDownload = DownloadEntry & { savePath?: string; expectedInstaller?: ExpectedInstaller; verifiedStamp?: string; retainedFileStamp?: string };

class BrowserController {
  private browsingDataReview?: { review: BrowsingDataReview; initiator: AccountSpaceId; visits: Set<string>; expiresAt: number };
  private pendingChromePasswords?: { id: string; accountId: AccountSpaceId; path: string; digest: string; revision: string; expiresAt: number };
  private selectingChromePasswords = false;
  private readonly runtimeTabs = new Map<string, RuntimeTab>();
  private readonly downloads = new Map<string, LocalDownload>();
  private readonly downloadItems = new Map<string, DownloadItem>();
  private readonly downloadHistory = new DownloadHistoryStore(join(app.getPath('userData'), 'download-history'), safeStorage);
  private readonly downloadHistoryFailures = new Set<AccountSpaceId>();
  private readonly configuredSessions = new Set<string>();
  private spellingLanguages?: SpellcheckLanguage[];
  private readonly pendingAiPreviews = new Map<string, { preview: AiPagePreview; expiresAt: number; navigationGeneration?: number; parentId?: string }>();
  private assistantReview?: AssistantCapture & { review: AiRequestReview; question: string; withEvidence: boolean; expiresAt: number; additional: AssistantCapture[]; excerpts: string[] };
  private activeAssistant?: { id: string; mode: 'local' | 'cloud'; controller: AbortController };
  private readonly aiApprovals = new Map<string, { preview: AiPagePreview; mode: 'cloud' | 'local'; expiresAt: number }>();
  /** Previews the Developer panel built from diagnostics: the only ones the Control Center may receive. */
  private readonly developerPreviewIds = new Set<string>();
  private readonly clipboardGuard = new ClipboardGuard({
    writeText: (text) => process.platform === 'win32' ? clipboard.write([new ClipboardItem({
      'text/plain': text,
      'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"': new Blob([new Uint8Array(4)]),
    })]) : clipboard.writeText(text),
    readText: () => clipboard.readText(),
    clear: () => clipboard.clear(),
  });
  private readonly permissions: AccountPermissionManager;
  private pendingPermission?: {
    prompt: PermissionPrompt;
    respond: (allowed: boolean, displaySourceId?: string) => void;
    retainAllowOnce: boolean;
  };
  private readonly faviconCache = new Map<string, string>();
  private readonly operations = new Map<string, { accountSpaceId: AccountSpaceId; controller: AbortController }>();
  private readonly googleChecks = new Map<AccountSpaceId, GoogleConnectionHealth>();
  private expectedInstaller?: ExpectedInstaller;
  private layout: Layout = { ...DEFAULT_CONTENT_INSETS };
  private readonly closedTabs = new Map<AccountSpaceId, RecentlyClosedTab[]>();
  private readonly bookmarkUndo = new Map<AccountSpaceId, BookmarkUndo<AccountSpaceBookmark>>();
  private pendingChromeImport?: {
    id: string; accountSpaceId: AccountSpaceId; initiatingAccount: AccountSpaceId; source: ChromeProfileData; importKey: string; expiresAt: number;
  };
  private readonly chromeImportUndo = new Map<AccountSpaceId, { bookmarks: Map<string, string>; history: Set<string> }>();
  private readonly closedTabBatches = new Map<AccountSpaceId, {
    entries: Array<{ tab: AccountSpaceBrowserTab; index: number }>;
    groups: TabGroup[];
    groupName?: string;
  }>();
  private startingWindow = true;
  private startupTabRecovery?: StartupTabRecovery;
  private readonly startupRestoreJournal = new StartupRestoreJournal(join(app.getPath('userData'), 'startup-restore.json'));
  private htmlFullscreenOwner?: string;
  private settleLayoutTimer?: NodeJS.Timeout;
  private settleBroadcast = false;
  private appliedFrame?: (typeof FRAME_COLORS)[keyof typeof FRAME_COLORS];
  private window!: BrowserWindow;
  private readonly secureDialogs = new SecureVaultDialogs(() => this.window);
  private readonly windowsHello = new WindowsHelloSigner();
  /** Probed once, off the startup path; undefined until the answer arrives. */
  private windowsHelloAvailable?: boolean;
  private windowsHelloProbe?: Promise<boolean>;
  private readonly fillCapabilities = new FillCapabilityStore();
  private readonly fillPicker: FillPicker = new FillPicker(() => this.window, { choose: (choice) => void this.handleFillPickerChoice(choice) });
  private readonly vaultSync: VaultSyncController;
  private dirtySyncTimer?: NodeJS.Timeout;
  private readonly passkeyController = new InternalPasskeyController();
  private readonly passkeyOptIns: PasskeyOptIns = { global: false, workspaces: {}, sites: {} };
  private readonly sideApps = new SideAppHost({
    window: () => this.window,
    packaged: app.isPackaged,
    openInTab: (url) => this.openFromSideApp(url),
    handleShortcut: (event, input) => this.handleShortcut(event, input),
    isBlockedRequest: (url) => this.isBlockedTrackerRequest(url),
    privacyEvent: (kind, title, detail) => this.addPrivacyEvent(kind, title, detail),
    changed: () => { if (this.window && !this.window.isDestroyed()) this.broadcast(); },
  });
  /** A menu or dialog covers the chrome: the side app hides with the page. */
  private overlayOpen = false;

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
    private readonly controlCenter: ControlCenterLink,
    private readonly fillPreferences: FillPreferenceStore,
  ) {
    this.permissions = new AccountPermissionManager(accounts);
    const state = this.store.get();
    const active = this.activeTab(state);
    this.runtimeTabs.set(active.id, this.newRuntimeTab());
    this.vaultSync = new VaultSyncController(vault, new MyVaultSyncClient());
    this.vault.subscribe((status) => {
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send('vault:state');
      if (status.lifecycle !== 'unlocked') this.fillPicker.close();
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
    this.startingWindow = true;
    nativeTheme.themeSource = this.store.get().ui.theme;
    const frame = this.frameColors();
    this.appliedFrame = frame;
    this.window = new BrowserWindow({
      width: 1500,
      height: 940,
      minWidth: 900,
      minHeight: 600,
      backgroundColor: frame.window,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: frame.frame, symbolColor: frame.symbol, height: CHROME.tabStrip },
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
    // The login picker is anchored to one field; anything that moves or covers it closes the list.
    this.window.on('blur', () => this.fillPicker.close());
    this.window.webContents.on('input-event', (_event, input) => { if (input.type === 'mouseDown') this.fillPicker.close(); });
    this.window.on('resize', () => this.scheduleLayout());
    // Maximise, restore and full screen report their events while Windows is still
    // settling the frame, so the content size read then can be one DIP short.
    // `scheduleLayout` applies now and again once the size has settled.
    for (const event of ['resized', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
      this.window.on(event as 'maximize', () => {
        this.scheduleLayout(true);
        this.broadcast();
      });
    }
    const onDisplayChange = () => { if (!this.window.isDestroyed()) this.scheduleLayout(); };
    screen.on('display-metrics-changed', onDisplayChange);
    const onThemeChange = () => this.applyFrameColors();
    nativeTheme.on('updated', onThemeChange);
    // The chrome's geometry is expressed in DIPs; a zoomed chrome would drift from the page view.
    this.window.webContents.on('did-finish-load', () => this.window.webContents.setZoomFactor(1));
    this.window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
    this.window.on('closed', () => {
      screen.removeListener('display-metrics-changed', onDisplayChange);
      nativeTheme.removeListener('updated', onThemeChange);
      for (const runtime of this.runtimeTabs.values()) {
        runtime.view?.webContents.close();
        runtime.view = undefined;
      }
      this.sideApps.closeAll();
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
    // Listen before loading: `ready-to-show` can fire before `loadURL` resolves,
    // and a listener attached afterwards would leave the window hidden for good.
    this.window.once('ready-to-show', () => { if (!this.window.isDestroyed()) this.window.show(); });
    // The window always opens maximised. Maximising before the chrome loads lets the
    // resize settle before any page exists; a later resize would close an open login picker.
    this.window.maximize();
    await this.window.loadURL(devUrl ?? productionUrl);
    if (!this.window.isDestroyed() && !this.window.isVisible()) this.window.show();
    this.startingWindow = false;
    await this.restoreStartupTab();
  }

  private async restoreStartupTab(): Promise<void> {
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (this.store.isReadOnly() || tab.isHome || tab.restorePaused || state.recovery?.accountSpaceId === tab.accountSpaceId
      || state.accountSpaces.find((account) => account.id === tab.accountSpaceId)?.locked) {
      this.startupRestoreJournal.clear();
      await this.showActiveTab();
      return;
    }
    if (!this.startupRestoreJournal.begin(tab.id)) {
      this.startupTabRecovery = { accountSpaceId: tab.accountSpaceId, failedTabId: tab.id };
      this.broadcast();
      return;
    }
    await this.showActiveTab();
    if (!this.window.isDestroyed() && !this.runtimeTabs.get(tab.id)?.problem) this.startupRestoreJournal.clear();
  }

  async restoreSelectedTabs(ids: string[]): Promise<void> {
    const recovery = this.startupTabRecovery;
    const state = this.store.get();
    if (!recovery || this.activeAccountSpaceId(state) !== recovery.accountSpaceId) throw new Error('Tab recovery is unavailable');
    const tabs = state.tabs.filter((tab) => tab.accountSpaceId === recovery.accountSpaceId);
    const selected = new Set(ids);
    if (selected.size !== ids.length || ids.some((id) => !tabs.some((tab) => tab.id === id))) throw new Error('Choose tabs in this Account Space');
    this.store.update((next) => {
      for (const tab of next.tabs) {
        if (tab.accountSpaceId === recovery.accountSpaceId && !tab.isHome) tab.restorePaused = !selected.has(tab.id);
      }
    });
    this.startupTabRecovery = undefined;
    this.startupRestoreJournal.clear();
    const first = tabs.find((tab) => selected.has(tab.id));
    if (first) await this.activateTab(first.id);
    else await this.newTab();
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
        problem: runtime?.problem,
        securityWarning: tab.isHome ? undefined : navigationWarning(tab.url),
        ...this.runtimeMedia(runtime),
      };
    });
    const activeAccountSpaceId = this.activeAccountSpaceId(persisted);
    const bookmarkUndo = this.bookmarkUndo.get(activeAccountSpaceId);
    const closedBatch = this.closedTabBatches.get(activeAccountSpaceId);
    const windowReady = Boolean(this.window && !this.window.isDestroyed());
    const downloadAccount = this.activeDownloadAccount(persisted);
    return {
      workspaces: WORKSPACES,
      activeWorkspaceId: persisted.activeWorkspaceId,
      activeTabId: this.activeTab(persisted).id,
      tabs,
      bookmarks: persisted.bookmarks,
      bookmarkUndo: bookmarkUndo ? { kind: bookmarkUndo.kind, count: bookmarkUndo.before.length } : undefined,
      history: persisted.history.slice(0, 100),
      downloads: downloadAccount ? this.downloadEntries(downloadAccount) : [],
      downloadHistory: !downloadAccount ? undefined : this.downloadHistoryFailures.has(downloadAccount)
        ? 'unavailable' : this.downloadHistory.status(downloadAccount),
      privacyLog: persisted.privacyLog.slice(0, 50),
      trackerBlocking: persisted.trackerBlocking,
      activeAccountSpaceId,
      accountSpaces: persisted.accountSpaces,
      accountHealth: persisted.accountHealth,
      recovery: persisted.recovery,
      startupTabRecovery: this.startupTabRecovery?.accountSpaceId === activeAccountSpaceId ? this.startupTabRecovery : undefined,
      tabGroups: persisted.tabGroupsByAccountSpace?.[activeAccountSpaceId] ?? [],
      closedTabBatch: closedBatch ? { count: closedBatch.entries.length, groupName: closedBatch.groupName } : undefined,
      pendingPermission: this.pendingPermission?.prompt,
      setupVaultStatus: persisted.activeWorkspaceId !== 'banking' && persisted.activeWorkspaceId !== 'development'
        ? this.vault.status().lifecycle : undefined,
      googleConfiguration: this.googleConfiguration.status(),
      externalBrowsers: this.externalBrowsers.discover().map(({ id, name }) => ({ id, name })),
      bookmarkBarVisible: persisted.bookmarkBarVisible,
      ui: persisted.ui,
      settings: settingsForWorkspace(persisted, persisted.activeWorkspaceId),
      availableSpellcheckLanguages: this.availableSpellcheckLanguages(),
      assistantPolicy: this.assistantPolicy(persisted),
      windowState: {
        maximized: windowReady && this.window.isMaximized(),
        fullscreen: windowReady && this.window.isFullScreen(),
        darkMode: nativeTheme.shouldUseDarkColors,
      },
      shortcutsByAccountSpace: persisted.shortcutsByAccountSpace,
      bookmarkIcons: persisted.bookmarkIconsByAccountSpace[activeAccountSpaceId] ?? {},
      canReopenClosedTab: (this.closedTabs.get(activeAccountSpaceId)?.length ?? 0) > 0,
      recentlyClosedTabs: (this.closedTabs.get(activeAccountSpaceId) ?? []).slice().reverse(),
      routines: this.canUseRoutines(persisted) ? this.routines(persisted) : [],
      sideApps: this.sideApps.snapshot(),
    };
  }

  private runtimeMedia(runtime?: RuntimeTab): Pick<BrowserTab, 'audible' | 'muted' | 'zoomPercent'> {
    const contents = runtime?.view?.webContents;
    if (!contents || contents.isDestroyed()) return {};
    return {
      audible: contents.isCurrentlyAudible(),
      muted: contents.isAudioMuted(),
      zoomPercent: Math.round(contents.getZoomFactor() * 100),
    };
  }

  private frameColors() {
    return nativeTheme.shouldUseDarkColors ? FRAME_COLORS.dark : FRAME_COLORS.light;
  }

  private applyFrameColors(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const frame = this.frameColors();
    // `nativeTheme` emits `updated` for unrelated system changes and during
    // startup; reconfiguring the native overlay for no colour change is wasted
    // compositor work, so only touch the window when the colours really differ.
    if (this.appliedFrame !== frame) {
      this.appliedFrame = frame;
      this.window.setBackgroundColor(frame.window);
      try { this.window.setTitleBarOverlay({ color: frame.frame, symbolColor: frame.symbol, height: CHROME.tabStrip }); } catch { /* not supported on this platform */ }
    }
    this.broadcast();
  }

  broadcast(): void {
    agentHost?.validateLentTab();
    if (!this.window.isDestroyed()) this.window.webContents.send('browser:state', this.getSnapshot());
  }

  isTrustedSender(event: IpcMainInvokeEvent): boolean {
    return Boolean(this.window) && !this.window.isDestroyed()
      && event.sender === this.window.webContents
      && event.senderFrame === this.window.webContents.mainFrame;
  }

  agentParent(): BrowserWindow | undefined {
    return this.window && !this.window.isDestroyed() ? this.window : undefined;
  }

  notifyAgentChange(): void { this.agentParent()?.webContents.send('agents:changed'); }

  async lendAgentTab(tabId: string, clientId: string): Promise<void> {
    const state = this.store.get();
    const tab = this.activeTab(state);
    const runtime = this.runtimeTabs.get(tabId);
    const view = runtime?.view;
    if (!agentHost || tab.id !== tabId || tab.isHome || tab.workspaceId === 'banking' || !view || runtime?.problem
      || runtime?.certificateError || runtime?.automaticFillPending || this.window.isFullScreen()
      || WORKSPACES.find(({ id }) => id === tab.workspaceId)?.protected) {
      throw new Error('Select a loaded, non-protected tab before lending it.');
    }
    const url = agentUrl(view.webContents.getURL());
    if (isKnownGoogleWebHost(url.href)) throw new Error('Google account and service pages cannot be lent.');
    this.fillCapabilities.invalidateTab(tabId);
    this.fillPicker.close();
    await agentHost.lendTab({
      tabId, view,
      current: () => !this.window.isDestroyed() && !this.window.isFullScreen()
        && this.activeTab(this.store.get()).id === tabId && this.runtimeTabs.get(tabId)?.view === view
        && !this.activeTab(this.store.get()).isHome,
    }, clientId);
  }

  focus(): void {
    if (!this.window || this.window.isDestroyed()) return;
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  async openSystemLink(url: string): Promise<void> {
    if (!isAllowedRemoteUrl(url) || this.store.isReadOnly() || this.window.isDestroyed()) return;
    this.focus();
    const state = this.store.get();
    const eligible = externalLinkAccounts(state);
    const accountId = preferredExternalLinkAccount(state, eligible) ?? await this.chooseSystemLinkAccount(url, eligible);
    if (!accountId || this.window.isDestroyed()) return;
    // The native prompt is asynchronous. The chosen account may have become unavailable.
    const account = externalLinkAccounts(this.store.get()).find((candidate) => candidate.id === accountId);
    if (account) await this.newTab(account.workspaceId, url, account.id);
  }

  private async chooseSystemLinkAccount(url: string, eligible: ReturnType<typeof externalLinkAccounts>): Promise<AccountSpaceId | undefined> {
    const pageSize = 4;
    for (let offset = 0; offset < eligible.length && !this.window.isDestroyed(); offset += pageSize) {
      const page = eligible.slice(offset, offset + pageSize);
      const buttons = page.map((account) => {
        const workspace = WORKSPACES.find((candidate) => candidate.id === account.workspaceId)!;
        return workspace.name + ' / ' + account.label + ' (' + (account.order + 1) + ')';
      });
      if (offset + pageSize < eligible.length) buttons.push('More spaces');
      const cancelId = buttons.push('Cancel') - 1;
      const { response } = await dialog.showMessageBox(this.window, {
        type: 'question',
        title: 'Open external link',
        message: 'Choose an Account Space',
        detail: 'Open a link to ' + new URL(url).host + '.',
        buttons,
        defaultId: cancelId,
        cancelId,
      });
      if (response === cancelId) return undefined;
      if (page[response]) return page[response].id;
    }
    return undefined;
  }

  setLayout(layout: Layout): void {
    const next = sanitizeContentInsets(layout);
    if (JSON.stringify(next) !== JSON.stringify(this.layout)) this.fillPicker.close();
    this.layout = next;
    this.applyLayout();
  }

  async navigate(value: string): Promise<void> {
    const state = this.store.get();
    const url = resolveWorkspaceNavigation(value, settingsForWorkspace(state, state.activeWorkspaceId), state.activeWorkspaceId === 'banking');
    const tab = this.activeTab(state);
    if (this.startupTabRecovery?.accountSpaceId === tab.accountSpaceId) {
      this.startupTabRecovery = undefined;
      this.startupRestoreJournal.clear();
    }
    const current = this.runtimeTabs.get(tab.id);
    if (current) Object.assign(current, { problem: undefined, failedUrl: undefined });
    if (url === 'private://home') {
      this.store.update((next) => {
        const target = next.tabs.find((candidate) => candidate.id === tab.id);
        if (target) Object.assign(target, { url, title: 'New tab', isHome: true, restorePaused: undefined });
      });
      const runtime = this.runtimeTabs.get(tab.id);
      // A page still loading would otherwise commit after this and take the tab
      // back from Home; `commitNavigation` also ignores it.
      runtime?.view?.webContents.stop();
      runtime?.view?.webContents.closeDevTools();
      runtime?.view?.setVisible(false);
      this.broadcast();
      return;
    }
    if (!isAllowedRemoteUrl(url)) throw new Error('Only HTTP and HTTPS pages are allowed');
    this.store.update((next) => {
      const target = next.tabs.find((candidate) => candidate.id === tab.id);
      if (target) Object.assign(target, { url, isHome: false, restorePaused: undefined });
    });
    const view = this.ensureView(tab.id);
    view.setVisible(true);
    this.applyLayout();
    await view.webContents.loadURL(url);
    this.broadcast();
  }

  addressMatches(accountSpaceId: AccountSpaceId, text: string): AddressMatch[] {
    return this.store.addressMatches(accountSpaceId, text);
  }

  retainedHistory(accountSpaceId: AccountSpaceId, input: HistoryQuery) {
    return this.store.retainedHistory(accountSpaceId, input);
  }

  async openAddressMatch(accountSpaceId: AccountSpaceId, source: AddressMatch['source'], id: string): Promise<void> {
    const url = this.store.addressMatchTarget(accountSpaceId, source, id);
    if (!url || !isAllowedRemoteUrl(url)) throw new Error('This address result is no longer available');
    if (source === 'tab') await this.activateTab(id);
    else await this.navigate(url);
  }

  /**
   * Adds a tab behind the current one without changing what the user sees: no
   * workspace, Account Space or tab switch. Its page loads when it is first shown.
   */
  private addBackgroundTab(workspaceId: WorkspaceId, url: string, accountSpaceId: AccountSpaceId, title?: string): string | undefined {
    const state = this.store.get();
    if (!isAllowedRemoteUrl(url) || !state.accountSpaces.some((account) => account.id === accountSpaceId && account.workspaceId === workspaceId)) return;
    const tab = this.backgroundTab(workspaceId, url, accountSpaceId, title);
    this.store.update((next) => { next.tabs.push(tab); });
    this.runtimeTabs.set(tab.id, this.newRuntimeTab());
    this.broadcast();
    return tab.id;
  }

  private backgroundTab(workspaceId: WorkspaceId, url: string, accountSpaceId: AccountSpaceId, title?: string): BrowserTab {
    return { id: randomUUID(), accountSpaceId, workspaceId, title: title || new URL(url).hostname, url,
      isHome: false, loading: false, canGoBack: false, canGoForward: false,
      developerToolsAllowed: false, developerToolsOpen: false };
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

  private canUseRoutines(state: RuntimeBrowserStateV2): boolean {
    const account = state.accountSpaces.find((candidate) => candidate.id === this.activeAccountSpaceId(state));
    return !this.store.isReadOnly() && Boolean(account && isAvailableRegularAccount(state, account));
  }

  private routines(state: RuntimeBrowserStateV2): BrowserRoutine[] {
    return state.routines ?? defaultBrowserRoutines(state.activeAccountSpaceByWorkspace);
  }

  async openReferenceSearch(input: ReferenceSearchInput): Promise<void> {
    const state = this.store.get();
    if (!this.canUseRoutines(state) || this.activeAccountSpaceId(state) !== input?.accountSpaceId) {
      throw new Error('Return to the original regular Account Space to open the reference.');
    }
    const url = referenceSearchUrl(settingsForWorkspace(state, state.activeWorkspaceId), input.keyword, input.reference);
    if (!url || url !== input.reviewedUrl) throw new Error('Review the current search address before opening it.');
    await this.newTab(state.activeWorkspaceId, url, input.accountSpaceId);
  }

  private updateRoutines(edit: (routines: BrowserRoutine[], state: RuntimeBrowserStateV2) => void): void {
    this.store.update((state) => {
      if (!this.canUseRoutines(state)) throw new Error('Routines are unavailable in this Account Space');
      edit(state.routines ??= this.routines(state), state);
    });
    this.broadcast();
  }

  saveRoutine(value: unknown): void {
    const routine = requireBrowserRoutine(value);
    this.updateRoutines((routines, state) => {
      if (routine.links.some(({ accountSpaceId }) => !state.accountSpaces.some((account) => account.id === accountSpaceId && account.workspaceId !== 'banking'))) {
        throw new Error('Choose a regular Account Space for each routine link');
      }
      const index = routines.findIndex((item) => item.id === routine.id);
      if (index >= 0) routines[index] = routine;
      else {
        if (routines.length >= MAX_ROUTINES) throw new Error('You can save up to 30 routines');
        routines.push(routine);
      }
    });
  }

  saveTabSet(input: TabSetInput): number {
    const state = this.store.get();
    if (!this.canUseRoutines(state) || this.activeAccountSpaceId(state) !== input.accountSpaceId) {
      throw new Error('Return to the original regular Account Space to save the tabs.');
    }
    const tabs = resolveTabSet(state.tabs, input);
    if (input.kind === 'routine') {
      this.saveRoutine({
        id: randomUUID(), name: input.name,
        links: tabs.map(({ url, accountSpaceId }) => ({ url, accountSpaceId })),
        focusIndex: Math.max(0, tabs.findIndex((tab) => tab.id === this.activeTab(state).id)),
        checklist: [],
      });
      return tabs.length;
    }
    const added = appendTabSetBookmarks(state.bookmarks, tabs, input);
    if (added.length) {
      this.store.update((next) => { next.bookmarks.push(...added); });
      this.broadcast();
    }
    return added.length;
  }

  deleteRoutine(id: string): void {
    this.updateRoutines((routines) => {
      const index = routines.findIndex((item) => item.id === id);
      if (index >= 0) routines.splice(index, 1);
    });
  }

  updateRoutineChecklist(id: string, index?: number, done?: boolean): void {
    this.updateRoutines((routines) => {
      const routine = routines.find((item) => item.id === id);
      if (!routine) throw new Error('Routine is unavailable');
      if (index === undefined) {
        for (const item of routine.checklist) item.done = false;
        return;
      }
      const item = routine.checklist[index];
      if (!item) throw new Error('Checklist item is unavailable');
      item.done = done === true;
      if (item.done) item.completedAt = new Date().toISOString();
    });
  }

  async runRoutine(id: string): Promise<RoutineRunResult> {
    const state = this.store.get();
    if (!this.canUseRoutines(state)) throw new Error('Routines are unavailable in this Account Space');
    const routine = this.routines(state).find((item) => item.id === id);
    if (!routine) throw new Error('Routine is unavailable');
    const result: RoutineRunResult = { reused: 0, opened: 0, skipped: [], focusUnavailable: false };
    const tabs = [...state.tabs];
    let focusId: string | undefined;
    for (const [index, { accountSpaceId, url }] of routine.links.entries()) {
      const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
      if (!account || !isAvailableRegularAccount(state, account)) {
        result.skipped.push(index);
        continue;
      }
      const owned = tabs.filter((tab) => tab.accountSpaceId === accountSpaceId);
      const match = owned.find((tab) => !tab.isHome && isAllowedRemoteUrl(tab.url) && canonicalRoutineUrl(tab.url) === canonicalRoutineUrl(url));
      if (match) {
        result.reused += 1;
        if (index === routine.focusIndex && !match.restorePaused && !this.runtimeTabs.get(match.id)?.problem
          && this.startupTabRecovery?.accountSpaceId !== accountSpaceId) focusId = match.id;
      } else if (owned.length >= 100) {
        result.skipped.push(index);
      } else {
        const tab = this.backgroundTab(account.workspaceId, url, accountSpaceId);
        tabs.push(tab);
        result.opened += 1;
        if (index === routine.focusIndex) focusId = tab.id;
      }
    }
    if (result.opened) this.store.update((next) => { next.tabs = tabs; });
    if (focusId) {
      try {
        await this.activateTab(focusId);
        result.focusUnavailable = Boolean(this.runtimeTabs.get(focusId)?.problem);
      } catch { result.focusUnavailable = true; }
    } else result.focusUnavailable = true;
    this.broadcast();
    return result;
  }

  async closeTab(tabId: string): Promise<void> {
    this.fillCapabilities.invalidateTab(tabId);
    if (this.fillPicker.context?.tabId === tabId) this.fillPicker.close();
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const accountTabs = state.tabs.filter((candidate) => candidate.accountSpaceId === tab.accountSpaceId);
    const closedIndex = accountTabs.findIndex((candidate) => candidate.id === tabId);
    const siblings = accountTabs.filter((candidate) => candidate.id !== tab.id);
    const nextId = siblings[Math.min(closedIndex, siblings.length - 1)]?.id;
    const wasActive = state.activeTabByAccountSpace[tab.accountSpaceId] === tabId;
    if (!tab.isHome && tab.workspaceId !== 'banking' && isAllowedRemoteUrl(tab.url)) {
      const closed = this.closedTabs.get(tab.accountSpaceId) ?? [];
      closed.push({ id: tab.id, title: tab.title, url: tab.url, closedAt: new Date().toISOString() });
      this.closedTabs.set(tab.accountSpaceId, closed.slice(-MAX_CLOSED_TABS));
    }
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
    // Menus and dialogs only cover the page: hide the views but keep docked
    // DevTools attached, unlike a tab or workspace switch.
    this.overlayOpen = open;
    if (open) {
      this.fillPicker.close();
      for (const runtime of this.runtimeTabs.values()) runtime.view?.setVisible(false);
      this.layoutSideApps();
    }
    else await this.showActiveTab();
  }

  setSideAppBounds(id: SideAppId, rect: SideAppRect | null): void {
    this.sideApps.setBounds(id, rect);
    this.layoutSideApps();
  }

  sideAppCommand(id: SideAppId, command: SideAppCommand): Promise<void> {
    if (this.store.get().activeWorkspaceId === 'banking') return Promise.reject(new Error('Side apps are unavailable in Banking'));
    return this.sideApps.command(id, command);
  }

  clearSideAppData(id: SideAppId): Promise<void> {
    return this.sideApps.clearData(id);
  }

  /**
   * A link out of a side app opens as a foreground tab in the active Account
   * Space. Banking never receives one: nothing outside it may open a page there.
   */
  private openFromSideApp(url: string): void {
    const state = this.store.get();
    const workspace = WORKSPACES.find((item) => item.id === state.activeWorkspaceId);
    if (!workspace || workspace.protected) {
      this.addPrivacyEvent('blocked', 'Link blocked in Banking', 'Side panel links cannot open in the Banking workspace');
      return;
    }
    if (!isAllowedRemoteUrl(url)) return;
    const accountSpaceId = state.activeAccountSpaceByWorkspace[state.activeWorkspaceId];
    void this.newTab(state.activeWorkspaceId, url, accountSpaceId).catch(() => undefined);
  }

  /** Side apps show only beside an unprotected workspace, never over a menu or in full screen. */
  private layoutSideApps(): void {
    if (!this.window || this.window.isDestroyed()) return;
    const state = this.store.get();
    const protectedWorkspace = WORKSPACES.find((item) => item.id === state.activeWorkspaceId)?.protected ?? true;
    const [contentWidth, contentHeight] = this.window.getContentSize();
    this.sideApps.layout({
      insets: this.layout,
      contentWidth,
      contentHeight,
      activeApp: state.ui.sidePanelOpen && isSideAppId(state.ui.sidePanelTool) ? state.ui.sidePanelTool : null,
      suppressed: this.overlayOpen || this.window.isFullScreen() || protectedWorkspace,
    });
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
    const url = resolveWorkspaceNavigation(value, settingsForWorkspace(this.store.get(), account.workspaceId), account.workspaceId === 'banking');
    if (url !== 'private://home' && !isAllowedRemoteUrl(url)) throw new Error('Only HTTP and HTTPS pages are allowed');
    await this.newTab(account.workspaceId, url, accountSpaceId);
  }

  async setAccountSpaceLocked(accountSpaceId: AccountSpaceId, locked: boolean): Promise<void> {
    const account = this.requireAccountMembership(accountSpaceId);
    if (locked) {
      // Move off the account first: the workspace would otherwise still point at
      // it and the next showActiveTab would rebuild its page (F-30).
      const state = this.store.get();
      if (state.activeAccountSpaceByWorkspace[account.workspaceId] === accountSpaceId) {
        const sibling = state.accountSpaces.find((candidate) => candidate.workspaceId === account.workspaceId
          && candidate.id !== accountSpaceId && !candidate.locked && state.recovery?.accountSpaceId !== candidate.id);
        if (!sibling) throw new Error('Unlock or add another Account Space in this workspace before locking this one');
        this.hideAllViews();
        this.store.update((next) => { next.activeAccountSpaceByWorkspace[account.workspaceId] = sibling.id; });
      }
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
    await this.showActiveTab();
  }

  configureGoogle(clientId: string): void {
    this.googleConfiguration.configure(clientId);
    this.broadcast();
  }

  clearGoogleConfiguration(): void {
    this.googleConfiguration.clear();
    this.broadcast();
  }

  async connectGoogleAccount(accountSpaceId: AccountSpaceId, modules: GoogleModule[], browserId: ExternalBrowserId) {
    this.requireAccountMembership(accountSpaceId);
    const previous = this.accounts.require(accountSpaceId).googleConnection;
    const connecting = this.accounts.update(accountSpaceId, (account) => { account.googleConnection = 'connecting'; });
    this.store.refreshAccount(connecting);
    this.broadcast();
    const result = await this.googleOAuth.connect(accountSpaceId, modules, browserId, () => this.store.get().accountSpaces.map((account) => account.id));
    if (!result.ok) {
      const status = result.error?.code === 'GOOGLE_CONFIGURATION_REQUIRED' ? 'not-configured'
        : result.error?.code === 'GOOGLE_SCOPE_MISSING' ? 'partial-scopes'
          : result.error?.code === 'GOOGLE_RECONNECT_REQUIRED' ? 'reconnect-required'
            : result.error?.code === 'GOOGLE_OFFLINE' ? 'offline'
              : 'disconnected';
      // A failed or cancelled reconnect leaves an existing grant as it was: the
      // stored token still works, so "disconnected" would be untrue (F-58).
      this.accounts.update(accountSpaceId, (account) => { account.googleConnection = status === 'disconnected' && account.refreshToken ? previous : status; });
    }
    this.store.refreshAccount(this.accounts.require(accountSpaceId));
    this.recordGoogleCheck(accountSpaceId, result);
    this.broadcast();
    return result;
  }

  getGoogleConnectionHealth(accountSpaceId: AccountSpaceId): GoogleConnectionHealth {
    const account = this.requireAccountMembership(accountSpaceId);
    if (account.locked || account.workspaceId === 'banking' || account.googleConnection === 'account-corrupt') return { state: 'unavailable' };
    const saved = this.store.recordFor(accountSpaceId);
    const recent = this.googleChecks.get(accountSpaceId);
    return {
      state: this.googleConfiguration.status().configured
        ? recent?.state ?? healthFromGoogleConnection(account.googleConnection) : 'disconnected',
      lastSuccessAt: recent?.lastSuccessAt ?? saved.lastGoogleSuccessAt,
      retryAt: recent?.retryAt,
    };
  }

  private recordGoogleCheck(accountSpaceId: AccountSpaceId, result: unknown): void {
    const recent = this.googleChecks.get(accountSpaceId);
    const now = Date.now();
    const visible = observeGoogleHealth(result, recent?.lastSuccessAt, now);
    if (!visible) return;
    try {
      const record = this.store.recordFor(accountSpaceId);
      if (record.locked || record.workspaceId === 'banking') return;
      this.googleChecks.set(accountSpaceId, visible);
      if (visible.state === 'ready' && (!record.lastGoogleSuccessAt || now - Date.parse(record.lastGoogleSuccessAt) >= 60_000)) {
        const saved = this.accounts.update(accountSpaceId, (account) => { account.lastGoogleSuccessAt = visible.lastSuccessAt; });
        this.store.refreshAccount(saved);
      }
    } catch {
      // Optional health metadata must not turn a successful user action into a failure.
    }
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
    if (result.ok) {
      this.addPrivacyEvent('vault', revoke ? 'Google access revoked' : 'Google API disconnected',
        revoke ? 'Google confirmed removal of the app grant' : 'The browser removed its saved Google tools connection');
    } else if (record.googleConnection === 'revocation-pending') {
      this.addPrivacyEvent('blocked', 'Google revocation pending', 'Retry when the network is available');
    } else {
      this.broadcast();
    }
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
      if (state.historyTrimmedByAccountSpace) delete state.historyTrimmedByAccountSpace[accountSpaceId];
      for (const tab of state.tabs.filter((candidate) => candidate.accountSpaceId === accountSpaceId)) {
        tab.title = 'New tab';
        tab.url = 'private://home';
        tab.isHome = true;
      }
    });
    this.store.refreshAccount(this.accounts.update(accountSpaceId, (record) => { record.websiteStatus = 'not-visited'; }));
    this.addPrivacyEvent('vault', 'Account Space data cleared', `${WORKSPACES.find((item) => item.id === account.workspaceId)?.name ?? 'An'} Account Space: website data and history were removed`);
    await this.showActiveTab();
  }

  private requireClearableAccount(accountSpaceId: AccountSpaceId) {
    const account = this.requireAccountMembership(accountSpaceId);
    if (this.store.isReadOnly() || account.locked) throw new Error('Unlock this Account Space to manage its browsing data.');
    return account;
  }

  reviewBrowsingData(value: BrowsingDataInput): BrowsingDataReview {
    const input = requireBrowsingDataInput(value);
    this.requireClearableAccount(input.accountSpaceId);
    const state = this.store.get();
    const now = Date.now();
    const visits = browsingDataVisitIds(state.history, input, now);
    const review: BrowsingDataReview = { id: randomUUID(), accountSpaceId: input.accountSpaceId, historyCount: visits.size,
      siteOrigin: input.siteOrigin, range: input.range, websiteData: input.websiteData, cache: input.cache };
    this.browsingDataReview = { review, visits, initiator: this.activeAccountSpaceId(state), expiresAt: now + 120_000 };
    return review;
  }

  private removeHistoryVisits(accountId: AccountSpaceId, visits: Set<string>): number {
    let removed = 0;
    this.store.update((state) => {
      state.history = state.history.filter((entry) => {
        if (entry.accountSpaceId !== accountId || !visits.has(entry.id)) return true;
        removed += 1;
        return false;
      });
    });
    return removed;
  }

  deleteHistoryVisit(accountId: AccountSpaceId, id: string): void {
    this.requireClearableAccount(accountId);
    if (this.activeAccountSpaceId(this.store.get()) !== accountId) throw new Error('Return to the Account Space that owns this visit.');
    this.removeHistoryVisits(accountId, new Set([id]));
    this.broadcast();
  }

  async deleteReviewedBrowsingData(id: string): Promise<number> {
    const pending = this.browsingDataReview;
    if (!pending || pending.review.id !== id || pending.expiresAt <= Date.now()
      || pending.initiator !== this.activeAccountSpaceId(this.store.get())) throw new Error('Review the browsing data again before deleting.');
    this.browsingDataReview = undefined;
    const { review, visits } = pending;
    const account = this.requireClearableAccount(review.accountSpaceId);
    const dataTypes: NonNullable<Electron.ClearDataOptions['dataTypes']> = [];
    if (review.websiteData) dataTypes.push('cookies', 'localStorage', 'indexedDB', 'fileSystems', 'serviceWorkers', 'backgroundFetch', 'webSQL');
    if (review.cache) dataTypes.push('cache');
    if (dataTypes.length) {
      const storage = session.fromPartition(this.store.partitionFor(account.id));
      if (review.websiteData) {
        const site = review.siteOrigin ? new URL(review.siteOrigin).hostname : undefined;
        const cookieDomain = (host: string) => getDomain(host, { allowPrivateDomains: true }) ?? host;
        const cookieSite = site && cookieDomain(site);
        this.fillPicker.close();
        for (const tab of this.store.get().tabs.filter((candidate) => candidate.accountSpaceId === account.id)) {
          const runtime = this.runtimeTabs.get(tab.id);
          if (!runtime?.view) continue;
          const host = new URL(tab.url).hostname;
          if (cookieSite && cookieDomain(host) !== cookieSite) continue;
          this.window.contentView.removeChildView(runtime.view);
          runtime.view.webContents.close();
          this.runtimeTabs.delete(tab.id);
        }
      }
      try {
        await storage.clearData({ dataTypes, originMatchingMode: 'origin-in-all-contexts',
          ...(review.siteOrigin ? { origins: [review.siteOrigin] } : {}) });
        if (review.websiteData && !review.siteOrigin) await storage.clearAuthCache();
      } finally {
        if (!this.overlayOpen) await this.showActiveTab();
      }
      if (review.websiteData && (!review.siteOrigin || /(^|\.)google\.com$/.test(new URL(review.siteOrigin).hostname))) {
        this.store.refreshAccount(this.accounts.update(account.id, (record) => { record.websiteStatus = 'not-visited'; }));
      }
    }
    const removed = visits.size ? this.removeHistoryVisits(account.id, visits) : 0;
    this.addPrivacyEvent('vault', 'Browsing data deleted', 'Reviewed browsing data was removed from one Account Space');
    return removed;
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
    this.downloadHistory.forgetAccount(accountSpaceId);
    this.downloadHistoryFailures.delete(accountSpaceId);
    this.store.removeAccount(accountSpaceId);
    for (const [id, entry] of this.downloads) {
      if (entry.accountSpaceId === accountSpaceId) this.downloads.delete(id);
    }
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

  private activePermissionSite(tabId: string, origin: string) {
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (tab.id !== tabId || tab.isHome || !isAllowedRemoteUrl(tab.url) || safeOrigin(tab.url) !== origin) {
      throw new Error('The page changed. Open site information again.');
    }
    return tab;
  }

  getSitePermissions(tabId: string, origin: string) {
    const tab = this.activePermissionSite(tabId, origin);
    return this.permissions.siteStatus(tab.accountSpaceId, tab.workspaceId, origin);
  }

  revokeSitePermission(tabId: string, origin: string, capability: PermissionCapability) {
    const tab = this.activePermissionSite(tabId, origin);
    if (this.store.isReadOnly() || tab.workspaceId === 'banking') throw new Error('Permission changes are unavailable in this Account Space.');
    this.permissions.revoke(tab.accountSpaceId, tab.workspaceId, origin, capability);
    return this.permissions.siteStatus(tab.accountSpaceId, tab.workspaceId, origin);
  }

  listAccountPermissionGrants(accountSpaceId: AccountSpaceId) {
    const account = this.requireAccountMembership(accountSpaceId);
    return account.locked || account.workspaceId === 'banking' ? [] : this.permissions.listGrants(accountSpaceId);
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
      const restored = restorableItems(await this.backups.restore(accountSpaceId, recoveryCode, signal), { accountSpaceId, workspaceId: account.workspaceId });
      this.closeAccountViews(accountSpaceId);
      this.store.update((state) => {
        state.bookmarks = [...state.bookmarks.filter((item) => item.accountSpaceId !== accountSpaceId), ...restored.bookmarks];
        if (restored.history) state.history = [...state.history.filter((item) => item.accountSpaceId !== accountSpaceId), ...restored.history];
        if (restored.openTabs?.length) {
          state.tabs = [...state.tabs.filter((item) => item.accountSpaceId !== accountSpaceId), ...restored.openTabs.map((tab) => ({ ...tab, loading: false, canGoBack: false, canGoForward: false, developerToolsAllowed: false, developerToolsOpen: false }))];
          state.activeTabByAccountSpace[accountSpaceId] = restored.openTabs[0]!.id;
        }
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
      if (!operation.signal.aborted) this.recordGoogleCheck(accountSpaceId, result);
      const failed = result !== null && typeof result === 'object' && 'ok' in result && result.ok === false;
      this.sendOperationProgress(operationId, accountSpaceId, service, operation.signal.aborted ? 'cancelled' : failed ? 'failed' : 'completed');
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
    this.fillPicker.close();
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
    this.closedTabs.delete(accountSpaceId);
    this.closedTabBatches.delete(accountSpaceId);
    this.bookmarkUndo.delete(accountSpaceId);
  }

  private cancelAccountOperations(accountSpaceId: AccountSpaceId): void {
    if (this.pendingChromePasswords?.accountId === accountSpaceId) this.pendingChromePasswords = undefined;
    if (this.pendingChromeImport?.accountSpaceId === accountSpaceId || this.pendingChromeImport?.initiatingAccount === accountSpaceId) {
      this.pendingChromeImport = undefined;
    }
    this.chromeImportUndo.delete(accountSpaceId);
    this.pendingAiPreviews.clear();
    this.aiApprovals.clear();
    this.assistantReview = undefined;
    this.activeAssistant?.controller.abort();
    this.permissions.clearAccount(accountSpaceId);
    this.googleOAuth.clearMemory(accountSpaceId);
    this.googleServices.clearAccount(accountSpaceId);
    this.googleChecks.delete(accountSpaceId);
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

  async reload(): Promise<void> {
    const tab = this.activeTab(this.store.get());
    const runtime = this.runtimeTabs.get(tab.id);
    if (runtime?.problem || tab.restorePaused) {
      try {
        await this.navigate(runtime?.failedUrl ?? tab.url);
      } catch (error) {
        if (!runtime?.problem && !this.runtimeTabs.get(tab.id)?.problem) throw error;
      }
      return;
    }
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
    const favicon = this.runtimeTabs.get(tab.id)?.favicon;
    if (favicon) this.rememberBookmarkIcon(tab.id, favicon);
    this.broadcast();
  }

  async openBookmark(id: string): Promise<void> {
    const bookmark = this.store.get().bookmarks.find((item) => item.id === id);
    if (!bookmark) return;
    await this.newTab(bookmark.workspaceId, bookmark.url, bookmark.accountSpaceId);
  }

  openBookmarksInBackground(accountSpaceId: AccountSpaceId, ids: string[]) {
    const state = this.store.get();
    const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
    if (this.store.isReadOnly() || this.activeAccountSpaceId(state) !== accountSpaceId || !account
      || account.locked || state.accountHealth.some((entry) => entry.accountSpaceId === accountSpaceId && entry.status === 'account-corrupt')) {
      throw new Error('The Account Space changed. Reopen the bookmark preview.');
    }
    const { pending, reused, skipped } = planBookmarkBatch(
      state.bookmarks.filter((item) => item.accountSpaceId === accountSpaceId),
      state.tabs.filter((tab) => tab.accountSpaceId === accountSpaceId),
      ids,
    );
    const tabs = pending.map(({ bookmark }) => this.backgroundTab(account.workspaceId, bookmark.url, accountSpaceId, bookmark.title));
    if (tabs.length) {
      this.store.update((next) => { next.tabs.push(...tabs); });
      this.broadcast();
    }
    return { opened: tabs.length, reused, skipped };
  }

  toggleBookmarkBar(): void {
    this.store.update((state) => { state.ui = mergeUiPreferences(state.ui, { bookmarkBarMode: state.ui.bookmarkBarMode === 'hidden' ? 'always' : 'hidden' }); });
    this.broadcast();
  }

  /** Home button and Alt+Home. Banking always gets the New Tab page, whatever the setting says. */
  async goHome(): Promise<void> {
    const state = this.store.get();
    const workspace = WORKSPACES.find((item) => item.id === this.activeTab(state).workspaceId);
    await this.navigate(resolveHomeUrl(settingsForWorkspace(state, state.activeWorkspaceId), Boolean(workspace?.protected)));
  }

  /**
   * Runs once per launch when "On startup" is "Also open Home page". It only adds
   * a tab: restored tabs are never closed. A failure is logged, never fatal.
   */
  async openStartupHome(): Promise<void> {
    const state = this.store.get();
    if (state.recovery || this.startupTabRecovery || state.activeWorkspaceId === 'banking') return;
    const settings = settingsForWorkspace(state, state.activeWorkspaceId);
    if (settings.startup === 'pages' && settings.startupPages?.length) {
      const account = state.accountSpaces.find((candidate) => candidate.id === this.activeAccountSpaceId(state));
      if (!account || !isAvailableRegularAccount(state, account)) return;
      const seen = new Set(state.tabs.filter((tab) => tab.accountSpaceId === account.id && !tab.isHome && isAllowedRemoteUrl(tab.url))
        .map((tab) => canonicalRoutineUrl(tab.url)));
      const tabs: BrowserTab[] = [];
      for (const url of settings.startupPages) {
        const address = canonicalRoutineUrl(url);
        if (seen.has(address)) continue;
        seen.add(address);
        tabs.push(this.backgroundTab(account.workspaceId, address, account.id));
      }
      if (tabs.length) {
        this.store.update((next) => { next.tabs.push(...tabs); });
        this.broadcast();
      }
      return;
    }
    if (settings.startup !== 'home') return;
    try {
      await this.newTab(state.activeWorkspaceId);
      await this.goHome();
    } catch {
      this.addPrivacyEvent('blocked', 'Home page could not open at startup', 'The browser started with the restored tabs');
    }
  }

  setBrowserSettings(patch: BrowserSettingsPatch, workspaceId?: WorkspaceId): void {
    const workspace = this.store.get().activeWorkspaceId;
    if (workspaceId && workspaceId !== workspace) throw new Error('The workspace changed. Reopen its settings.');
    if (patch.assistantPrompts && !workspaceVaultPolicy(workspace).aiExtraction) {
      throw new Error('Assistant presets are unavailable in this workspace.');
    }
    if (workspace === 'banking' && (patch.homePage !== undefined || patch.homePageUrl !== undefined
      || patch.startup !== undefined || patch.startupPages !== undefined || patch.siteKeywords !== undefined)) {
      throw new Error('Home, startup pages and site keywords are unavailable in Banking.');
    }
    const next = { ...patch };
    if (next.spellcheck && next.spellcheck.languages.some((language) => !this.availableSpellcheckLanguages().includes(language))) {
      throw new Error('A selected spellcheck dictionary is unavailable on this device.');
    }
    if (next.homePageUrl !== undefined) {
      const url = parseWebAddress(next.homePageUrl);
      if (!url || !isAllowedRemoteUrl(url)) throw new Error('Enter a web address, for example tenten.ma');
      next.homePageUrl = url;
    }
    this.store.update((state) => {
      const settings = state.workspaceSettings ??= {};
      settings[workspace] = mergeBrowserSettings(settingsForWorkspace(state, workspace), next);
    });
    if (next.spellcheck) {
      for (const account of this.store.get().accountSpaces) {
        if (account.workspaceId !== workspace) continue;
        const partition = this.store.partitionFor(account.id);
        if (this.configuredSessions.has(partition)) this.applySpellcheck(session.fromPartition(partition), next.spellcheck);
      }
    }
    this.broadcast();
  }

  private availableSpellcheckLanguages(): SpellcheckLanguage[] {
    if (this.spellingLanguages) return this.spellingLanguages;
    const dictionaries = session.defaultSession.availableSpellCheckerLanguages;
    return this.spellingLanguages ??= (Object.keys(SPELLCHECK_LANGUAGES) as SpellcheckLanguage[])
      .filter((language) => Boolean(spellingDictionary(dictionaries, language)));
  }

  private applySpellcheck(ses: Session, spelling: SpellcheckSettings): void {
    ses.setSpellCheckerEnabled(spelling.enabled);
    if (!spelling.enabled || process.platform === 'darwin') return;
    const dictionaries = ses.availableSpellCheckerLanguages;
    const chosen = spelling.languages.length ? spelling.languages : app.getPreferredSystemLanguages();
    const matching = chosen.flatMap((language) => spellingDictionary(dictionaries, language) ?? []);
    ses.setSpellCheckerLanguages([...new Set(matching)]);
  }

  setUiPreferences(patch: UiPreferencesPatch): void {
    const before = this.store.get().ui;
    const next = this.store.update((state) => { state.ui = mergeUiPreferences(state.ui, patch); });
    if (next.ui.theme !== before.theme) {
      nativeTheme.themeSource = next.ui.theme;
      this.applyFrameColors();
    }
    // Hide the previous tool before the renderer can report the next slot.
    this.layoutSideApps();
    this.broadcast();
  }

  /**
   * A still image of the active page, so trusted menus can draw over the
   * content area while the live view is hidden. Protected workspaces and
   * protected pages (banking, payment, identity) never leave pixels in the
   * chrome renderer: they fail closed to a neutral backdrop.
   */
  async freezeContent(): Promise<string | null> {
    const tab = this.activeTab(this.store.get());
    const view = this.runtimeTabs.get(tab.id)?.view;
    const workspace = WORKSPACES.find((item) => item.id === tab.workspaceId);
    if (tab.isHome || !view || !view.getVisible() || workspace?.protected || isProtectedPage(tab.url)) return null;
    // The stored URL changes before a navigation commits, so also judge what the
    // view is actually painting, and refuse while a main-frame load is in flight.
    const painted = () => view.webContents.getURL();
    if (view.webContents.isLoadingMainFrame() || isProtectedPage(painted())) return null;
    const before = painted();
    try {
      const image = await view.webContents.capturePage();
      if (image.isEmpty() || painted() !== before || isProtectedPage(painted())) return null;
      return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`;
    } catch {
      return null;
    }
  }

  moveTab(tabId: string, toIndex: number): void {
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.accountSpaceId !== this.activeAccountSpaceId(state)) throw new Error('Only tabs in the active Account Space can be moved');
    const owned = state.tabs.filter((candidate) => candidate.accountSpaceId === tab.accountSpaceId);
    const index = keepTabBlockIndex(owned, tab, toIndex);
    this.store.update((next) => {
      const reordered = moveTabWithinAccountSpace(next.tabs, tabId, index);
      next.tabs = replaceAccountTabOrder(reordered, tab.accountSpaceId, orderAccountTabs(reordered.filter((candidate) => candidate.accountSpaceId === tab.accountSpaceId)));
    });
    this.broadcast();
  }

  organizeTab(action: TabOrganizationAction): void {
    this.store.update((state) => {
      const accountSpaceId = this.activeAccountSpaceId(state);
      if (state.accountSpaces.find((account) => account.id === accountSpaceId)?.locked || state.recovery?.accountSpaceId === accountSpaceId) throw new Error('Account Space is unavailable');
      const bySpace = state.tabGroupsByAccountSpace ??= {};
      const result = organizeTabs(state.tabs.filter((tab) => tab.accountSpaceId === accountSpaceId), bySpace[accountSpaceId] ?? [], action, randomUUID());
      bySpace[accountSpaceId] = result.groups;
      state.tabs = replaceAccountTabOrder(state.tabs, accountSpaceId, result.tabs);
    });
    this.broadcast();
  }

  async duplicateTab(id: string): Promise<void> {
    const state = this.store.get();
    const accountSpaceId = this.activeAccountSpaceId(state);
    const tab = state.tabs.find((candidate) => candidate.id === id && candidate.accountSpaceId === accountSpaceId);
    const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
    if (!tab || !account || account.locked || state.accountHealth.some((health) => health.accountSpaceId === accountSpaceId && health.status === 'account-corrupt')) {
      throw new Error('Tab is unavailable in this Account Space');
    }
    await this.newTab(tab.workspaceId, tab.url, tab.accountSpaceId);
  }

  async closeTabBatch(id: string, scope: TabBatchScope, confirmedIds: string[]): Promise<void> {
    const state = this.store.get();
    const accountSpaceId = this.activeAccountSpaceId(state);
    const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
    if (!account || !isAvailableRegularAccount(state, account)) throw new Error('Bulk tab closing is unavailable in this Account Space');
    const owned = state.tabs.filter((tab) => tab.accountSpaceId === accountSpaceId);
    const batch = tabBatchTargets(owned, id, scope);
    if (!batch.length || batch.length !== confirmedIds.length || batch.some((tab, index) => tab.id !== confirmedIds[index])) {
      throw new Error('The tabs changed. Open the tab menu and review the selection again.');
    }
    const ids = new Set(confirmedIds);
    const groups = state.tabGroupsByAccountSpace?.[accountSpaceId]?.filter((group) => batch.some((tab) => tab.groupId === group.id)) ?? [];
    const active = state.activeTabByAccountSpace[accountSpaceId];
    this.store.update((next) => {
      next.tabs = next.tabs.filter((tab) => !ids.has(tab.id));
      if (ids.has(active) && !ids.has(id)) next.activeTabByAccountSpace[accountSpaceId] = id;
    });
    this.closedTabBatches.set(accountSpaceId, {
      entries: batch.map((tab) => ({ tab, index: owned.indexOf(tab) })),
      groups,
      groupName: scope === 'group' ? groups[0]?.name : undefined,
    });
    for (const tab of batch) {
      if (this.fillPicker.context?.tabId === tab.id) this.fillPicker.close();
      this.fillCapabilities.invalidateTab(tab.id);
      const runtime = this.runtimeTabs.get(tab.id);
      this.runtimeTabs.delete(tab.id);
      if (runtime?.view) {
        this.window.contentView.removeChildView(runtime.view);
        runtime.view.webContents.close();
      }
    }
    await this.showActiveTab();
  }

  undoTabBatch(): void {
    const state = this.store.get();
    const accountSpaceId = this.activeAccountSpaceId(state);
    const batch = this.closedTabBatches.get(accountSpaceId);
    const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
    if (!batch || !account || !isAvailableRegularAccount(state, account)) return;
    this.store.update((next) => {
      const bySpace = next.tabGroupsByAccountSpace ??= {};
      const groups = bySpace[accountSpaceId] ??= [];
      for (const group of batch.groups) if (!groups.some((candidate) => candidate.id === group.id)) groups.push(group);
      const tabs = next.tabs.filter((tab) => tab.accountSpaceId === accountSpaceId);
      for (const { tab, index } of batch.entries) {
        if (tabs.some((candidate) => candidate.id === tab.id)) continue;
        tabs.splice(index, 0, tab);
        next.tabs.push(tab);
      }
      next.tabs = replaceAccountTabOrder(next.tabs, accountSpaceId, orderAccountTabs(tabs));
    });
    this.closedTabBatches.delete(accountSpaceId);
    this.broadcast();
  }

  async reopenClosedTab(closedId?: string): Promise<void> {
    const state = this.store.get();
    const accountSpaceId = this.activeAccountSpaceId(state);
    const closed = this.closedTabs.get(accountSpaceId);
    const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
    if (!closed?.length || !account || !isAvailableRegularAccount(state, account)) return;
    const index = closedId === undefined ? closed.length - 1 : closed.findIndex((entry) => entry.id === closedId);
    const entry = closed[index];
    if (!entry) return;
    const restored = this.addBackgroundTab(account.workspaceId, entry.url, accountSpaceId, entry.title);
    if (!restored) return;
    closed.splice(index, 1);
    if (closedId === undefined) await this.activateTab(restored);
    else this.broadcast();
  }

  zoom(direction: 'in' | 'out' | 'reset'): void {
    const contents = this.activeContents();
    // A New Tab page keeps the previous page's view hidden underneath; never zoom that.
    if (!contents || this.activeTab(this.store.get()).isHome) return;
    this.stepZoom(contents, direction);
  }

  private stepZoom(contents: Electron.WebContents, direction: 'in' | 'out' | 'reset'): void {
    const current = Math.round(contents.getZoomFactor() * 100);
    contents.setZoomFactor(nextZoomPercent(current, direction) / 100);
    this.broadcast();
  }

  print(): void {
    const contents = this.activeContents();
    if (contents && !this.activeTab(this.store.get()).isHome) contents.print({}, () => undefined);
  }

  findInPage(text: string, forward: boolean, findNext: boolean): void {
    const contents = this.activeContents();
    if (!contents || !text) return;
    contents.findInPage(text, { forward, findNext });
  }

  stopFindInPage(): void {
    this.activeContents()?.stopFindInPage('clearSelection');
  }

  setTabMuted(tabId: string, muted: boolean): void {
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.accountSpaceId !== this.activeAccountSpaceId(state)) throw new Error('Tab is not in the active Account Space');
    this.runtimeTabs.get(tabId)?.view?.webContents.setAudioMuted(muted);
    this.broadcast();
  }

  hardReload(): void {
    this.activeContents()?.reloadIgnoringCache();
  }

  toggleFullscreen(): void {
    if (this.window.isDestroyed()) return;
    this.window.setFullScreen(!this.window.isFullScreen());
  }

  private activeBookmarkScope() {
    const state = this.store.get();
    return { state, accountSpaceId: this.activeAccountSpaceId(state) };
  }

  private requireActiveBookmark(id: string) {
    const { state, accountSpaceId } = this.activeBookmarkScope();
    const bookmark = state.bookmarks.find((item) => item.id === id);
    if (!bookmark || bookmark.accountSpaceId !== accountSpaceId) throw new Error('Bookmark belongs to another Account Space');
    return bookmark;
  }

  moveBookmark(level: BookmarkLevelInput, key: BookmarkEntryKeyInput, toIndex: number): void {
    const { accountSpaceId } = this.activeBookmarkScope();
    if (key.kind === 'bookmark') this.requireActiveBookmark(key.id);
    this.store.update((state) => { state.bookmarks = reorderBookmarkEntry(state.bookmarks, accountSpaceId, level, key, toIndex); });
    this.broadcast();
  }

  renameBookmark(id: string, title: string): void {
    this.requireActiveBookmark(id);
    this.store.update((state) => { state.bookmarks = renameBookmark(state.bookmarks, id, title); });
    this.broadcast();
  }

  removeBookmark(id: string): void {
    this.requireActiveBookmark(id);
    this.store.update((state) => { state.bookmarks = removeBookmark(state.bookmarks, id); });
    this.broadcast();
  }

  updateBookmarkAddress(id: string, url: string): void {
    this.requireEditableBookmarkAccount(this.requireActiveBookmark(id).accountSpaceId);
    this.store.update((state) => { state.bookmarks = editBookmarkAddress(state.bookmarks, id, url); });
    this.broadcast();
  }

  changeBookmarks(accountSpaceId: AccountSpaceId, ids: string[], destination?: BookmarkLevelInput): number {
    this.requireEditableBookmarkAccount(accountSpaceId);
    const plan = changeBookmarkBatch(this.store.get().bookmarks, accountSpaceId, ids, destination);
    if (!plan.undo) return 0;
    this.store.update((state) => { state.bookmarks = plan.bookmarks; });
    this.bookmarkUndo.set(accountSpaceId, plan.undo);
    this.broadcast();
    return plan.undo.before.length;
  }

  undoBookmarks(accountSpaceId: AccountSpaceId): number {
    this.requireEditableBookmarkAccount(accountSpaceId);
    const undo = this.bookmarkUndo.get(accountSpaceId);
    if (!undo) return 0;
    const result = restoreBookmarkBatch(this.store.get().bookmarks, accountSpaceId, undo);
    if (result.restored) this.store.update((state) => { state.bookmarks = result.bookmarks; });
    this.bookmarkUndo.delete(accountSpaceId);
    this.broadcast();
    return result.restored;
  }

  private requireEditableBookmarkAccount(accountSpaceId: AccountSpaceId): void {
    const { state, accountSpaceId: active } = this.activeBookmarkScope();
    if (active !== accountSpaceId) throw new Error('The Account Space changed. Return to the original space.');
    const account = this.requireAccountMembership(accountSpaceId);
    if (account.locked || state.accountHealth.some((item) => item.accountSpaceId === active && item.status === 'account-corrupt')) {
      throw new Error('This Account Space is unavailable for bookmark changes.');
    }
  }

  renameBookmarkFolder(level: BookmarkLevelInput, name: string, nextName: string): void {
    const { accountSpaceId } = this.activeBookmarkScope();
    this.store.update((state) => { state.bookmarks = renameBookmarkFolder(state.bookmarks, accountSpaceId, level, name, nextName); });
    this.broadcast();
  }

  removeBookmarkFolder(level: BookmarkLevelInput, name: string): void {
    const { accountSpaceId } = this.activeBookmarkScope();
    this.store.update((state) => { state.bookmarks = removeBookmarkFolder(state.bookmarks, accountSpaceId, level, name); });
    this.broadcast();
  }

  async exportBookmarks(): Promise<boolean> {
    const { state, accountSpaceId } = this.activeBookmarkScope();
    const account = state.accountSpaces.find((item) => item.id === accountSpaceId);
    const bookmarks = state.bookmarks.filter((item) => item.accountSpaceId === accountSpaceId);
    const safeLabel = (account?.label ?? 'bookmarks').replace(/[^\w .-]+/g, '').trim().slice(0, 60) || 'bookmarks';
    const result = await dialog.showSaveDialog(this.window, {
      title: 'Export bookmarks',
      defaultPath: `Private Browser bookmarks - ${safeLabel}.html`,
      filters: [{ name: 'Bookmark file', extensions: ['html'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, exportBookmarksHtml(bookmarks), { encoding: 'utf8' });
    this.addPrivacyEvent('local-read', 'Bookmarks exported', `${bookmarks.length} bookmarks from the active Account Space saved to a local file`);
    return true;
  }

  async importBookmarkHtml(accountSpaceId: AccountSpaceId): Promise<{ imported: number; skipped: number } | undefined> {
    const validateDestination = () => {
      this.requireEditableBookmarkAccount(accountSpaceId);
      const account = this.requireAccountMembership(accountSpaceId);
      if (this.store.isReadOnly() || account.workspaceId === 'banking') throw new Error('Choose an unlocked regular Account Space.');
      return account;
    };
    const account = validateDestination();
    const choice = await dialog.showOpenDialog(this.window, {
      title: 'Import browser bookmarks',
      properties: ['openFile'],
      filters: [{ name: 'Bookmark HTML files', extensions: ['html', 'htm'] }],
    });
    if (choice.canceled || !choice.filePaths[0]) return undefined;
    validateDestination();
    const batch = await readBookmarkHtml(choice.filePaths[0], { workspaceId: account.workspaceId, accountSpaceId });
    validateDestination();
    let imported = 0;
    if (batch.bookmarks.length) {
      this.store.update((state) => { imported = appendImportedBookmarks(state.bookmarks, batch.bookmarks); });
      this.broadcast();
    }
    return { imported, skipped: batch.skipped + batch.bookmarks.length - imported };
  }

  setShortcutTiles(accountSpaceId: AccountSpaceId, tiles: ShortcutTile[] | null): void {
    this.requireAccountMembership(accountSpaceId);
    const sanitized = tiles === null ? undefined : sanitizeShortcutTiles(tiles);
    if (tiles !== null && sanitized?.length !== tiles.length) throw new Error('Shortcuts must be HTTP or HTTPS pages');
    this.store.update((state) => {
      if (sanitized) state.shortcutsByAccountSpace[accountSpaceId] = sanitized;
      else delete state.shortcutsByAccountSpace[accountSpaceId];
    });
    this.broadcast();
  }

  listChromeProfiles(): ChromeProfileSource[] {
    return listChromeProfiles();
  }

  private requireChromeDestination(id: AccountSpaceId, workspaceId?: WorkspaceId) {
    const account = this.requireAccountMembership(id);
    if (this.store.isReadOnly() || !isAvailableRegularAccount(this.store.get(), account) || (workspaceId && workspaceId !== account.workspaceId)) {
      throw new Error('Choose an unlocked Account Space in the current regular workspace.');
    }
    return account;
  }

  previewChromeImport(options: ChromeImportOptions): ChromeImportReview {
    const { accountSpaceId } = options;
    this.requireChromeDestination(accountSpaceId, options.workspaceId);
    if (!options.bookmarks && !options.history) throw new Error('Choose bookmarks, history or both.');
    this.pendingChromeImport = undefined;
    const source = readChromeProfile(options.profileId, options.workspaceId, accountSpaceId, options.bookmarks, options.history);
    const state = this.store.get();
    const plan = planChromeImport(state, source);
    const id = randomUUID();
    const expiresIn = 5 * 60_000;
    this.pendingChromeImport = {
      id, accountSpaceId, initiatingAccount: this.activeAccountSpaceId(state), source, importKey: chromeImportKey(plan), expiresAt: Date.now() + expiresIn,
    };
    setTimeout(() => this.discardChromeImport(id), expiresIn).unref();
    return { id, accountSpaceId, ...plan.summary };
  }

  discardChromeImport(id: string): void {
    if (this.pendingChromeImport?.id === id) this.pendingChromeImport = undefined;
  }

  confirmChromeImport(id: string): ChromeImportResult {
    const review = this.pendingChromeImport;
    if (!review || review.id !== id) throw new Error('Preview this Chrome import again.');
    this.pendingChromeImport = undefined;
    if (review.expiresAt <= Date.now() || review.initiatingAccount !== this.activeAccountSpaceId(this.store.get())) {
      throw new Error('The import preview expired. Preview this Chrome import again.');
    }
    this.requireChromeDestination(review.accountSpaceId);
    const plan = planChromeImport(this.store.get(), review.source);
    if (chromeImportKey(plan) !== review.importKey) throw new Error('Browsing data changed. Preview this Chrome import again.');
    return this.applyChromeImport(review.accountSpaceId, plan);
  }

  importChrome(options: ChromeImportOptions): ChromeImportResult {
    this.requireChromeDestination(options.accountSpaceId, options.workspaceId);
    return this.applyChromeImport(options.accountSpaceId, planChromeImport(this.store.get(),
      readChromeProfile(options.profileId, options.workspaceId, options.accountSpaceId, options.bookmarks, options.history)));
  }

  private applyChromeImport(id: AccountSpaceId, plan: ReturnType<typeof planChromeImport>): ChromeImportResult {
    if (plan.bookmarks.length || plan.history.length) {
      this.store.update((state) => {
        state.bookmarks.push(...plan.bookmarks);
        state.history.push(...plan.history);
        state.history.sort((left, right) => right.visitedAt.localeCompare(left.visitedAt));
        state.privacyLog.unshift({
          id: randomUUID(), at: new Date().toISOString(), kind: 'local-read', title: 'Chrome data imported',
          detail: `${plan.bookmarks.length} bookmarks and ${plan.history.length} history entries imported locally`,
          accountSpaceId: id, service: 'browser',
        });
        state.privacyLog = state.privacyLog.slice(0, 100);
      });
      this.chromeImportUndo.set(id, {
        bookmarks: new Map(plan.bookmarks.map((item) => [item.id, chromeImportBookmarkStamp(item)])),
        history: new Set(plan.history.map((item) => item.id)),
      });
      this.broadcast();
    }
    return plan.summary.result;
  }

  canUndoChromeImport(id: AccountSpaceId): boolean {
    this.requireChromeDestination(id);
    return this.chromeImportUndo.has(id);
  }

  undoChromeImport(id: AccountSpaceId): { bookmarks: number; history: number } {
    this.requireChromeDestination(id);
    const undo = this.chromeImportUndo.get(id);
    const removed = { bookmarks: 0, history: 0 };
    if (!undo) return removed;
    this.store.update((state) => {
      state.bookmarks = state.bookmarks.filter((entry) => {
        const stamp = entry.accountSpaceId === id ? undo.bookmarks.get(entry.id) : undefined;
        if (!stamp || stamp !== chromeImportBookmarkStamp(entry)) return true;
        removed.bookmarks += 1;
        return false;
      });
      state.history = state.history.filter((entry) => {
        if (entry.accountSpaceId !== id || !undo.history.has(entry.id)) return true;
        removed.history += 1;
        return false;
      });
    });
    this.chromeImportUndo.delete(id);
    this.broadcast();
    return removed;
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
    this.developerPreviewIds.add(preview.id);
    if (this.developerPreviewIds.size > 50) this.developerPreviewIds.delete(this.developerPreviewIds.values().next().value!);
    return preview;
  }

  // ---- AI Development Control Center (docs/systems/control-center-link.md) ----
  // The browser is always the client. Every send spends one approval of a
  // Developer-panel preview, exactly as the VS Code handoff does, and the page
  // is never re-read after approval.

  async controlCenterStatus() {
    return this.controlCenter.status();
  }

  async pairControlCenter(code: string) {
    this.requireDeveloperWorkspace();
    const status = await this.controlCenter.pair(code);
    this.addPrivacyEvent('vault', 'Paired with the Control Center', `Key ${status.fingerprint ?? 'unknown'} at ${status.url}`);
    return status;
  }

  async disconnectControlCenter() {
    this.controlCenter.disconnect();
    this.addPrivacyEvent('vault', 'Control Center link removed', 'The saved link was deleted from this computer');
    return this.controlCenter.status();
  }

  async controlCenterRepositories() {
    this.requireDeveloperWorkspace();
    return this.controlCenter.repositories(this.pageOrigin(this.activeTab(this.store.get()).url));
  }

  async controlCenterTasks() {
    this.requireDeveloperWorkspace();
    return this.controlCenter.tasks();
  }

  async sendToControlCenter(input: ControlCenterSendInput) {
    this.requireDeveloperWorkspace();
    const preview = this.consumeDeveloperApproval(input.approvalToken);
    const tab = this.activeTab(this.store.get());
    const jpeg = 'data:image/jpeg;base64,';
    const screenshot = preview.screenshotDataUrl?.startsWith(jpeg) ? preview.screenshotDataUrl.slice(jpeg.length) : undefined;
    this.addPrivacyEvent('cloud-approved', 'Control Center handoff approved', `${preview.title} · to the Control Center on this computer`);
    return this.controlCenter.createTask({
      repositoryId: input.repositoryId,
      note: input.note.trim(),
      sourceUrl: sanitizeDiagnosticUrl(tab.url).text,
      pageOrigin: this.pageOrigin(tab.url),
      evidence: developerEvidence(preview),
      ...(screenshot ? { screenshotJpegBase64: screenshot } : {}),
    });
  }

  async recheckControlCenterTask(input: ControlCenterRecheckInput) {
    this.requireDeveloperWorkspace();
    const preview = this.consumeDeveloperApproval(input.approvalToken);
    this.addPrivacyEvent('cloud-approved', 'Control Center re-check approved', `${preview.title} · ${input.taskId}`);
    return this.controlCenter.addEvidence(input.taskId, developerEvidence(preview));
  }

  /** Spends the approval first, like every AI path, then insists it approved a Developer-panel preview. */
  private consumeDeveloperApproval(token: string): AiPagePreview {
    const preview = this.consumeAiApproval(token);
    if (!this.developerPreviewIds.delete(preview.id)) throw new Error('Only Developer panel diagnostics can go to the Control Center; capture them again');
    return preview;
  }

  private pageOrigin(url: string): string | null {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
    } catch {
      return null;
    }
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

  async prepareAiPreview(scope: AiPreviewScope = 'page'): Promise<AiPagePreview> {
    if (!workspaceVaultPolicy(this.store.get().activeWorkspaceId).aiExtraction) throw new Error('AI extraction is disabled in this workspace');
    this.pruneAiCapabilities();
    this.assistantReview = undefined;
    const state = this.store.get();
    const tab = this.activeTab(state);
    const capture = await this.captureAssistantSelection(tab, scope, MAX_ASSISTANT_CONTEXT);
    this.validateAssistantSource(capture.preview, capture.navigationGeneration);
    this.addPrivacyEvent('local-read', 'Local page preview', `${capture.preview.title} · ${capture.preview.redactions} redaction(s)`);
    this.pendingAiPreviews.set(capture.preview.id, { ...capture, expiresAt: Date.now() + 5 * 60_000 });
    return capture.preview;
  }

  private async captureAssistantSelection(tab: BrowserTab, scope: AiPreviewScope, maximum: number): Promise<AssistantCapture> {
    const workspace = WORKSPACES.find((item) => item.id === tab.workspaceId)!;
    if (workspace.protected || isProtectedPage(tab.url)) {
      this.addPrivacyEvent('blocked', 'AI access blocked', `Protected page: ${tab.title}`);
      throw new Error('AI access is disabled for protected and banking pages');
    }
    const runtime = this.runtimeTabs.get(tab.id);
    const contents = runtime?.view?.webContents;
    if (!runtime || !contents || tab.isHome) throw new Error('Open a webpage first');
    const navigationGeneration = runtime.navigationGeneration;
    const code = scope === 'selection'
      ? "(window.getSelection()?.toString() ?? '').slice(0, 20000)"
      : "document.body?.innerText.slice(0, 20000) ?? ''";
    const rawText = await contents.executeJavaScriptInIsolatedWorld(1008, [{ code }]) as string;
    if (scope === 'selection' && !rawText.trim()) throw new Error('Select visible page text, then try again.');
    const result = redactSensitiveText(rawText);
    const safeTitle = redactSensitiveText(tab.title);
    const text = result.text.slice(0, maximum);
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
    return { preview, navigationGeneration };
  }

  async prepareAssistantSource(parentId: string, tabId: string): Promise<AssistantSelectionSource> {
    this.pruneAiCapabilities();
    const parent = this.pendingAiPreviews.get(parentId);
    if (parent?.navigationGeneration === undefined || parent.parentId || parent.expiresAt < Date.now()) {
      throw new Error('Read the current page again before adding a source.');
    }
    this.validateAssistantSource(parent.preview, parent.navigationGeneration);
    this.requireAssistantPolicy(parent.preview.accountSpaceId, 'local');
    const state = this.store.get();
    const tab = state.tabs.find((item) => item.id === tabId && item.accountSpaceId === parent.preview.accountSpaceId);
    if (!tab || tab.id === parent.preview.tabId || classifyAiSource(tab.url) !== 'browser') {
      throw new Error('Choose another open webpage in this Account Space.');
    }
    const capture = await this.captureAssistantSelection(tab, 'selection', MAX_ASSISTANT_SOURCE_TEXT);
    this.validateAssistantSource(parent.preview, parent.navigationGeneration);
    this.validateExtraAssistantSource(capture);
    if (this.pendingAiPreviews.get(parentId) !== parent || parent.expiresAt <= Date.now()) throw new Error('The current page preview expired.');
    this.pendingAiPreviews.set(capture.preview.id, { ...capture, parentId, expiresAt: parent.expiresAt });
    const { id, title, url, text, redactions } = capture.preview;
    return { id, tabId, title, url, text, redactions };
  }

  private validateExtraAssistantSource(capture: AssistantCapture): void {
    const state = this.store.get();
    const tab = state.tabs.find((item) => item.id === capture.preview.tabId);
    if (!tab || !sameAiSource(capture.preview, this.activeAccountSpaceId(state), tab) || isProtectedPage(tab.url)
      || this.runtimeTabs.get(tab.id)?.navigationGeneration !== capture.navigationGeneration) {
      throw new Error('An added source changed. Read it again before sending.');
    }
  }

  reviewAssistantRequest(previewId: string, text: string, questionValue: string, withEvidence = false, edits: AssistantSelectionEdit[] = []): AiRequestReview {
    this.assistantReview = undefined;
    const pending = this.pendingAiPreviews.get(previewId);
    if (pending?.navigationGeneration === undefined || pending.parentId || pending.expiresAt < Date.now()) {
      throw new Error('The page preview expired. Read the page again.');
    }
    this.validateAssistantSource(pending.preview, pending.navigationGeneration);
    if (!maySendAiPreviewToCloud(pending.preview)) throw new Error('Mailbox contents never enter an AI model.');
    const provider = this.aiProvider.status();
    if (!provider.configured || !provider.mode || !provider.model) throw new Error('Configure an AI provider first.');
    this.requireAssistantPolicy(pending.preview.accountSpaceId, provider.mode);
    const question = redactSensitiveText(questionValue.trim());
    if (!question.text) throw new Error('Enter a question before reviewing the request.');
    const redacted = redactSensitiveText(text);
    const additional = edits.map((edit) => {
      const extra = this.pendingAiPreviews.get(edit.id);
      if (extra?.parentId !== previewId || extra.navigationGeneration === undefined || extra.expiresAt < Date.now()) {
        throw new Error('An added source expired. Read it again.');
      }
      const capture = { preview: extra.preview, navigationGeneration: extra.navigationGeneration };
      this.validateExtraAssistantSource(capture);
      return { capture, excerpt: redactSensitiveText(edit.text) };
    });
    const includeCurrent = !additional.length || Boolean(redacted.text.trim());
    const edited = [...includeCurrent ? [redacted] : [], ...additional.map(({ excerpt }) => excerpt)];
    const excerpts = edited.map((excerpt) => excerpt.text);
    if (excerpts.reduce((total, excerpt) => total + excerpt.length, 0) > MAX_ASSISTANT_CONTEXT) {
      throw new Error('Reduce the combined excerpts to 12,000 characters.');
    }
    const reviewedQuestion = assistantQuestion(question.text, withEvidence);
    const sources = [...includeCurrent ? [pending.preview] : [], ...additional.map(({ capture }) => capture.preview)];
    const contextText = formatAssistantExcerpts(sources.map((source, index) => ({ ...source, text: excerpts[index] })), additional.length > 0);
    const preview = { ...pending.preview, text: contextText, ...(additional.length ? { title: 'Reviewed webpages', url: 'See source origins below' } : {}) };
    const review: AiRequestReview = {
      id: randomUUID(),
      mode: provider.mode,
      destination: provider.mode === 'local' ? 'http://127.0.0.1:11434/api/chat' : `${provider.endpoint}/chat/completions`,
      model: provider.model,
      systemPrompt: AI_SYSTEM_PROMPT,
      userPrompt: aiUserPrompt(preview, reviewedQuestion),
      redactions: sources.reduce((total, source) => total + source.redactions, question.redactions)
        + edited.reduce((total, item) => total + item.redactions, 0),
    };
    this.assistantReview = { review, preview, question: reviewedQuestion, withEvidence, expiresAt: pending.expiresAt,
      navigationGeneration: pending.navigationGeneration, additional: additional.map(({ capture }) => capture), excerpts };
    return review;
  }

  async askReviewedAssistant(id: string): Promise<AssistantAnswer> {
    if (this.activeAssistant) throw new Error('An Assistant request is already running.');
    const pending = this.assistantReview;
    if (pending?.review.id !== id) throw new Error('Review the request before sending it.');
    this.assistantReview = undefined;
    if (pending.expiresAt < Date.now()) throw new Error('The review expired. Read the page again.');
    const validate = () => {
      this.validateAssistantSource(pending.preview, pending.navigationGeneration);
      pending.additional.forEach((source) => this.validateExtraAssistantSource(source));
      this.requireAssistantPolicy(pending.preview.accountSpaceId, pending.review.mode);
      const current = this.aiProvider.status();
      const destination = current.mode === 'local' ? 'http://127.0.0.1:11434/api/chat' : `${current.endpoint}/chat/completions`;
      if (!current.configured || current.mode !== pending.review.mode || current.model !== pending.review.model || destination !== pending.review.destination) {
        throw new Error('The provider changed. Review the request again.');
      }
    };
    validate();
    const kind = pending.review.mode === 'local' ? 'local-read' : 'cloud-approved';
    this.recordAssistantReceipt(pending.preview.accountSpaceId, pending.review.mode, pending.review.destination, 'page-request');
    this.addPrivacyEvent(kind, 'Assistant request approved', `${pending.review.redactions} redaction(s)`);
    const controller = new AbortController();
    this.activeAssistant = { id, mode: pending.review.mode, controller };
    try {
      const answer = await this.aiProvider.ask(pending.preview, pending.question, validate, controller.signal);
      controller.signal.throwIfAborted();
      this.pendingAiPreviews.delete(pending.preview.id);
      for (const [sourceId, read] of this.pendingAiPreviews) if (read.parentId === pending.preview.id) this.pendingAiPreviews.delete(sourceId);
      this.addPrivacyEvent(kind, 'Assistant request completed', 'Provider returned a response');
      return readAssistantAnswer(answer, pending.withEvidence, pending.excerpts);
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'cancelled' };
      if (error instanceof Error && (error.name === 'TimeoutError' || (error.cause instanceof Error && error.cause.name === 'TimeoutError'))) {
        return { kind: 'timeout' };
      }
      throw error;
    } finally {
      this.activeAssistant = undefined;
    }
  }

  cancelReviewedAssistant(id: string): void {
    if (this.activeAssistant?.id === id) this.activeAssistant.controller.abort();
  }

  private validateAssistantSource(preview: AiPagePreview, navigationGeneration: number): void {
    this.validateAiSource(preview);
    if (this.runtimeTabs.get(preview.tabId)?.navigationGeneration !== navigationGeneration) {
      throw new Error('The page changed. Read it again before sending.');
    }
  }

  approveAiPreview(previewId: string, mode: 'cloud' | 'local' = 'cloud'): AiApproval {
    const pending = this.pendingAiPreviews.get(previewId);
    this.pendingAiPreviews.delete(previewId);
    if (!pending || pending.expiresAt < Date.now()) throw new Error('The page preview expired; read the page again');
    const preview = pending.preview;
    const state = this.store.get();
    const tab = this.activeTab(state);
    const accountSpaceId = this.activeAccountSpaceId(state);
    if (!sameAiSource(preview, accountSpaceId, tab) || isProtectedPage(tab.url)) throw new Error('The page, tab, or Account Space changed or is protected');
    if (!maySendAiPreviewToCloud(preview)) throw new Error('Mailbox contents never leave this device or enter an AI model');
    if (mode === 'local' && this.aiProvider.status().mode !== 'local') throw new Error('Choose a local model before approving.');
    const token = randomUUID();
    this.aiApprovals.set(token, { preview, mode, expiresAt: Date.now() + 5 * 60_000 });
    this.addPrivacyEvent(mode === 'local' ? 'local-read' : 'cloud-approved', mode === 'local' ? 'Local context approved' : 'Cloud context approved', `${preview.title} · ${preview.redactions} redaction(s)`);
    return { token, preview };
  }

  getAiProvider() {
    return this.aiProvider.status();
  }

  private assistantPolicy(state = this.store.get()): AssistantSpacePolicy {
    const accountId = this.activeAccountSpaceId(state);
    const account = state.accountSpaces.find((candidate) => candidate.id === accountId);
    if (this.store.isReadOnly() || !account || !isAvailableRegularAccount(state, account) || !workspaceVaultPolicy(state.activeWorkspaceId).aiExtraction) {
      return { cloud: 'unavailable', receipts: [] };
    }
    const preferences = this.store.assistantPreferences(accountId);
    return preferences ? { cloud: preferences.cloudAllowed ? 'allowed' : 'disabled', receipts: preferences.receipts }
      : { cloud: 'unavailable', receipts: [] };
  }

  private requireAssistantPolicy(accountId: AccountSpaceId, mode: 'local' | 'cloud'): void {
    const state = this.store.get();
    const policy = this.assistantPolicy(state);
    if (accountId !== this.activeAccountSpaceId(state) || policy.cloud === 'unavailable') {
      throw new Error('Assistant requests are unavailable in this Account Space.');
    }
    if (mode === 'cloud' && policy.cloud === 'disabled') throw new Error('Cloud AI is disabled in this Account Space.');
  }

  setAssistantCloudAllowed(accountId: AccountSpaceId, allowed: boolean): void {
    this.requireAssistantPolicy(accountId, 'local');
    this.store.refreshAccount(this.accounts.update(accountId, (record) => { record.assistantCloudAllowed = allowed; }));
    if (!allowed) {
      if (this.assistantReview?.review.mode === 'cloud') this.assistantReview = undefined;
      if (this.activeAssistant?.mode === 'cloud') this.activeAssistant.controller.abort();
    }
    this.broadcast();
  }

  private recordAssistantReceipt(accountId: AccountSpaceId, mode: AssistantReceipt['mode'], destination: string, purpose: AssistantReceipt['purpose']): void {
    const receipt: AssistantReceipt = { at: new Date().toISOString(), mode, destination: new URL(destination).origin, purpose };
    this.store.refreshAccount(this.accounts.update(accountId, (record) => {
      record.assistantReceipts = [receipt, ...record.assistantReceipts ?? []].slice(0, MAX_ASSISTANT_RECEIPTS);
    }));
    this.broadcast();
  }

  checkAiProvider() {
    const account = this.activeAccountSpaceId(this.store.get());
    const provider = this.aiProvider.status();
    const validateWorkspace = () => this.requireAssistantPolicy(account, provider.mode ?? 'local');
    validateWorkspace();
    if (provider.configured && provider.mode) {
      const target = provider.mode === 'local' ? 'http://127.0.0.1:11434' : provider.endpoint!;
      this.recordAssistantReceipt(account, provider.mode, target, 'connection-test');
    }
    return this.aiProvider.checkConnection(validateWorkspace);
  }

  localAiModels() {
    if (!workspaceVaultPolicy(this.store.get().activeWorkspaceId).aiExtraction) throw new Error('AI is unavailable in this workspace');
    return this.aiProvider.localModels();
  }

  async configureAiProvider(input: AiProviderInput) {
    const account = this.activeAccountSpaceId(this.store.get());
    const validateSetupSpace = () => {
      const state = this.store.get();
      if ('mode' in input && (account !== this.activeAccountSpaceId(state) || !workspaceVaultPolicy(state.activeWorkspaceId).aiExtraction)) {
        throw new Error('Return to the original Account Space to configure local AI.');
      }
    };
    validateSetupSpace();
    const status = await this.aiProvider.configure(input, validateSetupSpace);
    this.revokeAiContext();
    this.addPrivacyEvent('vault', 'AI provider configured', status.endpoint ?? 'Ollama local model');
    return status;
  }

  clearAiProvider() {
    const status = this.aiProvider.clear();
    this.revokeAiContext();
    this.addPrivacyEvent('vault', 'AI provider removed', 'Encrypted provider credentials cleared');
    return status;
  }

  async askAi(token: string, questionValue: string): Promise<string> {
    const question = questionValue.trim();
    if (!question || question.length > 2000) throw new Error('Enter a question under 2,000 characters');
    const provider = this.aiProvider.status();
    const mode = provider.mode ?? 'cloud';
    const preview = this.consumeAiApproval(token, mode);
    if (!this.developerPreviewIds.has(preview.id)) throw new Error('Review the Assistant request before sending it.');
    const validate = () => {
      this.validateAiSource(preview);
      this.requireAssistantPolicy(preview.accountSpaceId, mode);
    };
    validate();
    if (provider.configured) this.recordAssistantReceipt(preview.accountSpaceId, mode, mode === 'local' ? 'http://127.0.0.1:11434' : provider.endpoint!, 'developer-request');
    const answer = await this.aiProvider.ask(preview, question, validate);
    this.addPrivacyEvent(mode === 'local' ? 'local-read' : 'cloud-approved', mode === 'local' ? 'Local AI request completed' : 'Cloud AI request completed', 'Provider returned a response');
    return answer;
  }

  private consumeAiApproval(token: string, mode: 'cloud' | 'local' = 'cloud'): AiPagePreview {
    const approval = this.aiApprovals.get(token);
    this.aiApprovals.delete(token);
    if (!approval || approval.expiresAt < Date.now()) throw new Error('AI approval expired; approve the page again');
    if (approval.mode !== mode) throw new Error('The AI destination changed; approve the page for this destination.');
    this.validateAiSource(approval.preview);
    return approval.preview;
  }

  private validateAiSource(preview: AiPagePreview): void {
    const state = this.store.get();
    const tab = this.activeTab(state);
    const accountSpaceId = this.activeAccountSpaceId(state);
    if (!sameAiSource(preview, accountSpaceId, tab) || isProtectedPage(tab.url)) throw new Error('The page, tab, or Account Space changed or is protected');
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
    const had = this.pendingAiPreviews.size + this.aiApprovals.size + Number(Boolean(this.assistantReview));
    this.pendingAiPreviews.clear();
    this.aiApprovals.clear();
    this.assistantReview = undefined;
    this.activeAssistant?.controller.abort();
    if (had) this.addPrivacyEvent('blocked', 'AI context revoked', 'The approved page text was discarded before it was used');
  }

  listVault() {
    const status = this.vault.status();
    const items = status.lifecycle === 'unlocked' && this.activeVaultPolicy().vaultSurface
      ? this.vault.searchMetadata().map((item) => ({ ...item, label: item.title,
        url: item.url && isAllowedRemoteUrl(item.url) ? new URL(item.url).origin : '' }))
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
      platformUnlock: status.platformUnlockEnrolled ? 'enrolled' as const : this.probeWindowsHello() ? 'available' as const : 'unavailable' as const,
      generation: status.generation,
    };
  }

  /** Returns the cached answer; the first call starts the probe and repaints the panel when it lands. */
  private probeWindowsHello(): boolean {
    if (this.windowsHelloAvailable !== undefined) return this.windowsHelloAvailable;
    this.windowsHelloProbe ??= this.windowsHello.isAvailable().then((available) => {
      this.windowsHelloAvailable = available;
      if (this.window && !this.window.isDestroyed()) this.window.webContents.send('vault:state');
      return available;
    });
    return false;
  }

  async unlockVaultWithHello() {
    this.assertVaultSurface();
    try {
      await this.vault.unlockWithPlatform(this.windowsHello);
    } catch (error) {
      if (error instanceof PlatformUnlockError && error.status === 'UserCanceled') return this.listVault();
      throw error;
    }
    void this.vaultSync.syncNow().catch(() => undefined);
    this.addPrivacyEvent('vault', 'MyVault unlocked with Windows Hello', 'Decrypted state is held only by the trusted broker');
    return this.listVault();
  }

  async enableVaultHello() {
    this.assertVaultSurface();
    if (!(await (this.windowsHelloProbe ?? this.windowsHello.isAvailable()))) throw new Error('Windows Hello is not set up on this computer.');
    const value = await this.secureDialogs.open('enroll-hello') as UnlockDialogValue | undefined;
    if (!value) return this.listVault();
    try {
      await this.vault.enrollPlatformUnlock(value.password, this.windowsHello);
    } catch (error) {
      if (error instanceof PlatformUnlockError && error.status === 'UserCanceled') return this.listVault();
      throw error;
    }
    this.addPrivacyEvent('vault', 'Windows Hello unlock turned on', 'The vault key was wrapped under a key only Windows Hello can release');
    return this.listVault();
  }

  async disableVaultHello() {
    this.assertVaultSurface();
    await this.vault.removePlatformUnlock(this.windowsHello);
    this.addPrivacyEvent('vault', 'Windows Hello unlock turned off', 'The Hello-wrapped vault key and the Hello key were deleted');
    return this.listVault();
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
    this.fillPicker.close();
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
    // Pairing installs the cloud envelope over the local one; it is only for a
    // device that has no vault yet, never a way to discard unsynced changes.
    if (this.vault.status().lifecycle !== 'unconfigured') throw new Error('MyVault is already connected on this device');
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

  private assertChromePasswordImport(accountId: AccountSpaceId): void {
    if (accountId !== this.activeAccountSpaceId(this.store.get()) || !this.activeVaultPolicy().saveCapture) {
      throw new Error('Password import is unavailable in this Account Space.');
    }
    if (this.vault.status().lifecycle !== 'unlocked') throw new Error('Unlock MyVault before importing a password file.');
  }

  async reviewChromePasswords(): Promise<ChromePasswordImportReview | undefined> {
    const accountId = this.activeAccountSpaceId(this.store.get());
    this.assertChromePasswordImport(accountId);
    if (this.selectingChromePasswords) throw new Error('The password file chooser is already open.');
    this.pendingChromePasswords = undefined;
    this.selectingChromePasswords = true;
    try {
      const selected = await dialog.showOpenDialog(this.window, { title: 'Review Chrome passwords for MyVault', properties: ['openFile'],
        filters: [{ name: 'Chrome password CSV', extensions: ['csv'] }] });
      if (selected.canceled || !selected.filePaths[0]) return undefined;
      this.assertChromePasswordImport(accountId);
      const path = selected.filePaths[0];
      const { digest, revision, review } = this.migration.reviewChromeCsv(path);
      const id = randomUUID();
      this.pendingChromePasswords = { id, accountId, path, digest, revision, expiresAt: Date.now() + 5 * 60_000 };
      return { id, ...review };
    } finally {
      this.selectingChromePasswords = false;
    }
  }

  async importReviewedChromePasswords(id: string): Promise<ChromePasswordImportResult> {
    const pending = this.pendingChromePasswords;
    if (!pending || pending.id !== id || pending.expiresAt <= Date.now()) throw new Error('Review the password file again before importing.');
    this.pendingChromePasswords = undefined;
    this.assertChromePasswordImport(pending.accountId);
    const report = await this.migration.importReviewedChromeCsv(pending.path, pending.digest, pending.revision);
    if (report.imported) this.addPrivacyEvent('vault', 'Chrome passwords imported into MyVault', `${report.imported} encrypted logins added`);
    return report;
  }

  discardChromePasswordReview(id: string): void {
    if (this.pendingChromePasswords?.id === id) this.pendingChromePasswords = undefined;
  }

  async openVaultEditor(origin?: string) {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.saveCapture) throw new Error('Saving passwords is disabled in this workspace');
    const tab = this.activeTab(this.store.get());
    const runtime = this.runtimeTabs.get(tab.id);
    const generation = runtime?.navigationGeneration;
    const pageOrigin = isAllowedRemoteUrl(tab.url) ? normalizedWebOrigin(tab.url) : undefined;
    const generate = this.vault.status().configured && policy.passwordClipboard && pageOrigin?.startsWith('https://')
      && !isProtectedPage(tab.url) && runtime && !runtime.certificateError
      ? (preset: SecureCredentialPreset) => {
        const active = this.activeTab(this.store.get());
        const latest = this.runtimeTabs.get(active.id);
        if (active.id !== tab.id || !latest || latest.navigationGeneration !== generation
          || !isAllowedRemoteUrl(active.url) || isProtectedPage(active.url) || normalizedWebOrigin(active.url) !== pageOrigin
          || latest.certificateError || !this.activeVaultPolicy().passwordClipboard) throw new Error('The current page is no longer eligible to generate a login');
        const options = SECURE_CREDENTIAL_PRESETS[preset];
        return this.vault.generateCredential(options.kind, options);
      } : undefined;
    const value = await this.secureDialogs.open('edit-login', origin, generate) as EditLoginDialogValue | undefined;
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

  private assertVaultHealthScope(accountId: AccountSpaceId): void {
    if (this.activeAccountSpaceId(this.store.get()) !== accountId || !this.activeVaultPolicy().saveCapture) {
      throw new Error('Vault health is unavailable in this Account Space.');
    }
  }

  checkVaultHealth(accountId: AccountSpaceId) {
    this.assertVaultHealthScope(accountId);
    return this.vault.checkLoginHealth();
  }

  async editVaultHealthLogin(accountId: AccountSpaceId, id: string): Promise<boolean> {
    this.assertVaultHealthScope(accountId);
    const edit = this.vault.beginLoginEdit(id);
    const { title, username, url } = edit.metadata;
    const origin = url && isAllowedRemoteUrl(url) ? new URL(url).origin : undefined;
    const value = await this.secureDialogs.open('update-login', origin, undefined, { title, username }) as EditLoginDialogValue | undefined;
    if (!value) return false;
    this.assertVaultHealthScope(accountId);
    await edit.save({
      title: value.title,
      url: value.url,
      username: value.username,
      password: value.password,
      totp: value.totpSecret ? { secret: value.totpSecret, algorithm: 'SHA-1', digits: 6, period: 30 } : undefined,
    });
    this.addPrivacyEvent('vault', 'MyVault login updated', 'A saved login was edited in the secure window');
    return true;
  }

  acknowledgeVaultRecovery() {
    this.assertVaultSurface();
    this.vault.acknowledgeRecovery();
    this.addPrivacyEvent('vault', 'Vault recovery acknowledged', 'The unreadable encrypted file remains preserved');
    return this.listVault();
  }

  async copyPassword(id: string): Promise<void> {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.passwordClipboard) throw new Error('Password clipboard is disabled in this workspace');
    await this.copySensitiveValue(this.vault.resolveSecretForTrustedOperation(id, 'password'));
    this.addPrivacyEvent('vault', 'Password copied', 'Clipboard clears automatically after 30 seconds');
  }

  async copyTotp(id: string): Promise<{ secondsRemaining: number }> {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.passwordClipboard) throw new Error('Vault clipboard is disabled in this workspace');
    const now = Math.floor(Date.now() / 1000);
    const code = generateTotp(this.vault.resolveSecretForTrustedOperation(id, 'totp-secret'), now);
    await this.copySensitiveValue(code);
    this.addPrivacyEvent('vault', 'Authenticator code copied', 'Generated locally; clipboard auto-clear enabled');
    return { secondsRemaining: 30 - (now % 30) };
  }

  /** Clear a still-pending copied secret now — used on quit, so exiting inside
   *  the 30-second window does not leave a password on the clipboard. */
  async flushClipboard(): Promise<void> {
    await this.clipboardGuard.flush();
  }

  get secretClipboardPending(): boolean {
    return this.clipboardGuard.isPending;
  }

  vaultClipboardDeadline(): number | undefined {
    if (!this.activeVaultPolicy().passwordClipboard) return undefined;
    return this.clipboardGuard.expiresAt;
  }

  clearVaultClipboard(): Promise<boolean> {
    if (!this.activeVaultPolicy().passwordClipboard) throw new Error('Vault clipboard is disabled in this workspace');
    return this.clipboardGuard.flush();
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
    await this.fillEntryInto(initial, id);
    this.addPrivacyEvent('vault', 'Credential autofilled', new URL(initial.origin).hostname);
  }

  /**
   * Deliberate fill shared by the side panel's Fill and the login picker.
   * `initial` is the context the user saw when choosing; if the page has moved
   * on since, the capability redemption throws and nothing is filled.
   * `scope` is 'same-site' only for a login the user picked from the picker,
   * which may list other addresses of the page's site; everything else is exact.
   */
  private async fillEntryInto(initial: FillContext, id: string, scope: 'exact' | 'same-site' = 'exact'): Promise<void> {
    const capability = this.fillCapabilities.issue(initial, id, 'fill-login');
    this.fillCapabilities.redeem(capability, this.currentFillContext(), id, 'fill-login');
    const match = scope === 'same-site'
      ? this.vault.searchMetadata('').find((entry) => entry.id === id && Boolean(entry.url) && isSameSiteFillCandidate(entry.url!, initial.origin))
      : this.vault.searchMetadata('', initial.origin).find((entry) => entry.id === id && Boolean(entry.url) && isAutofillTarget(entry.url!, initial.origin));
    if (!match) throw new Error('This credential belongs to another website, or this page is not secure');
    const username = this.vault.resolveSecretForTrustedOperation(id, 'username');
    const password = this.vault.resolveSecretForTrustedOperation(id, 'password');
    const beforeInjection = this.currentFillContext();
    if (JSON.stringify(beforeInjection) !== JSON.stringify(initial)) throw new Error('Vault fill expired because the page context changed');
    const contents = this.activeContents();
    if (!contents || contents.id !== initial.webContentsId) throw new Error('Vault fill expired because the page context changed');
    await fillLoginInIsolatedWorld(contents, username, password);
    if (workspaceVaultPolicy(initial.workspaceId).fillPicker) this.fillPreferences.remember(initial.accountSpaceId, initial.origin, id);
    const runtime = this.runtimeTabs.get(initial.tabId);
    if (runtime) runtime.automaticFillGeneration = initial.navigationGeneration;
  }

  /**
   * Keys typed in the page while the login picker is open. Focus stays in the
   * page field, so arrows, Enter and Escape are read here, the way Chrome
   * drives its own list. Returns true when the key was consumed.
   */
  private handleFillPickerKey(tabId: string, event: Electron.Event, input: Electron.Input): boolean {
    const picker = this.fillPicker;
    const plain = !input.control && !input.alt && !input.meta && !input.shift;
    if (input.type === 'keyUp') {
      if (input.key === 'Tab' && !picker?.isOpen) this.scheduleFillPickerProbe(tabId);
      return false;
    }
    if (input.type !== 'keyDown') return false;
    if (!picker?.isOpen || picker.context?.tabId !== tabId) {
      if (plain && input.key === 'ArrowDown') this.scheduleFillPickerProbe(tabId);
      return false;
    }
    if (plain && (input.key === 'ArrowDown' || input.key === 'ArrowUp')) {
      event.preventDefault();
      picker.moveHighlight(input.key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    if (plain && input.key === 'Enter' && picker.chooseHighlighted()) {
      event.preventDefault();
      return true;
    }
    if (input.key === 'Escape') {
      event.preventDefault();
      picker.close();
      return true;
    }
    if (!['Shift', 'Control', 'Alt', 'Meta'].includes(input.key)) picker.close();
    return false;
  }

  private scheduleFillPickerProbe(tabId: string): void {
    const generation = this.runtimeTabs.get(tabId)?.navigationGeneration;
    if (generation === undefined) return;
    // Let the click or Tab move focus before asking which field has it.
    const timer = setTimeout(() => void this.openFillPicker(tabId, generation), 60);
    timer.unref();
  }

  private async openFillPicker(tabId: string, generation: number): Promise<void> {
    const picker = this.fillPicker;
    if (!picker || this.window.isDestroyed()) return;
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    const runtime = this.runtimeTabs.get(tabId);
    const view = runtime?.view;
    if (!tab || tab.isHome || this.activeTab(state).id !== tabId || !runtime || !view || !view.getVisible()) return;
    if (!workspaceVaultPolicy(tab.workspaceId).fillPicker || this.vault.status().lifecycle !== 'unlocked') return;
    if (runtime.navigationGeneration !== generation || runtime.certificateError || this.htmlFullscreenOwner) return;
    const contents = view.webContents;
    if (!isAutomaticFillPageUrl(contents.getURL())) return;
    try {
      const context = this.currentFillContext();
      if (context.tabId !== tabId || context.navigationGeneration !== generation || !context.origin.startsWith('https://')) return;
      // Chrome's rule: this exact origin first, then other addresses of the same site.
      const candidates = orderFillCandidates(
        this.vault.searchMetadata('').filter((entry) => Boolean(entry.url) && isSameSiteFillCandidate(entry.url!, context.origin)),
        this.fillPreferences.get(context.accountSpaceId, context.origin),
        context.origin,
      ).slice(0, FILL_PICKER_MAX_ROWS);
      if (!candidates.length) return;
      const field = await probeFocusedLoginField(contents);
      if (!field || JSON.stringify(this.currentFillContext()) !== JSON.stringify(context)) return;
      const bounds = fillPickerBounds(field.rect, contents.getZoomFactor(), view.getBounds(), candidates.length);
      if (!bounds) return;
      const rows = candidates.map((entry) => ({
        entryId: entry.id,
        username: entry.username,
        title: entry.title,
        savedFor: isAutofillTarget(entry.url!, context.origin) ? undefined : new URL(entry.url!).host,
      }));
      picker.show(context, rows, bounds, contents);
    } catch {
      // A locked vault, a navigation or a vanished field just means no list.
    }
  }

  private async handleFillPickerChoice(choice: FillPickerChoice): Promise<void> {
    if (choice.kind === 'manage') {
      if (this.window.isDestroyed()) return;
      this.window.webContents.focus();
      this.window.webContents.send('browser:command', { command: 'open-vault' });
      return;
    }
    // Clicking the overlay took focus from the page; give it back to the field.
    const contents = this.activeContents();
    if (contents && contents.id === choice.context.webContentsId) contents.focus();
    try {
      if (!workspaceVaultPolicy(choice.context.workspaceId).fillPicker) return;
      await this.fillEntryInto(choice.context, choice.entryId, 'same-site');
      this.addPrivacyEvent('vault', 'Credential filled from picker', new URL(choice.context.origin).hostname);
    } catch {
      // The page moved on after the list opened: fail closed and fill nothing.
    }
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
    if (!tab || active.id !== tabId || !runtime || !contents || tab.isHome || agentHost?.isLentContents(contents.id)) return;
    if (!workspaceVaultPolicy(tab.workspaceId).automaticFill || this.vault.status().lifecycle !== 'unlocked') return;
    if (runtime.navigationGeneration !== generation || runtime.automaticFillGeneration === generation || runtime.automaticFillPending || runtime.certificateError) return;
    if (!isAutomaticFillPageUrl(contents.getURL())) return;

    runtime.automaticFillPending = true;
    try {
      const initial = this.currentFillContext();
      if (initial.tabId !== tabId || initial.navigationGeneration !== generation || !initial.origin.startsWith('https://')) return;
      const match = selectAutomaticFillEntry(
        this.vault.searchMetadata('', initial.origin),
        this.fillPreferences.get(initial.accountSpaceId, initial.origin),
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

  resetVaultPicks(accountId: AccountSpaceId): boolean {
    if (accountId !== this.activeAccountSpaceId(this.store.get()) || !this.activeVaultPolicy().fillPicker) {
      throw new Error('Remembered picks are unavailable in this Account Space.');
    }
    return this.fillPreferences.reset(accountId);
  }

  async vaultFillReadiness(): Promise<VaultFillReadiness> {
    const policy = this.activeVaultPolicy();
    const status = this.vault.status();
    if (!policy.vaultSurface || !policy.manualFill || !status.credentialPersistenceAvailable) return 'unavailable';
    if (status.lifecycle === 'unconfigured') return 'connect';
    if (status.lifecycle === 'locked') return 'locked';
    if (status.lifecycle !== 'unlocked') return 'unavailable';
    try {
      const initial = this.currentFillContext();
      const contents = this.activeContents();
      if (!contents || !initial.origin.startsWith('https://')) return 'unsupported';
      if (policy.requireFillConfirmation) return 'manual';
      if (!isAutomaticFillPageUrl(contents.getURL()) || !await hasSupportedLoginForm(contents)) return 'unsupported';
      if (JSON.stringify(this.currentFillContext()) !== JSON.stringify(initial)) return 'unsupported';
      if (this.vault.status().lifecycle !== 'unlocked') return 'locked';
      const matches = this.vault.searchMetadata('', initial.origin).filter((entry) => entry.url && isAutofillTarget(entry.url, initial.origin));
      if (!matches.length) return 'no-match';
      return selectAutomaticFillEntry(matches, this.fillPreferences.get(initial.accountSpaceId, initial.origin)) ? 'ready' : 'choose-login';
    } catch {
      return 'unsupported';
    }
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

  async copyGeneratedCredential(kind: GeneratedCredentialKind): Promise<void> {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.passwordClipboard) throw new Error('Credential clipboard is disabled in this workspace');
    if (!['password', 'passphrase', 'pin'].includes(kind)) throw new Error('Unsupported generator type');
    await this.copySensitiveValue(this.vault.generateCredential(kind));
    this.addPrivacyEvent('vault', 'Generated credential copied', 'Generated by the broker; clipboard auto-clear enabled');
  }

  private activeDownloadAccount(state = this.store.get()): AccountSpaceId | undefined {
    const id = this.activeAccountSpaceId(state);
    const account = state.accountSpaces.find((candidate) => candidate.id === id);
    return account && isAvailableRegularAccount(state, account) ? id : undefined;
  }

  private requireOwnedDownload(id: string): LocalDownload {
    const item = this.downloads.get(id);
    const accountId = this.activeDownloadAccount();
    if (accountId && item?.accountSpaceId === accountId) return item;
    const retained = accountId && this.downloadHistory.entries(accountId).find(({ entry }) => entry.id === id);
    if (retained) {
      return { ...retained.entry, savePath: retained.file?.path, retainedFileStamp: retained.file?.stamp };
    }
    throw new Error('Download is unavailable in this Account Space');
  }

  private downloadEntries(accountId: AccountSpaceId): DownloadEntry[] {
    const live = [...this.downloads.values()].filter((entry) => entry.accountSpaceId === accountId);
    const retained = this.downloadHistory.entries(accountId).filter(({ entry }) => !this.downloads.has(entry.id));
    return [
      ...live.map(({ savePath: _path, expectedInstaller: _expected, verifiedStamp: _stamp, retainedFileStamp: _retained, ...entry }) => entry),
      ...retained.map(({ entry }) => entry),
    ];
  }

  setDownloadHistory(accountId: AccountSpaceId, enabled: boolean): void {
    if (accountId !== this.activeDownloadAccount() || this.store.isReadOnly()) throw new Error('Download history is unavailable in this Account Space');
    this.downloadHistory.setEnabled(accountId, enabled);
    this.downloadHistoryFailures.delete(accountId);
    this.broadcast();
  }

  removeDownloadEntry(accountId: AccountSpaceId, id: string): void {
    if (accountId !== this.activeDownloadAccount() || this.store.isReadOnly()) throw new Error('Download history is unavailable in this Account Space');
    const entry = this.requireOwnedDownload(id);
    if (this.downloadItems.has(id) || entry.checksum === 'checking') throw new Error('Wait until this download finishes.');
    if (this.downloadHistory.entries(accountId).some(({ entry }) => entry.id === id)) this.downloadHistory.remove(accountId, id);
    this.downloads.delete(id);
    this.broadcast();
  }

  private requireActiveDownload(id: string) {
    const item = this.requireOwnedDownload(id);
    if (item.state !== 'completed' || !item.savePath) throw new Error('This download is incomplete');
    if (!downloadFileStamp(item.savePath)) throw new Error('The downloaded file is missing or unavailable. Download it again.');
    return { ...item, savePath: item.savePath };
  }

  private updateDownloadProgress(entry: LocalDownload, item: DownloadItem, state: 'progressing' | 'interrupted'): void {
    const paused = item.isPaused();
    Object.assign(entry, {
      state, paused, receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(),
      canPause: state === 'progressing' && !paused && Boolean(item.getETag() && item.getLastModifiedTime()),
      canResume: (paused || state === 'interrupted') && item.canResume(),
      canCancel: true,
    });
  }

  controlDownload(id: string, action: DownloadAction): void {
    const entry = this.requireOwnedDownload(id);
    const item = this.downloadItems.get(id);
    if (!item || (entry.state !== 'progressing' && entry.state !== 'interrupted')) {
      throw new Error('This download has ended. Start it again from the original page.');
    }
    this.updateDownloadProgress(entry, item, entry.state);
    if (action === 'cancel') {
      item.cancel();
      return;
    }
    const resume = (action === 'resume' && entry.paused) || (action === 'retry' && entry.state === 'interrupted');
    if (action === 'pause' && entry.canPause) item.pause();
    else if (resume && entry.canResume) item.resume();
    else throw new Error('This download cannot be paused or resumed right now.');
    if (this.downloadItems.get(id) === item) {
      this.updateDownloadProgress(entry, item, item.getState() === 'interrupted' ? 'interrupted' : 'progressing');
      this.broadcast();
    }
  }

  async openDownload(id: string): Promise<void> {
    const item = this.requireActiveDownload(id);
    if (item.retainedFileStamp && item.retainedFileStamp !== downloadFileStamp(item.savePath)) {
      throw new Error('The saved file changed after download. Download a fresh copy or use Show folder to inspect it.');
    }
    // Judge the file that will be opened, not the name the site suggested.
    const blocked = downloadOpenBlock({ ...item, risk: downloadRisk(basename(item.savePath)) });
    if (blocked) throw new Error(blocked);
    if (item.expectedInstaller) {
      const entry = this.downloads.get(id)!;
      await this.verifyInstallerDownload(entry, item.savePath);
      const checked = this.requireActiveDownload(id);
      if (checked.checksum !== 'verified' || checked.verifiedStamp !== downloadFileStamp(checked.savePath)) {
        throw new Error('The installer changed or could not be verified. Download a fresh copy.');
      }
    }
    const error = await shell.openPath(item.savePath);
    if (error) throw new Error('Windows could not open the file. Use Show folder to check it or choose another app.');
  }

  private async verifyInstallerDownload(entry: LocalDownload, filePath: string): Promise<void> {
    const previous = entry.checksum;
    entry.checksum = 'checking';
    this.broadcast();
    const stamp = downloadFileStamp(filePath);
    const checksum = stamp ? await verifyDownload(filePath, entry.filename, entry.expectedInstaller) : 'unchecked';
    entry.publisher = checksum === 'verified'
      ? stamp === entry.verifiedStamp && entry.publisher ? entry.publisher : await inspectDownloadPublisher(filePath)
      : undefined;
    const unchanged = stamp && stamp === downloadFileStamp(filePath);
    entry.checksum = unchanged ? checksum : 'unchecked';
    entry.verifiedStamp = unchanged && entry.checksum === 'verified' ? stamp : undefined;
    if (!entry.verifiedStamp) entry.publisher = undefined;
    if (this.downloads.get(entry.id) !== entry) return;
    if ((entry.checksum === 'verified' || entry.checksum === 'mismatch') && entry.checksum !== previous) {
      this.addPrivacyEvent(
        entry.checksum === 'verified' ? 'vault' : 'blocked',
        entry.checksum === 'verified' ? 'Installer checksum verified' : 'Installer checksum mismatch',
        entry.checksum === 'verified' ? 'The file matches the published release' : 'Download a fresh copy from the release service',
      );
    }
    this.broadcast();
  }

  showDownload(id: string): void {
    const item = this.requireActiveDownload(id);
    if (item.checksum === 'checking') throw new Error('Wait for installer verification to finish.');
    shell.showItemInFolder(item.savePath);
  }

  isDefaultBrowser(): boolean {
    return app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https');
  }

  async openDefaultBrowserSettings(): Promise<void> {
    if (process.platform !== 'win32') throw new Error('Default Apps requires Windows');
    try { await shell.openExternal('ms-settings:defaultapps'); }
    catch { throw new Error('Open Settings, then Apps, then Default apps'); }
  }

  async testDefaultBrowser(): Promise<void> {
    try { await shell.openExternal('https://example.com/'); }
    catch { throw new Error('Windows could not open the test link'); }
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

  async openReleaseHistory(): Promise<void> {
    await this.newTab('development', PUBLIC_UPDATE_ENDPOINT + '/#release-history');
  }

  async checkForUpdatesInBackground(): Promise<void> {
    if (this.window.isDestroyed()) return;
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
    this.fillPicker.close();
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

  /**
   * The page the user is looking at. A New Tab page keeps the previous page's
   * view alive but hidden; nothing — navigation, find, extraction, fill — may
   * act on that hidden page while Home is showing (F-48).
   */
  private activeContents() {
    const tab = this.activeTab(this.store.get());
    if (tab.isHome) return undefined;
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
    // A locked Account Space gets no page view at all: its cookies stay unused
    // until the user unlocks it.
    if (this.store.get().accountSpaces.find((account) => account.id === tab.accountSpaceId)?.locked) {
      throw new Error('This Account Space is locked');
    }
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
    // Every guard is attached before anything below that could throw: a view
    // that exists without them would run a hostile page with no popup,
    // navigation or tab-tracking control for its whole life (F-28).
    const popupTimes: number[] = [];
    // `popup` is set when the request comes from a popup window this tab opened.
    const openFromPage = ({ url, disposition }: HandlerDetails, popup?: BrowserWindow): WindowOpenHandlerResponse => {
      if (agentHost?.isLentContents(view.webContents.id)) return { action: 'deny' };
      if (tab.workspaceId === 'banking') {
        this.addPrivacyEvent('blocked', 'Popup blocked in Banking', 'Banking pages cannot open new tabs');
        return { action: 'deny' };
      }
      if (!isAllowedRemoteUrl(url)) return { action: 'deny' };
      const now = Date.now();
      while (popupTimes.length && now - popupTimes[0]! > POPUP_WINDOW_MS) popupTimes.shift();
      if (popupTimes.length >= MAX_POPUPS_PER_WINDOW) {
        this.addPrivacyEvent('blocked', 'Popups blocked', `${urlOriginForSharing(url)} opened too many windows`);
        return { action: 'deny' };
      }
      popupTimes.push(now);
      // Only the page the user is looking at may take the foreground; a hidden
      // or background tab's popup is added behind the current one (F-31).
      const opener = this.activeTab(this.store.get());
      const inForeground = popup
        ? !popup.isDestroyed() && popup.isFocused()
        : opener.id === tabId && view.getVisible() && !this.window.isDestroyed() && this.window.isFocused();
      if (inForeground && wantsPopupWindow(disposition)) return popupWindowResponse(this.window);
      if (inForeground) void this.newTab(tab.workspaceId, stripTrackingParameters(url), tab.accountSpaceId);
      else this.addBackgroundTab(tab.workspaceId, stripTrackingParameters(url), tab.accountSpaceId);
      return { action: 'deny' };
    };
    view.webContents.setWindowOpenHandler((details) => openFromPage(details));
    view.webContents.on('did-create-window', (child) => adoptPopupWindow(child, (window) => (details) => openFromPage(details, window)));
    guardPageNavigation(view.webContents);
    view.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      if (runtime.problem && !this.overlayOpen && this.activeTab(this.store.get()).id === tabId) view.setVisible(true);
      runtime.navigationGeneration += 1;
      runtime.certificateError = false;
      runtime.problem = undefined;
      runtime.failedUrl = undefined;
      runtime.automaticFillGeneration = undefined;
      runtime.automaticFillPending = false;
      this.fillCapabilities.invalidateTab(tabId);
      if (this.fillPicker.context?.tabId === tabId) this.fillPicker.close();
      this.secureDialogs.closeAll();
    });
    view.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (!isMainFrame || !isAllowedRemoteUrl(url)) return;
      const problem = problemForFailedLoad(code, runtime.certificateError);
      if (problem) this.markTabProblem(tabId, problem, url);
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
      if (tab.workspaceId === 'banking') return;
      const contents = view.webContents;
      const generation = runtime.navigationGeneration;
      showPageContextMenu(this.window, contents, params,
        () => !this.window.isDestroyed() && !contents.isDestroyed() && view.getVisible()
          && runtime.navigationGeneration === generation && this.activeTab(this.store.get()).id === tabId,
        (url) => this.addBackgroundTab(tab.workspaceId, url, tab.accountSpaceId),
        () => Boolean(this.developerTarget(tabId)));
    });
    view.webContents.on('before-input-event', (event, input) => {
      if (!agentHost?.isLentContents(view.webContents.id) && this.handleFillPickerKey(tabId, event, input)) return;
      this.handleShortcut(event, input);
    });
    // Only genuine user input opens the login picker; nothing the page does can.
    view.webContents.on('input-event', (_event, input) => {
      if (agentHost?.isLentContents(view.webContents.id)) return;
      if (input.type === 'mouseWheel' || input.type === 'gestureScrollBegin') this.fillPicker.close();
      if (input.type !== 'mouseDown') return;
      this.fillPicker.close();
      if ((input as Electron.MouseInputEvent).button === 'left') this.scheduleFillPickerProbe(tabId);
    });
    view.webContents.on('audio-state-changed', () => this.broadcast());
    // Electron only reports Ctrl+wheel and touchpad pinch; applying the step is the embedder's job.
    // One wheel notch reports twice and a pinch reports a burst, so take at most one step per window.
    let lastWheelZoom = 0;
    view.webContents.on('zoom-changed', (_event, direction) => {
      const now = Date.now();
      if (now - lastWheelZoom < WHEEL_ZOOM_INTERVAL_MS) return;
      lastWheelZoom = now;
      this.stepZoom(view.webContents, direction);
    });
    view.webContents.on('found-in-page', (_event, result) => {
      if (this.activeTab(this.store.get()).id !== tabId || this.window.isDestroyed()) return;
      this.window.webContents.send('browser:find-result', { tabId, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal, finalUpdate: result.finalUpdate });
    });
    view.webContents.on('enter-html-full-screen', () => {
      if (this.window.isDestroyed() || this.window.isFullScreen()) return;
      this.htmlFullscreenOwner = tabId;
      this.window.setFullScreen(true);
    });
    view.webContents.on('leave-html-full-screen', () => {
      if (this.window.isDestroyed() || this.htmlFullscreenOwner !== tabId) return;
      this.htmlFullscreenOwner = undefined;
      this.window.setFullScreen(false);
    });
    view.webContents.on('render-process-gone', () => this.markTabProblem(tabId, 'crashed'));
    if (canInstallPasskeyProvider(tab.workspaceId, passkeyOriginFor(tab.url), this.passkeyOptIns, false)) {
      void this.passkeyController.installAtDocumentStart(view.webContents).catch(() => this.passkeyController.detach(view.webContents));
    }
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
    const spelling = settingsForWorkspace(this.store.get(), workspaceId).spellcheck;
    if (spelling) this.applySpellcheck(ses, spelling);
    const protectedWorkspace = WORKSPACES.find((workspace) => workspace.id === workspaceId)!.protected;
    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      if (protectedWorkspace || !details.isMainFrame || agentHost?.isLentContents(_webContents?.id)) {
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
      if (protectedWorkspace || !details.isMainFrame || agentHost?.isLentContents(_webContents?.id)) return false;
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
        || agentHost?.isLentContents(activeView?.webContents.id)
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
    ses.webRequest.onBeforeRequest((details, callback) => callback({
      cancel: this.isBlockedTrackerRequest(details.url) || agentHost?.allowLentRequest(details) === false,
    }));
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } });
    });
    ses.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400) this.recordNetworkIssue(details);
    });
    ses.webRequest.onErrorOccurred((details) => this.recordNetworkIssue(details));
    ses.on('will-download', (event, item, sourceContents) => {
      if (agentHost?.isLentContents(sourceContents?.id)) { event.preventDefault(); return; }
      if (protectedWorkspace) {
        event.preventDefault();
        this.addPrivacyEvent('blocked', 'Download blocked in Banking', 'Banking does not allow saving downloads');
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
      const filename = item.getFilename();
      const entry: LocalDownload = {
        id,
        accountSpaceId,
        filename,
        origin: isAllowedRemoteUrl(item.getURL()) ? new URL(item.getURL()).origin : undefined,
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
        risk: downloadRisk(filename),
        extension: downloadExtension(filename),
        expectedInstaller: this.expectedInstaller?.filename === filename ? this.expectedInstaller : undefined,
      };
      this.downloads.set(id, entry);
      this.downloadItems.set(id, item);
      this.updateDownloadProgress(entry, item, 'progressing');
      item.on('updated', (_downloadEvent, state) => {
        this.updateDownloadProgress(entry, item, state);
        this.broadcast();
      });
      item.once('done', (_downloadEvent, state) => {
        this.downloadItems.delete(id);
        if (this.downloads.get(id) !== entry) return;
        Object.assign(entry, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state, savePath: item.getSavePath(),
          finishedAt: new Date().toISOString(), paused: false, canPause: false, canResume: false, canCancel: false });
        if (entry.savePath) {
          const savedFilename = basename(entry.savePath);
          entry.risk = downloadRisk(savedFilename);
          entry.extension = downloadExtension(savedFilename);
        }
        if (!this.store.isReadOnly()) {
          const path = state === 'completed' ? entry.savePath : undefined;
          const stamp = path ? downloadFileStamp(path) : undefined;
          try {
            entry.retained = this.downloadHistory.record(accountSpaceId, { entry, file: path && stamp ? { path, stamp } : undefined });
            this.downloadHistoryFailures.delete(accountSpaceId);
          } catch {
            this.downloadHistoryFailures.add(accountSpaceId);
          }
        }
        if (state === 'completed' && entry.savePath && entry.expectedInstaller) void this.verifyInstallerDownload(entry, entry.savePath);
        else this.broadcast();
      });
      this.broadcast();
    });
  }

  private async showActiveTab(): Promise<void> {
    if (this.startingWindow) return;
    const state = this.store.get();
    const tab = this.activeTab(state);
    const locked = state.accountSpaces.find((account) => account.id === tab.accountSpaceId)?.locked;
    if (!locked && !tab.isHome && !tab.restorePaused && !this.runtimeTabs.get(tab.id)?.problem && this.startupTabRecovery?.accountSpaceId !== tab.accountSpaceId && isAllowedRemoteUrl(tab.url)) {
      const view = this.ensureView(tab.id);
      view.setVisible(true);
      this.applyLayout();
      // A navigation already in flight has no committed URL yet; loading again
      // would abort it with ERR_ABORTED (-3), so only start one when idle.
      if (!view.webContents.getURL() && !view.webContents.isLoading()) {
        try { await view.webContents.loadURL(tab.url); }
        catch (error) {
          const cancelled = error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED';
          if (!cancelled && !this.runtimeTabs.get(tab.id)?.problem && !this.window.isDestroyed()) throw error;
        }
      }
      this.scheduleAutomaticFill(tab.id);
    }
    // A Home tab skips `applyLayout`, and a switch into Banking must still hide the side app.
    this.layoutSideApps();
    this.broadcast();
  }

  private isBlockedTrackerRequest(url: string): boolean {
    if (!this.store.get().trackerBlocking) return false;
    try {
      const hostname = new URL(url).hostname;
      return TRACKER_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
    } catch {
      return false;
    }
  }

  private hideAllViews(): void {
    this.fillPicker.close();
    for (const runtime of this.runtimeTabs.values()) {
      runtime.view?.webContents.closeDevTools();
      runtime.view?.setVisible(false);
    }
  }

  /**
   * Apply now and again once the frame has settled. Window-state events also
   * re-broadcast then, because `isFullScreen()`/`isMaximized()` can still report
   * the previous state while the event is being delivered.
   */
  private scheduleLayout(windowStateChanged = false): void {
    this.fillPicker.close();
    this.applyLayout();
    this.settleBroadcast ||= windowStateChanged;
    if (this.settleLayoutTimer) clearTimeout(this.settleLayoutTimer);
    this.settleLayoutTimer = setTimeout(() => {
      this.settleLayoutTimer = undefined;
      if (this.window.isDestroyed()) return;
      this.applyLayout();
      if (this.settleBroadcast) {
        this.settleBroadcast = false;
        this.broadcast();
      }
    }, 80);
  }

  private applyLayout(): void {
    this.layoutSideApps();
    const state = this.store.get();
    const active = this.activeTab(state);
    const runtime = this.runtimeTabs.get(active.id);
    if (!runtime?.view || active.isHome || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    // Full screen hides every piece of chrome, so the page owns the whole window.
    const insets = this.window.isFullScreen() ? ZERO_INSETS : this.layout;
    runtime.view.setBounds(contentBounds(insets, width, height));
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
      this.rememberBookmarkIcon(tabId, cached);
      this.updateRuntime(tabId, { favicon: cached });
      return;
    }
    if (!isAllowedRemoteUrl(url)) return;
    try {
      const response = await ses.fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'follow' });
      if (!response.ok) return;
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!FAVICON_TYPES.has(type)) return;
      // The page chooses this URL: the size limit is applied while reading, not
      // after the whole body is in memory (F-71).
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_FAVICON_BYTES) { void response.body?.cancel(); return; }
      const bytes = await readAtMost(response, MAX_FAVICON_BYTES);
      // The icon rides along in every state broadcast, so keep it small.
      if (!bytes?.byteLength) return;
      const dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
      if (this.faviconCache.size >= 200) this.faviconCache.delete(this.faviconCache.keys().next().value!);
      this.faviconCache.set(cacheKey, dataUrl);
      this.rememberBookmarkIcon(tabId, dataUrl);
      this.updateRuntime(tabId, { favicon: dataUrl });
    } catch {
      // A site without a reachable icon is ordinary, not an error worth showing.
    }
  }

  /**
   * Keep a fetched favicon on disk when the tab's host is bookmarked in the
   * tab's own Account Space, so the bookmark shows it after the tab closes.
   * The icon was already fetched for a page the user opened; this never fetches.
   */
  private rememberBookmarkIcon(tabId: string, dataUrl: string): void {
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || tab.isHome || this.store.isReadOnly()) return;
    const bookmarks = state.bookmarks.filter((item) => item.accountSpaceId === tab.accountSpaceId);
    const icons = rememberBookmarkIcon(state.bookmarkIconsByAccountSpace[tab.accountSpaceId], bookmarks, tab.url, dataUrl);
    if (!icons) return;
    try {
      this.store.update((next) => { next.bookmarkIconsByAccountSpace[tab.accountSpaceId] = icons; });
    } catch {
      // A missed icon is cosmetic; the live tab still shows it.
    }
  }

  private updateRuntime(tabId: string, patch: Partial<RuntimeTab>): void {
    const runtime = this.runtimeTabs.get(tabId);
    if (!runtime) return;
    Object.assign(runtime, patch);
    if (runtime.view && !runtime.view.webContents.isDestroyed()) {
      runtime.canGoBack = runtime.view.webContents.navigationHistory.canGoBack();
      runtime.canGoForward = runtime.view.webContents.navigationHistory.canGoForward();
    }
    this.broadcast();
  }

  private markTabProblem(tabId: string, problem: TabProblem, failedUrl?: string): void {
    const runtime = this.runtimeTabs.get(tabId);
    if (!runtime) return;
    runtime.view?.setVisible(false);
    this.fillCapabilities.invalidateTab(tabId);
    if (this.fillPicker.context?.tabId === tabId) this.fillPicker.close();
    this.updateRuntime(tabId, { problem, failedUrl, loading: false });
  }

  private commitNavigation(tabId: string, url: string, addHistory = true): void {
    if (!isAllowedRemoteUrl(url)) return;
    const sanitizedUrl = stripTrackingParameters(url);
    if (isProtectedPage(sanitizedUrl)) this.runtimeTabs.get(tabId)?.view?.webContents.closeDevTools();
    this.store.update((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      // A Home tab's hidden view can still finish a load started before Home was
      // chosen. Every deliberate navigation clears `isHome` before it loads, so a
      // commit arriving while it is set is stale and must not leave Home.
      if (!tab || tab.isHome) return;
      tab.url = sanitizedUrl;
      if (addHistory && tab.workspaceId !== 'banking') {
        state.history.unshift({ id: randomUUID(), title: tab.title, url: sanitizedUrl, workspaceId: tab.workspaceId, accountSpaceId: tab.accountSpaceId, visitedAt: new Date().toISOString() });
        for (const removed of state.history.splice(2500)) {
          (state.historyTrimmedByAccountSpace ??= {})[removed.accountSpaceId] = true;
        }
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

  private async copySensitiveValue(value: string): Promise<void> {
    const account = this.activeAccountSpaceId(this.store.get());
    try {
      await this.clipboardGuard.copy(value, () => {
        if (clipboardQuit !== 'not-started' || this.activeAccountSpaceId(this.store.get()) !== account
          || !this.activeVaultPolicy().passwordClipboard || this.vault.status().lifecycle !== 'unlocked') {
          throw new Error('The Account Space changed.');
        }
      });
    } catch {
      throw new Error('The vault could not protect and write to the clipboard.');
    }
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
    if (input.control && input.shift && !input.alt && !input.meta && (input.code === 'Period' || input.key === '>')) {
      event.preventDefault();
      agentHost?.stop();
      return;
    }
    // Esc leaves window full screen (F11) the way it leaves page full screen.
    if (input.key === 'Escape' && !this.window.isDestroyed() && this.window.isFullScreen() && !this.htmlFullscreenOwner && !input.control && !input.alt && !input.shift && !input.meta) {
      this.window.setFullScreen(false);
      return;
    }
    const shortcut = resolveShortcut({ key: input.key, control: input.control, meta: input.meta, shift: input.shift, alt: input.alt });
    if (!shortcut || this.window.isDestroyed()) return;
    event.preventDefault();
    if (needsChromeFocus(shortcut.command)) this.window.webContents.focus();
    this.window.webContents.send('browser:command', shortcut);
  }
}

let controller: BrowserController | undefined;
let vscodeBridge: VscodeBridgeServer | undefined;
let agentHost: AgentHost | undefined;
const AGENT_WORKSPACE_Ipc = new Set(['agents:status', 'agents:decide', 'agents:stop', 'agents:select', 'agents:manual', 'agents:close-tab', 'agents:renew', 'agents:clear-open-web']);
const pendingLaunchUrls: string[] = [];
let launchWindowReady = false;
let processingLaunchUrls = false;

function queueSystemLink(url: string): void {
  if (!isAllowedRemoteUrl(url) || pendingLaunchUrls.length >= 20) return;
  pendingLaunchUrls.push(url);
  void openPendingSystemLinks();
}

async function openPendingSystemLinks(): Promise<void> {
  if (!launchWindowReady || processingLaunchUrls || !controller) return;
  processingLaunchUrls = true;
  try {
    for (let url = pendingLaunchUrls.shift(); url; url = pendingLaunchUrls.shift()) {
      try {
        await controller.openSystemLink(url);
      } catch {
        // A failed load must not prevent the next system link from opening.
      }
    }
  } finally {
    processingLaunchUrls = false;
  }
}

const initialUrl = process.argv.find(isAllowedRemoteUrl);
if (initialUrl) queueSystemLink(initialUrl);
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
    if (url) queueSystemLink(url);
    controller?.focus();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    queueSystemLink(url);
  });
}

function assertTrusted(event: IpcMainInvokeEvent, channel: string): void {
  const agentWindow = agentHost?.workspace.isTrustedSender(event);
  if (agentWindow && AGENT_WORKSPACE_Ipc.has(channel)) return;
  if (channel === 'agents:decide' || !controller?.isTrustedSender(event)) throw new Error('Untrusted IPC sender');
}

const ipcGuard = new IpcGuard();

function handle<TArgs extends unknown[], TResult>(channel: string, callback: (event: IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrusted(event, channel);
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
  // Cookies left in a legacy partition no Account Space owns any more (after a
  // confirmed fresh start) are cleared rather than kept with no way to reach them.
  for (const key of store.orphanedLegacyPartitions()) {
    if (!existsSync(join(userDataPath, 'Partitions', key.slice('persist:'.length)))) continue;
    const orphan = session.fromPartition(key);
    await orphan.clearStorageData().catch(() => undefined);
    await orphan.clearCache().catch(() => undefined);
  }
  const vault = new VaultBroker(new MyVaultDiskStore(userDataPath, safeStorage));
  const fillPreferences = new FillPreferenceStore(join(userDataPath, 'myvault', 'fill-preferences-v2.enc'), safeStorage);
  vault.initialize();
  const aiProvider = new AiProviderStore(join(userDataPath, 'ai-provider.enc'));
  const updates = new UpdateServiceStore(join(userDataPath, 'update-service.enc'));
  const controlCenter = new ControlCenterLink({ filePath: join(userDataPath, 'control-center-link.enc'), storage: safeStorage });
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
  controller = new BrowserController(store, persistedState, accountStore, googleConfiguration, externalBrowsers, googleOAuth, googleServices, backups, vault, migration, aiProvider, updates, vscodeBridge, controlCenter, fillPreferences);
  const agentChromeUrl = new URL(process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(join(import.meta.dirname, '../dist/index.html')));
  agentChromeUrl.hash = 'agent-workspace';
  agentHost = new AgentHost({
    data: join(userDataPath, 'agent-mode'),
    rendezvous: !app.isPackaged && process.env.PRIVATE_BROWSER_AGENT_DATA_DIR || agentDataRoot(),
    chromeUrl: agentChromeUrl.href,
    preload: join(import.meta.dirname, 'preload.cjs'),
    command: app.isPackaged ? join(process.resourcesPath, 'private-browser-agent', 'private-browser-mcp.cmd') : 'node',
    commandArgs: app.isPackaged ? [] : [join(import.meta.dirname, '../packages/agent-mcp/dist/cli.js')],
    parent: () => controller?.agentParent(),
    onChange: () => controller?.notifyAgentChange(),
  });

  handle('browser:get-state', () => controller!.getSnapshot());
  handle('agents:status', () => agentHost!.status());
  handle('agents:enable', (_event, enabled: boolean) => agentHost!.enable(enabled));
  handle('agents:pair', () => agentHost!.beginPairing());
  handle('agents:stop', () => agentHost!.stop());
  handle('agents:resume', () => agentHost!.resume());
  handle('agents:open-workspace', () => agentHost!.workspace.show());
  handle('agents:revoke', (_event, id: string) => agentHost!.revoke(id));
  handle('agents:renew', (_event, id: string) => agentHost!.renew(id));
  handle('agents:set-space', (_event, id: string, settings: AgentSpaceSettings) => agentHost!.setSpace(id, settings));
  handle('agents:set-limits', (_event, id: string, limits: ClientLimits) => agentHost!.setLimits(id, limits));
  handle('agents:clear-open-web', (_event, id: string) => agentHost!.clearOpenWeb(id));
  handle('agents:grant-uploads', (_event, id: string) => agentHost!.grantUploadFolder(id));
  handle('agents:revoke-uploads', (_event, id: string) => agentHost!.revokeUploadFolder(id));
  handle('agents:add-space', (_event, name: string) => agentHost!.addSpace(name));
  handle('agents:reset-space', (_event, id: string) => agentHost!.resetSpace(id));
  handle('agents:clear-audit', () => agentHost!.clearAudit());
  handle('agents:export-audit', () => agentHost!.exportAudit());
  handle('agents:decide', (_event, id: string, decision: AgentDecision) => agentHost!.decide(id, decision));
  handle('agents:select', (_event, id: string) => agentHost!.workspace.select(id));
  handle('agents:manual', (_event, id: string, manual: boolean) => agentHost!.workspace.setManual(id, manual));
  handle('agents:close-tab', (_event, id: string) => agentHost!.workspace.close(id));
  handle('agents:lend-tab', (_event, tabId: string, clientId: string) => controller!.lendAgentTab(tabId, clientId));
  handle('agents:return-tab', () => agentHost!.returnLentTab());
  handle('routines:save', (_event, routine: BrowserRoutine) => controller!.saveRoutine(routine));
  handle('routines:save-tabs', (_event, input: TabSetInput) => controller!.saveTabSet(input));
  handle('routines:open-reference', (_event, input: ReferenceSearchInput) => controller!.openReferenceSearch(input));
  handle('routines:delete', (_event, id: string) => controller!.deleteRoutine(id));
  handle('routines:run', (_event, id: string) => controller!.runRoutine(id));
  handle('routines:mark-checklist', (_event, id: string, index: number, done: boolean) => controller!.updateRoutineChecklist(id, index, done));
  handle('routines:reset-checklist', (_event, id: string) => controller!.updateRoutineChecklist(id));
  handle('browser:navigate', (_event, value: string) => controller!.navigate(value));
  handle('browser:home', () => controller!.goHome());
  handle('browser:back', () => controller!.goBack());
  handle('browser:forward', () => controller!.goForward());
  handle('browser:reload', () => controller!.reload());
  handle('browser:restore-selected-tabs', (_event, ids: string[]) => controller!.restoreSelectedTabs(ids));
  handle('browser:stop', () => controller!.stop());
  handle('browser:new-tab', (_event, workspaceId?: WorkspaceId, url?: string, accountSpaceId?: AccountSpaceId) => controller!.newTab(workspaceId, url, accountSpaceId));
  handle('browser:close-tab', (_event, id: string) => controller!.closeTab(id));
  handle('browser:activate-tab', (_event, id: string) => controller!.activateTab(id));
  handle('browser:switch-workspace', (_event, id: WorkspaceId) => controller!.switchWorkspace(id));
  handle('browser:switch-account-space', (_event, id: AccountSpaceId) => controller!.switchAccountSpace(id));
  handle('browser:address-matches', (_event, account: AccountSpaceId, text: string) => controller!.addressMatches(account, text));
  handle('browser:query-history', (_event, account: AccountSpaceId, input: HistoryQuery) => controller!.retainedHistory(account, input));
  handle('browser:review-browsing-data', (_event, input: BrowsingDataInput) => controller!.reviewBrowsingData(input));
  handle('browser:delete-reviewed-data', (_event, id: string) => controller!.deleteReviewedBrowsingData(id));
  handle('browser:delete-history-visit', (_event, account: AccountSpaceId, id: string) => controller!.deleteHistoryVisit(account, id));
  handle('browser:open-address-match', (_event, account: AccountSpaceId, source: AddressMatch['source'], id: string) => controller!.openAddressMatch(account, source, id));
  handle('accounts:add-local', (_event, workspaceId: WorkspaceId, label: string, color: AccountSpaceColor) => controller!.addLocalAccountSpace(workspaceId, label, color));
  handle('accounts:update', (_event, id: AccountSpaceId, label?: string, color?: AccountSpaceColor) => controller!.updateAccountSpace(id, label, color));
  handle('accounts:reorder', (_event, workspaceId: WorkspaceId, ids: AccountSpaceId[]) => controller!.reorderAccountSpaces(workspaceId, ids));
  handle('accounts:open-in', (_event, id: AccountSpaceId, url: string) => controller!.openInAccountSpace(id, url));
  handle('accounts:set-locked', (_event, id: AccountSpaceId, locked: boolean) => controller!.setAccountSpaceLocked(id, locked));
  handle('accounts:disconnect-google', (_event, id: AccountSpaceId, revoke?: boolean) => controller!.disconnectGoogleAccount(id, revoke));
  handle('accounts:clear-data', (_event, id: AccountSpaceId) => controller!.clearAccountSpaceData(id));
  handle('accounts:delete', (_event, id: AccountSpaceId, confirmation: string) => controller!.deleteAccountSpace(id, confirmation));
  handle('permissions:respond', (_event, promptId: string, decision: PermissionDecision, displaySourceId?: string) => controller!.respondToPermissionPrompt(promptId, decision, displaySourceId));
  handle('permissions:site', (_event, tabId: string, origin: string) => controller!.getSitePermissions(tabId, origin));
  handle('permissions:revoke-site', (_event, tabId: string, origin: string, capability: PermissionCapability) => controller!.revokeSitePermission(tabId, origin, capability));
  handle('permissions:list-account', (_event, id: AccountSpaceId) => controller!.listAccountPermissionGrants(id));
  handle('google:configure', (_event, clientId: string) => controller!.configureGoogle(clientId));
  handle('google:clear-configuration', () => controller!.clearGoogleConfiguration());
  handle('google:connection-health', (_event, id: AccountSpaceId) => controller!.getGoogleConnectionHealth(id));
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
  handle('side-app:set-bounds', (_event, id: SideAppId, rect: SideAppRect | null) => controller!.setSideAppBounds(id, rect));
  handle('side-app:command', (_event, id: SideAppId, command: SideAppCommand) => controller!.sideAppCommand(id, command));
  handle('side-app:clear-data', (_event, id: SideAppId) => controller!.clearSideAppData(id));
  handle('browser:toggle-bookmark', () => controller!.toggleBookmark());
  handle('browser:open-bookmark', (_event, id: string) => controller!.openBookmark(id));
  handle('browser:open-bookmarks-in-background', (_event, account: AccountSpaceId, ids: string[]) => controller!.openBookmarksInBackground(account, ids));
  handle('browser:toggle-bookmark-bar', () => controller!.toggleBookmarkBar());
  handle('ui:set-preferences', (_event, patch: UiPreferencesPatch) => controller!.setUiPreferences(patch));
  handle('settings:set', (_event, patch: BrowserSettingsPatch, workspace?: WorkspaceId) => controller!.setBrowserSettings(patch, workspace));
  handle('browser:freeze-content', () => controller!.freezeContent());
  handle('browser:move-tab', (_event, tabId: string, toIndex: number) => controller!.moveTab(tabId, toIndex));
  handle('browser:organize-tab', (_event, action: TabOrganizationAction) => controller!.organizeTab(action));
  handle('browser:duplicate-tab', (_event, id: string) => controller!.duplicateTab(id));
  handle('browser:close-tab-batch', (_event, id: string, scope: TabBatchScope, ids: string[]) => controller!.closeTabBatch(id, scope, ids));
  handle('browser:undo-tab-batch', () => controller!.undoTabBatch());
  handle('browser:reopen-closed-tab', () => controller!.reopenClosedTab());
  handle('browser:reopen-recent-tab', (_event, id: string) => controller!.reopenClosedTab(id));
  handle('browser:zoom', (_event, direction: 'in' | 'out' | 'reset') => controller!.zoom(direction));
  handle('browser:print', () => controller!.print());
  handle('browser:find', (_event, text: string, forward: boolean, findNext: boolean) => controller!.findInPage(text, forward, findNext));
  handle('browser:stop-find', () => controller!.stopFindInPage());
  handle('browser:set-tab-muted', (_event, tabId: string, muted: boolean) => controller!.setTabMuted(tabId, muted));
  handle('browser:hard-reload', () => controller!.hardReload());
  handle('browser:toggle-fullscreen', () => controller!.toggleFullscreen());
  handle('bookmarks:move', (_event, level: BookmarkLevelInput, key: BookmarkEntryKeyInput, toIndex: number) => controller!.moveBookmark(level, key, toIndex));
  handle('bookmarks:rename', (_event, id: string, title: string) => controller!.renameBookmark(id, title));
  handle('bookmarks:remove', (_event, id: string) => controller!.removeBookmark(id));
  handle('bookmarks:edit-address', (_event, id: string, url: string) => controller!.updateBookmarkAddress(id, url));
  handle('bookmarks:change-many', (_event, id: AccountSpaceId, ids: string[], destination?: BookmarkLevelInput) => controller!.changeBookmarks(id, ids, destination));
  handle('bookmarks:undo-many', (_event, id: AccountSpaceId) => controller!.undoBookmarks(id));
  handle('bookmarks:rename-folder', (_event, level: BookmarkLevelInput, name: string, nextName: string) => controller!.renameBookmarkFolder(level, name, nextName));
  handle('bookmarks:remove-folder', (_event, level: BookmarkLevelInput, name: string) => controller!.removeBookmarkFolder(level, name));
  handle('bookmarks:export', () => controller!.exportBookmarks());
  handle('bookmarks:import-html', (_event, accountSpaceId: AccountSpaceId) => controller!.importBookmarkHtml(accountSpaceId));
  handle('shortcuts:set', (_event, accountSpaceId: AccountSpaceId, tiles: ShortcutTile[] | null) => controller!.setShortcutTiles(accountSpaceId, tiles));
  handle('app:quit', () => { app.quit(); });
  handle('browser:list-chrome-profiles', () => controller!.listChromeProfiles());
  handle('browser:import-chrome', (_event, options: ChromeImportOptions) => controller!.importChrome(options));
  handle('browser:preview-chrome-import', (_event, options: ChromeImportOptions) => controller!.previewChromeImport(options));
  handle('browser:confirm-chrome-import', (_event, id: string) => controller!.confirmChromeImport(id));
  handle('browser:discard-chrome-import', (_event, id: string) => controller!.discardChromeImport(id));
  handle('browser:can-undo-chrome-import', (_event, id: AccountSpaceId) => controller!.canUndoChromeImport(id));
  handle('browser:undo-chrome-import', (_event, id: AccountSpaceId) => controller!.undoChromeImport(id));
  handle('vault:review-chrome-passwords', () => controller!.reviewChromePasswords());
  handle('vault:import-reviewed-chrome-passwords', (_event, id: string) => controller!.importReviewedChromePasswords(id));
  handle('vault:discard-chrome-password-review', (_event, id: string) => controller!.discardChromePasswordReview(id));
  handle('browser:toggle-tracker-blocking', () => controller!.toggleTrackerBlocking());
  handle('browser:open-download', (_event, id: string) => controller!.openDownload(id));
  handle('browser:control-download', (_event, id: string, action: DownloadAction) => controller!.controlDownload(id, action));
  handle('browser:show-download', (_event, id: string) => controller!.showDownload(id));
  handle('browser:set-download-history', (_event, accountId: AccountSpaceId, enabled: boolean) => controller!.setDownloadHistory(accountId, enabled));
  handle('browser:remove-download-entry', (_event, accountId: AccountSpaceId, id: string) => controller!.removeDownloadEntry(accountId, id));
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
  handle('control-center:status', () => controller!.controlCenterStatus());
  handle('control-center:pair', (_event, code: string) => controller!.pairControlCenter(code));
  handle('control-center:disconnect', () => controller!.disconnectControlCenter());
  handle('control-center:repositories', () => controller!.controlCenterRepositories());
  handle('control-center:tasks', () => controller!.controlCenterTasks());
  handle('control-center:send', (_event, input: ControlCenterSendInput) => controller!.sendToControlCenter(input));
  handle('control-center:recheck', (_event, input: ControlCenterRecheckInput) => controller!.recheckControlCenterTask(input));
  handle('ai:prepare-preview', (_event, scope?: AiPreviewScope) => controller!.prepareAiPreview(scope));
  handle('ai:prepare-source', (_event, id: string, tabId: string) => controller!.prepareAssistantSource(id, tabId));
  handle('ai:review-request', (_event, id: string, text: string, question: string, withEvidence?: boolean, edits?: AssistantSelectionEdit[]) => controller!.reviewAssistantRequest(id, text, question, withEvidence, edits));
  handle('ai:send-reviewed', (_event, id: string) => controller!.askReviewedAssistant(id));
  handle('ai:cancel-reviewed', (_event, id: string) => controller!.cancelReviewedAssistant(id));
  handle('ai:set-space-cloud', (_event, accountId: AccountSpaceId, allowed: boolean) => controller!.setAssistantCloudAllowed(accountId, allowed));
  handle('ai:approve-preview', (_event, previewId: string, mode?: 'local' | 'cloud') => controller!.approveAiPreview(previewId, mode));
  handle('ai:provider-status', () => controller!.getAiProvider());
  handle('ai:check-provider', () => controller!.checkAiProvider());
  handle('ai:local-models', () => controller!.localAiModels());
  handle('ai:configure-provider', (_event, input: AiProviderInput) => controller!.configureAiProvider(input));
  handle('ai:clear-provider', () => controller!.clearAiProvider());
  handle('ai:ask', (_event, token: string, question: string) => controller!.askAi(token, question));
  handle('ai:revoke', () => controller!.revokeAiContext());
  handle('vault:list', () => controller!.listVault());
  handle('vault:request-unlock', () => controller!.requestVaultUnlock());
  handle('vault:hello-unlock', () => controller!.unlockVaultWithHello());
  handle('vault:hello-enable', () => controller!.enableVaultHello());
  handle('vault:hello-disable', () => controller!.disableVaultHello());
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
  handle('vault:check-health', (_event, accountId: AccountSpaceId) => controller!.checkVaultHealth(accountId));
  handle('vault:edit-health-login', (_event, accountId: AccountSpaceId, id: string) => controller!.editVaultHealthLogin(accountId, id));
  handle('vault:form-shape', () => controller!.inspectVaultFormShape());
  handle('vault:reset-picks', (_event, accountId: AccountSpaceId) => controller!.resetVaultPicks(accountId));
  handle('vault:fill-readiness', () => controller!.vaultFillReadiness());
  handle('vault:save-from-page', () => controller!.requestSaveFromPage());
  handle('vault:request-delete', (_event, id: string) => controller!.requestVaultDelete(id));
  handle('vault:acknowledge-recovery', () => controller!.acknowledgeVaultRecovery());
  handle('vault:copy-password', (_event, id: string) => controller!.copyPassword(id));
  handle('vault:copy-totp', (_event, id: string) => controller!.copyTotp(id));
  handle('vault:copy-generated', (_event, kind: GeneratedCredentialKind) => controller!.copyGeneratedCredential(kind));
  handle('vault:clipboard-deadline', () => controller!.vaultClipboardDeadline());
  handle('vault:clipboard-clear', () => controller!.clearVaultClipboard());
  handle('vault:autofill', (_event, id: string) => controller!.autofill(id));
  handle('system:copy', (_event, value: string) => clipboard.writeText(String(value).slice(0, 100_000)));
  handle('system:is-default-browser', () => controller!.isDefaultBrowser());
  handle('system:open-default-browser-settings', () => controller!.openDefaultBrowserSettings());
  handle('system:test-default-browser', () => controller!.testDefaultBrowser());
  handle('updates:status', () => controller!.getUpdateService());
  handle('updates:configure', (_event, input: UpdateServiceInput) => controller!.configureUpdateService(input));
  handle('updates:clear', () => controller!.clearUpdateService());
  handle('updates:check', () => controller!.checkForUpdates());
  handle('updates:open-page', () => controller!.openUpdatePage());
  handle('updates:open-history', () => controller!.openReleaseHistory());

  await controller.createWindow();
  await agentHost.start();
  setTimeout(() => void controller?.checkForUpdatesInBackground(), 10_000).unref();
  setInterval(() => void controller?.checkForUpdatesInBackground(), 24 * 60 * 60_000).unref();
  if (!pendingLaunchUrls.length) await controller.openStartupHome();
  launchWindowReady = true;
  await openPendingSystemLinks();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await controller!.createWindow();
  });
});

let clipboardQuit: 'not-started' | 'clearing' | 'done' = 'not-started';
app.on('before-quit', (event) => {
  if (clipboardQuit === 'clearing') {
    event.preventDefault();
    return;
  }
  agentHost?.stop();
  if (clipboardQuit === 'not-started' && controller?.secretClipboardPending) {
    event.preventDefault();
    clipboardQuit = 'clearing';
    void controller.flushClipboard().finally(() => {
      clipboardQuit = 'done';
      app.quit();
    });
    return;
  }
  void vscodeBridge?.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
