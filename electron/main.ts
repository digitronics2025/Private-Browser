import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
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
  powerMonitor,
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
import { availableDownloadFolder, discardDownloadStage, DownloadFolderStore, finishStagedDownload, safeDownloadFilename, stageDownload } from './download-folder.js';
import { ManagedUpdate } from './managed-update.js';
import { canPauseTrackersAt, TRACKER_COMPATIBILITY_MS, TrackerProtection, trackerCategory } from './tracker-protection.js';
import { BrowserSessionLock } from './browser-session-lock.js';
import { MAX_MEMORY_SAVER_EXCLUSIONS, MEMORY_SAVER_INTERVAL_MS, MEMORY_SAVER_PAGE_CHECK, mayReloadInactivePage, memorySaverOrigin, type MemorySaverPage } from './memory-saver.js';
import { getDomain } from 'tldts';
import { AiProviderStore } from './ai-provider.js';
import { AI_SYSTEM_PROMPT, MAX_ASSISTANT_CONTEXT, MAX_ASSISTANT_SOURCE_TEXT, assistantQuestion, aiUserPrompt, formatAssistantExcerpts, readAssistantAnswer } from './ai-prompt.js';
import { WORKSPACES } from './state-store.js';
import { AccountStore, MAX_ASSISTANT_RECEIPTS } from './account-store.js';
import { AccountSpaceStateStore } from './account-space-state.js';
import { sealBrowsingArchive, unsealBrowsingArchive } from './browsing-recovery.js';
import type { BrowsingPrivacyAction } from './browsing-protection.js';
import { agentStorageAvailable } from './agent-audit.js';
import { RuntimeStateStore } from './runtime-state-store.js';
import { problemForFailedLoad, StartupRestoreJournal } from './startup-restore.js';
import { keepTabBlockIndex, orderAccountTabs, organizeTabs, replaceAccountTabOrder, tabBatchTargets } from './tab-organization.js';
import { CHROME, contentBounds, DEFAULT_CONTENT_INSETS, FRAME_COLORS, sanitizeContentInsets, ZERO_INSETS, type ContentInsets } from './chrome-layout.js';
import { splitBounds, splitPageAllowed } from './split-view.js';
import { needsChromeFocus, resolveShortcut } from './shortcuts.js';
import { FAVICON_TYPES, MAX_FAVICON_BYTES, rememberBookmarkIcon } from './bookmark-icons.js';
import { appendBookmarkFolders, appendImportedBookmarks, createBookmarkFolder, editBookmarkFolder, exportBookmarksHtml, moveTabWithinAccountSpace, nextBookmarkOrder, removeBookmark, renameBookmark, reorderBookmarkLevel, undoImportedBookmarkFolders } from './bookmark-tree.js';
import { readBookmarkHtml } from './bookmark-html.js';
import { DEFAULT_BROWSER_SETTINGS, mergeBrowserSettings, nextZoomPercent, referenceSearchUrl, resolveHomeUrl, resolveWorkspaceNavigation, settingsForWorkspace, SPELLCHECK_LANGUAGES, spellingDictionary, type BrowserSettings, type BrowserSettingsPatch, type SpellcheckLanguage, type SpellcheckSettings } from './browser-settings.js';
import { browsingDataVisitIds, requireBrowsingDataInput } from './browsing-data.js';
import { DEFAULT_UI_PREFERENCES, isPinnablePanelTool, mergeUiPreferences, sanitizeAccountPanel, type PinnablePanelTool, type SidePanelTool, type UiPreferencesPatch } from './ui-preferences.js';
import { sanitizeShortcutTiles } from './account-space-state.js';
import type {
  AccountSpaceColor,
  AccountSpaceBrowserTab,
  AccountSpaceBookmark,
  AccountSpaceId,
  ExternalBrowserId,
  GoogleModule,
  VaultConflictSide,
  GmailReplyDraft,
  GoogleOperationResult,
  GoogleOverviewPage,
  GoogleOverviewService,
  AiApproval,
  AiPagePreview,
  PageExcerptReview,
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
  BookmarkFolder,
  BrowserSnapshot,
  BackupRestorePreview,
  BackupReminderDays,
  BackupUploadPreview,
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
  DownloadBatchStatus,
  DownloadByteProgress,
  DownloadFolderMode,
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
import { devServerStatusSchema, gitRevisionSchema, inspectionSourcePath, inspectionSourceSchema, localDevelopmentAddress, reportHistoryPageSchema, reportHistoryQuerySchema, reviewedPatchInputSchema, reviewedPatchResultSchema, testConfigurationSchema, testReportSchema, type ProjectInfo, type ProjectSummary } from '@private-browser/bridge-protocol';
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
import { MAX_WORDPRESS_SAVE_ORIGINS, WordPressLoginAttempt, wordPressLoginFlow } from './myvault/wordpress-save.js';
import { isSameSiteFillCandidate } from './myvault/site-match.js';
import { fillPickerBounds, type FillPickerChoice } from './myvault/fill-picker-model.js';
import { workspaceVaultPolicy } from './myvault/workspace-policy.js';
import { FILL_PICKER_MAX_ROWS, isAutomaticFillPageUrl, orderFillCandidates, selectAutomaticFillEntry } from './myvault/automatic-fill.js';
import { MyVaultSyncClient } from './myvault/vault-sync.js';
import { VaultSyncController, type VaultConflictResolution } from './myvault/sync-controller.js';
import type { VaultEntryDecision } from './myvault/conflict-items.js';
import type { PairDialogValue } from './myvault/secure-dialog-contract.js';
import { VaultMigrationService } from './myvault/vault-migration.js';
import { canInstallPasskeyProvider, InternalPasskeyController, type PasskeyOptIns } from './myvault/passkey-controller.js';
import { PlatformUnlockError, WindowsHelloSigner } from './myvault/windows-hello.js';
import { PUBLIC_UPDATE_ENDPOINT, UpdateServiceStore } from './update-service.js';
import { readUpdateBootstrap, removeUpdateBootstrap } from './update-bootstrap.js';
import { canUseDeveloperTools, makeDeveloperReport, sanitizeDiagnosticText, sanitizeDiagnosticUrl, trackNetworkFailure } from './developer-tools.js';
import { IpcGuard } from './ipc-guard.js';
import { clearAndVerifyAccountSession } from './account-session.js';
import { AccountPermissionManager } from './account-permissions.js';
import { GoogleConfigurationStore } from './google-config.js';
import { ExternalBrowserLauncher } from './external-browser.js';
import { GoogleOAuthManager } from './google-oauth.js';
import { GoogleTokenBroker } from './google-token-broker.js';
import { GoogleServices, type CalendarWriteInput, type DriveCreateInput, type GmailReplySource, type GmailSendInput } from './google-services.js';
import { GoogleActionReceipts } from './google-action-receipts.js';
import { GOOGLE_OVERVIEW_MAX_PAGES, googleOverviewModule } from './google-overview.js';
import { healthFromGoogleConnection, observeGoogleHealth } from './google-connection-health.js';
import type { GoogleConnectionHealth } from './types.js';
import { AccountBackupManager, backupRestoreRevision, backupUploadRevision, planBackupRestore, type BackupWriteResult } from './account-backup.js';
import { GoogleDriveAppDataTransport, GoogleDriveBookmarkTransport } from './google-backup-transport.js';
import { BookmarkSyncManager, type BookmarkSyncAction, type BookmarkSyncPreview, type BookmarkSyncStatus } from './bookmark-sync.js';
import { readBookmarkPairing, writeBookmarkPairing } from './bookmark-pairing-file.js';
import { bookmarkReplica, canSyncBookmark } from './bookmark-replica.js';
import { validateIpcArguments } from './ipc-contracts.js';
import { ControlCenterLink, developerEvidence } from './control-center-link.js';
import { aiSourceRevision, classifyAiSource, maySendAiPreviewToCloud, sameAiSource } from './ai-account-spaces.js';
import { googleWebsiteStatus, isKnownGoogleWebHost } from './google-website-status.js';
import { listChromeProfiles, readChromeProfile, type ChromeProfileData } from './chrome-importer.js';
import { chromeProfileKey, MAX_CHROME_PROFILE_RECEIPTS } from './chrome-profile-preferences.js';
import { chromeImportBookmarkStamp, chromeImportKey, planChromeImport } from './chrome-import-review.js';
import type { ChromeImportReview } from './types.js';
import { VscodeBridgeServer } from './vscode-bridge.js';
import { adoptPopupWindow, guardPageNavigation, PopupReview, popupWindowResponse, wantsPopupWindow } from './popup-windows.js';
import { TemporaryBrowsing } from './temporary-browsing.js';
import { blockInlinePdf, pdfResponse, ProtectedPdfPreview, type PdfDocumentStatus } from './pdf-preview.js';
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
import { notesStatus, type NotesDraftChoice, type NotesDraftReview, type NotesPanelCommand } from './notes-panel.js';
import { planBookmarkBatch } from './bookmark-batch.js';
import { changeBookmarkBatch, editBookmarkAddress, restoreBookmarkBatch, type BookmarkUndo } from './bookmark-maintenance.js';

interface AssistantCapture {
  preview: AiPagePreview;
  navigationGeneration: number;
}

interface RuntimeTab {
  pdf?: PdfDocumentStatus & { url: string };
  inlinePdfUrl?: string;
  view?: WebContentsView;
  memorySaver: MemorySaverPage;
  sleeping?: boolean;
  sleepPending?: boolean;
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
  wordPressAttempt?: WordPressLoginAttempt;
}

type Layout = ContentInsets;

const WHEEL_ZOOM_INTERVAL_MS = 100;
const MAX_CLOSED_TABS = 25;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 120;
const MENU_FREEZE_BUDGET_MS = 75;

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

type LocalDownload = DownloadEntry & { savePath?: string; expectedInstaller?: ExpectedInstaller; verifiedStamp?: string; retainedFileStamp?: string };

class BrowserController {
  private wordPressPrompt?: AbortController;
  private browsingPrivacyBusy = false;
  private downloadEnrollment?: AbortController;
  private bookmarkSyncRequest?: AbortController;
  private browsingDataReview?: { review: BrowsingDataReview; initiator: AccountSpaceId; visits: Set<string>; expiresAt: number };
  private pendingBackupRequest?: { accountSpaceId: AccountSpaceId; operationId: string };
  private backupRestoreReview?: { preview: BackupRestorePreview; items: ReturnType<typeof planBackupRestore>['items']; subject: string; revision: string; expiresAt: number };
  private backupUploadReview?: { id: string; accountSpaceId: AccountSpaceId; subject: string; etag: string | null; revision: string; expiresAt: number };
  private pendingChromePasswords?: { id: string; accountId: AccountSpaceId; path: string; digest: string; revision: string; expiresAt: number };
  private selectingChromePasswords = false;
  private readonly runtimeTabs = new Map<string, RuntimeTab>();
  private readonly contentsTabs = new Map<number, RuntimeTab>();
  private sweepingMemory = false;
  private readonly downloads = new Map<string, LocalDownload>();
  private readonly downloadItems = new Map<string, DownloadItem>();
  private readonly downloadProgressAccounts = new Set<AccountSpaceId>();
  private downloadProgressTimer?: ReturnType<typeof setTimeout>;
  private downloadProgressRevision = 0;
  private readonly downloadHistory = new DownloadHistoryStore(join(app.getPath('userData'), 'download-history'), safeStorage);
  private readonly downloadHistoryFailures = new Set<AccountSpaceId>();
  private readonly trackerProtection = new TrackerProtection();
  private readonly trackerExpiry = new Map<AccountSpaceId, Map<string, ReturnType<typeof setTimeout>>>();
  private trackerBroadcast?: ReturnType<typeof setTimeout>;
  private readonly downloadFolder = new DownloadFolderStore(join(app.getPath('userData'), 'download-folders'), safeStorage);
  private downloadFolderPickerOpen = false;
  private readonly temporaryPanelTools = new Map<AccountSpaceId, SidePanelTool>();
  private readonly configuredSessions = new Set<string>();
  private spellingLanguages?: SpellcheckLanguage[];
  private readonly pendingAiPreviews = new Map<string, { preview: AiPagePreview; expiresAt: number; navigationGeneration?: number; parentId?: string }>();
  private claudeExcerpt?: AssistantCapture & { expiresAt: number };
  private assistantReview?: AssistantCapture & { review: AiRequestReview; question: string; withEvidence: boolean; expiresAt: number; additional: AssistantCapture[]; excerpts: string[] };
  private notesDraft?: { review: NotesDraftReview; generation: number; url: string; delivering: boolean };
  private activeAssistant?: { id: string; mode: 'local' | 'cloud'; controller: AbortController };
  private readonly aiApprovals = new Map<string, { preview: AiPagePreview; mode: 'cloud' | 'local'; expiresAt: number }>();
  /** Previews the Developer panel built from diagnostics: the only ones the Control Center may receive. */
  private readonly developerPreviewIds = new Set<string>();
  private inspectedSource?: { reference: string; projectId: string; tabId: string; url: string; expiresAt: number };
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
  private readonly faviconRequests = new Map<string, Promise<string | undefined>>();
  private readonly operations = new Map<string, { accountSpaceId: AccountSpaceId; controller: AbortController }>();
  private readonly googleOverviewCursors = new Map<string, {
    accountSpaceId: AccountSpaceId; service: GoogleOverviewService; subject: string;
    token: string; page: number; timeMin: string; expiresAt: number; inUse?: boolean;
  }>();
  private readonly googleChecks = new Map<AccountSpaceId, GoogleConnectionHealth>();
  private readonly gmailReplySources = new Map<string, { accountSpaceId: AccountSpaceId; subject: string; source: GmailReplySource; expiresAt: number }>();
  private expectedInstaller?: ExpectedInstaller;
  private readonly sessionLock = new BrowserSessionLock(join(app.getPath('userData'), 'browser-session.lock'));
  private sessionLockWork = Promise.resolve();
  private readonly managedUpdate = new ManagedUpdate({
    directory: join(app.getPath('userData'), 'update-installers'),
    currentVersion: app.getVersion(),
    check: () => this.checkForUpdates(),
    request: (input, init) => this.updates.fetchInstaller(input, init),
    canUse: () => process.platform === 'win32' && Boolean(this.activeDownloadAccount()) && !this.store.isReadOnly(),
    openInstaller: (path) => shell.openPath(path),
    notify: () => this.broadcast(),
  });
  private layout: Layout = { ...DEFAULT_CONTENT_INSETS };
  private readonly closedTabs = new Map<AccountSpaceId, RecentlyClosedTab[]>();
  private readonly bookmarkUndo = new Map<AccountSpaceId, BookmarkUndo<AccountSpaceBookmark>>();
  private pendingChromeImport?: {
    id: string; accountSpaceId: AccountSpaceId; initiatingAccount: AccountSpaceId; source: ChromeProfileData; importKey: string; expiresAt: number;
    profileKey: string; settingsRevision?: string;
  };
  private readonly chromeImportUndo = new Map<AccountSpaceId, {
    profileKey: string; bookmarks: Map<string, string>; history: Set<string>; folders: BookmarkFolder[];
    settings?: { workspaceId: WorkspaceId; before: BrowserSettings; after: BrowserSettings };
  }>();
  private readonly closedTabBatches = new Map<AccountSpaceId, {
    entries: Array<{ tab: AccountSpaceBrowserTab; index: number }>;
    groups: TabGroup[];
    groupName?: string;
  }>();
  private startingWindow = true;
  private readonly splitPairs = new Map<AccountSpaceId, { leftTabId: string; rightTabId: string }>();
  private visibleSplitTabId?: string;
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
  private readonly temporaryBrowsing = new TemporaryBrowsing((id, url, title) => this.keepTemporaryBookmark(id, url, title));
  private readonly protectedPdf = new ProtectedPdfPreview();
  private readonly fillPicker: FillPicker = new FillPicker(() => this.window, { choose: (choice) => void this.handleFillPickerChoice(choice) });
  private readonly vaultSync: VaultSyncController;
  private readonly popupReview = new PopupReview();
  private vaultConflictOwner?: { id: string; account: AccountSpaceId };
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
    private readonly bookmarkSync: BookmarkSyncManager,
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
    setInterval(() => { void this.sleepInactiveTabs().catch(() => undefined); }, MEMORY_SAVER_INTERVAL_MS).unref();
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
    this.window.on('close', (event) => {
      try {
        this.store.flushPendingWrites();
      } catch {
        const closeAnyway = dialog.showMessageBoxSync(this.window, {
          type: 'warning',
          message: 'Recent browsing changes could not be saved.',
          detail: 'Keep Private Browser open to retry, or close it and lose the pending changes.',
          buttons: ['Keep open', 'Close anyway'],
          defaultId: 0,
          cancelId: 0,
        }) === 1;
        if (!closeAnyway) event.preventDefault();
      }
    });
    this.window.on('closed', () => {
      this.temporaryBrowsing.close();
      if (this.downloadProgressTimer) clearTimeout(this.downloadProgressTimer);
      this.downloadProgressTimer = undefined;
      this.downloadProgressAccounts.clear();
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
    if (this.sessionLock.reason) return {
      sessionLock: this.sessionLock.reason,
      workspaces: WORKSPACES,
      activeWorkspaceId: 'personal',
      activeTabId: '',
      tabs: [], bookmarks: [], history: [], downloads: [], privacyLog: [],
      trackerBlocking: true,
      activeAccountSpaceId: '' as AccountSpaceId,
      accountSpaces: [], accountHealth: [],
      googleConfiguration: { configured: false }, externalBrowsers: [],
      bookmarkBarVisible: false, ui: { ...DEFAULT_UI_PREFERENCES }, settings: { ...DEFAULT_BROWSER_SETTINGS },
      availableSpellcheckLanguages: [], assistantPolicy: { cloud: 'unavailable', receipts: [] },
      windowState: { maximized: false, fullscreen: false, darkMode: nativeTheme.shouldUseDarkColors },
      shortcutsByAccountSpace: {}, bookmarkIcons: {}, canReopenClosedTab: false, sideApps: [],
    };
    const persisted = this.store.getChromeState();
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
        sleeping: runtime?.sleeping || undefined,
        securityWarning: tab.isHome ? undefined : navigationWarning(tab.url),
        ...this.runtimeMedia(runtime),
      };
    });
    const activeAccountSpaceId = this.activeAccountSpaceId(persisted);
    const bookmarkUndo = this.bookmarkUndo.get(activeAccountSpaceId);
    const closedBatch = this.closedTabBatches.get(activeAccountSpaceId);
    const windowReady = Boolean(this.window && !this.window.isDestroyed());
    const downloadAccount = this.activeDownloadAccount(persisted);
    const activeTab = this.activeTab(persisted);
    const pdfDocument = this.runtimeTabs.get(activeTab.id)?.pdf;
    const pair = this.splitPair(persisted, activeTab);
    const memorySite = downloadAccount && !activeTab.isHome ? memorySaverOrigin(activeTab.url) : undefined;
    const strictTracking = activeTab.workspaceId === 'banking';
    const trackerSite = !activeTab.isHome && isAllowedRemoteUrl(activeTab.url) && (downloadAccount || strictTracking)
      ? this.trackerProtection.status(activeTab.accountSpaceId, safeOrigin(activeTab.url), {
        enabled: persisted.trackerBlocking,
        strict: strictTracking || isProtectedPage(activeTab.url) && persisted.trackerBlocking,
        canPause: Boolean(downloadAccount) && persisted.trackerBlocking && canPauseTrackersAt(activeTab.url)
          && this.runtimeTabs.get(activeTab.id)?.problem !== 'certificate',
      }) : undefined;
    return {
      workspaces: WORKSPACES,
      activeWorkspaceId: persisted.activeWorkspaceId,
      activeTabId: activeTab.id,
      pdfDocument: pdfDocument && { mode: pdfDocument.mode, canOpen: pdfDocument.canOpen },
      splitView: pair && windowReady ? { ...pair, suspended: this.window.isFullScreen() || !splitBounds(this.currentContentBounds()) } : undefined,
      tabs,
      bookmarks: persisted.bookmarks,
      bookmarkFolders: downloadAccount ? persisted.bookmarkFoldersByAccountSpace?.[downloadAccount] : undefined,
      bookmarkUndo: bookmarkUndo ? { kind: bookmarkUndo.kind, count: bookmarkUndo.before.length } : undefined,
      history: persisted.history,
      ...(downloadAccount ? { ...this.downloadSnapshot(downloadAccount), downloadProgressRevision: this.downloadProgressRevision } : { downloads: [] }),
      downloadHistory: !downloadAccount ? undefined : this.downloadHistoryFailures.has(downloadAccount)
        ? 'unavailable' : this.downloadHistory.status(downloadAccount),
      downloadFolder: downloadAccount ? this.downloadFolder.status(downloadAccount) : undefined,
      managedUpdate: downloadAccount && process.platform === 'win32' && !this.store.isReadOnly() ? this.managedUpdate.snapshot() : undefined,
      privacyLog: persisted.privacyLog,
      browsingProtection: this.persistedState.protectionStatus(),
      trackerBlocking: strictTracking || persisted.trackerBlocking,
      trackerSite,
      memorySaverSite: memorySite && downloadAccount ? { origin: memorySite, keptAwake: this.store.keepsSiteAwake(downloadAccount, memorySite) } : undefined,
      wordPressSaveSite: this.wordPressSiteStatus(activeTab),
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
      ui: { ...persisted.ui, sidePanelTool: this.sidePanelTool(persisted, downloadAccount) },
      sidePanelPins: downloadAccount ? persisted.sidePanelsByAccountSpace?.[downloadAccount]?.pins ?? [] : undefined,
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
    this.endSplitForTab(tabId, tab.accountSpaceId);
    this.broadcast();
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
    const changed = JSON.stringify(next) !== JSON.stringify(this.layout);
    if (changed) this.fillPicker.close();
    this.layout = next;
    if (changed && this.splitPairs.size) this.scheduleLayout();
    else this.applyLayout();
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
      current?.wordPressAttempt?.clear();
      this.wordPressPrompt?.abort();
      this.endSplitForTab(tab.id, tab.accountSpaceId);
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
    await view.webContents.loadURL(url).catch((error: unknown) => {
      if (this.runtimeTabs.get(tab.id)?.pdf?.mode !== 'protected') throw error;
    });
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
    this.endSplitForTab(tabId, tab.accountSpaceId);
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
    const splitView = this.runtimeTabs.get(tabId)?.view;
    if (tabId === this.visibleSplitTabId && splitView?.getVisible() && !this.overlayOpen && !this.sessionIsLocked) {
      this.focusSplitTab(tabId, splitView);
      splitView.webContents.focus();
      return;
    }
    this.fillCapabilities.invalidateAll();
    this.hideAllViews();
    this.store.update((next) => {
      next.activeWorkspaceId = tab.workspaceId;
      next.activeAccountSpaceByWorkspace[tab.workspaceId] = tab.accountSpaceId;
      next.activeTabByAccountSpace[tab.accountSpaceId] = tab.id;
    });
    await this.showActiveTab();
    this.armWordPressSave(tabId);
  }

  async setSplitView(otherTabId?: string): Promise<void> {
    const state = this.store.get();
    const active = this.activeTab(state);
    if (otherTabId === undefined) {
      this.splitPairs.delete(active.accountSpaceId);
      this.applyLayout();
      this.broadcast();
      return;
    }
    const other = state.tabs.find((tab) => tab.id === otherTabId && tab.accountSpaceId === active.accountSpaceId);
    if (!other || other.id === active.id || !this.canSplitTab(active) || !this.canSplitTab(other)
      || this.sessionIsLocked || this.store.isReadOnly()) throw new Error('Choose two regular pages in this Account Space.');
    if (this.window.isFullScreen() || !splitBounds(this.currentContentBounds())) throw new Error('Widen the browser to open two pages side by side.');
    this.splitPairs.set(active.accountSpaceId, { leftTabId: active.id, rightTabId: other.id });
    await this.showActiveTab();
  }

  private canSplitTab(tab: BrowserTab): boolean {
    const runtime = this.runtimeTabs.get(tab.id);
    const contents = runtime?.view?.webContents;
    return splitPageAllowed(tab) && !runtime?.problem && !runtime?.certificateError
      && (!contents || contents.isDestroyed() || (!contents.isDevToolsOpened() && !agentHost?.isLentContents(contents.id)));
  }

  private splitPair(state: RuntimeBrowserStateV2, active: BrowserTab) {
    const pair = this.splitPairs.get(active.accountSpaceId);
    if (!pair || (pair.leftTabId !== active.id && pair.rightTabId !== active.id) || !this.canSplitTab(active)
      || state.accountSpaces.find((item) => item.id === active.accountSpaceId)?.locked) return undefined;
    const otherId = pair.leftTabId === active.id ? pair.rightTabId : pair.leftTabId;
    const other = state.tabs.find((item) => item.id === otherId && item.accountSpaceId === active.accountSpaceId);
    return other && this.canSplitTab(other) ? pair : undefined;
  }

  private focusSplitTab(tabId: string, view: WebContentsView): void {
    if (this.sessionIsLocked || this.overlayOpen || !view.getVisible() || this.visibleSplitTabId !== tabId) return;
    const state = this.store.get();
    const active = this.activeTab(state);
    const pair = this.splitPair(state, active);
    if (!pair || (pair.leftTabId !== tabId && pair.rightTabId !== tabId)) return;
    this.fillCapabilities.invalidateAll();
    this.fillPicker.close();
    this.store.update((next) => { next.activeTabByAccountSpace[active.accountSpaceId] = tabId; }, 'routine');
    this.applyLayout();
    this.broadcast();
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
    if (this.store.get().activeWorkspaceId === 'banking') return Promise.reject(new Error('Side apps are unavailable in Banking'));
    return this.sideApps.clearData(id);
  }

  private notesAccount(): AccountSpaceId {
    const state = this.store.get();
    const active = this.activeAccountSpaceId(state);
    const account = state.accountSpaces.find(({ id }) => id === active);
    if (this.sessionIsLocked || this.store.isReadOnly() || !account || account.locked || state.activeWorkspaceId === 'banking') {
      throw new Error('Notes is unavailable in this Account Space.');
    }
    return active;
  }

  async runNotesPanelCommand(kind: NotesPanelCommand) {
    const account = this.notesAccount();
    const result = await this.sideApps.notesCommand({ kind }, () => {
      try { return this.notesAccount() === account; } catch { return false; }
    });
    if (kind === 'status') return notesStatus(result);
    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
      throw new Error('Open the Notes library, close any editor, and try again.');
    }
  }

  private prepareNotesDraft(tabId: string, generation: number, selection: string): void {
    if (!this.notesSourceCurrent(tabId, generation)) return;
    const tab = this.activeTab(this.store.get());
    const source = new URL(tab.url).origin;
    const result = redactSensitiveText(selection.slice(0, 8_000));
    if (!result.text.trim()) return;
    const lifetime = 2 * 60_000;
    const id = randomUUID();
    const review = { id, accountSpaceId: tab.accountSpaceId, tabId, source, title: 'Excerpt from ' + new URL(tab.url).host.slice(0, 140),
      text: result.text.slice(0, 8_000), redactions: result.redactions, expiresAt: Date.now() + lifetime };
    this.notesDraft = { review, generation, url: tab.url, delivering: false };
    setTimeout(() => this.cancelNotesDraft(id), lifetime).unref();
    this.window.webContents.send('notes:draft-review', review);
  }

  private notesSourceCurrent(tabId: string, generation: number): boolean {
    try {
      const account = this.notesAccount();
      const tab = this.activeTab(this.store.get());
      const runtime = this.runtimeTabs.get(tabId);
      const contents = runtime?.view?.webContents;
      return tab.accountSpaceId === account && tab.id === tabId && !tab.isHome && !isProtectedPage(tab.url) && classifyAiSource(tab.url) === 'browser'
        && !!contents && !contents.isDestroyed() && !runtime.certificateError && !runtime.problem && !agentHost?.isLentContents(contents.id)
        && runtime.navigationGeneration === generation && contents.getURL() === tab.url;
    } catch { return false; }
  }

  cancelNotesDraft(id: string): void {
    if (this.notesDraft?.review.id === id) this.notesDraft = undefined;
  }

  async deliverNotesDraft(choice: NotesDraftChoice, copyOnly: boolean): Promise<void> {
    const draft = this.notesDraft;
    const isCurrent = () => draft && this.notesDraft === draft && this.notesSourceCurrent(draft.review.tabId, draft.generation)
      && this.activeTab(this.store.get()).url === draft.url && draft.review.expiresAt > Date.now();
    if (!draft || draft.review.id !== choice.id || draft.delivering || !isCurrent()) throw new Error('Select the text again to review a new Notes draft.');
    const title = choice.title.trim();
    const text = choice.text;
    if (!title || !text.trim()) throw new Error('Add a title and text first.');
    if (redactSensitiveText(title).redactions || redactSensitiveText(text).redactions) {
      throw new Error('Remove or redact sensitive details before continuing.');
    }
    const source = choice.includeSource ? draft.review.source : undefined;
    draft.delivering = true;
    try {
      if (copyOnly) {
        await this.clipboardGuard.copy(text + (source ? '\n\nSource: ' + source : ''), () => {
          if (!isCurrent() || clipboardQuit !== 'not-started') throw new Error('The selected page changed.');
        });
      } else {
        this.setUiPreferences({ sidePanelOpen: true, sidePanelTool: 'easynote' }, this.notesAccount());
        const result = await this.sideApps.notesCommand({ kind: 'draft', title, text, source }, () => Boolean(isCurrent()));
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
          throw new Error('Notes could not open the draft. Close any open or recovered Notes draft, or copy the excerpt.');
        }
      }
      this.cancelNotesDraft(choice.id);
    } finally { draft.delivering = false; }
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
    if (this.sessionIsLocked || !this.window || this.window.isDestroyed()) return;
    const state = this.store.get();
    const accountId = this.activeDownloadAccount(state);
    const tool = this.sidePanelTool(state, accountId);
    const [contentWidth, contentHeight] = this.window.getContentSize();
    this.sideApps.layout({
      insets: this.layout,
      contentWidth,
      contentHeight,
      activeApp: state.ui.sidePanelOpen && isSideAppId(tool) ? tool : null,
      suppressed: this.overlayOpen || this.window.isFullScreen() || !accountId,
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

  async addLocalAccountSpace(workspaceId: WorkspaceId, label: string, color: AccountSpaceColor, googleSetupPending = false): Promise<AccountSpaceId> {
    const state = this.store.get();
    if (!WORKSPACES.some((workspace) => workspace.id === workspaceId)) throw new Error('Unknown workspace');
    const order = state.accountSpaces.filter((account) => account.workspaceId === workspaceId).length;
    const record = this.accounts.createLocal({ workspaceId, label, color, order, googleSetupPending });
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
    const account = this.requireAccountMembership(accountSpaceId);
    if (account.locked || account.workspaceId === 'banking') {
      return { ok: false, error: { code: 'GOOGLE_POLICY_DENIED', message: 'Google tools are unavailable in this Account Space.', requestId: randomUUID() } } as const;
    }
    if (this.googleOAuth.isConnecting(accountSpaceId)) {
      return { ok: false, error: { code: 'GOOGLE_INTERNAL', message: 'A Google connection is already in progress for this account.', requestId: randomUUID() } } as const;
    }
    const previous = this.accounts.require(accountSpaceId);
    this.store.refreshAccount({ ...previous, googleConnection: 'connecting' });
    this.broadcast();
    const selectedModules = previous.googleIdentity ? modules : ['identity' as const];
    const result = await this.googleOAuth.connect(accountSpaceId, selectedModules, browserId, () => this.store.get().accountSpaces.map((account) => account.id));
    if (!this.store.get().accountSpaces.some(({ id }) => id === accountSpaceId)) return result;
    if (!result.ok && result.error?.code !== 'GOOGLE_CANCELLED') {
      const status = result.error?.code === 'GOOGLE_CONFIGURATION_REQUIRED' ? 'not-configured'
        : result.error?.code === 'GOOGLE_SCOPE_MISSING' ? 'partial-scopes'
          : result.error?.code === 'GOOGLE_RECONNECT_REQUIRED' ? 'reconnect-required'
            : result.error?.code === 'GOOGLE_OFFLINE' ? 'offline'
              : 'disconnected';
      // A failed reconnect keeps an existing usable grant. A lock or disconnect
      // during the consent window takes precedence over the attempted connection.
      const current = this.accounts.require(accountSpaceId);
      if (!current.locked && current.googleConnection === previous.googleConnection) {
        this.accounts.update(accountSpaceId, (record) => {
          record.googleConnection = status === 'disconnected' && record.refreshToken ? previous.googleConnection : status;
        });
      }
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
    return this.googleOAuth.cancel(accountSpaceId);
  }

  async disconnectGoogleAccount(accountSpaceId: AccountSpaceId, revoke = false) {
    this.requireAccountMembership(accountSpaceId);
    this.cancelAccountOperations(accountSpaceId);
    const result = await this.googleOAuth.disconnect(accountSpaceId, revoke);
    const record = this.accounts.require(accountSpaceId);
    this.store.refreshAccount(record);
    if (result.ok) {
      this.addPrivacyEvent('vault', revoke ? 'Google access revoked' : 'Google API disconnected',
        revoke ? 'Google confirmed removal of the app grant' : 'The browser removed its saved Google tools connection', accountSpaceId);
    } else if (record.googleConnection === 'revocation-pending') {
      this.addPrivacyEvent('blocked', 'Google revocation pending', 'Retry when the network is available', accountSpaceId);
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
    this.addPrivacyEvent('vault', 'Account Space data cleared', `${WORKSPACES.find((item) => item.id === account.workspaceId)?.name ?? 'An'} Account Space: website data and history were removed`, accountSpaceId);
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
    this.addPrivacyEvent('vault', 'Browsing data deleted', 'Reviewed browsing data was removed from one Account Space', account.id);
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
    this.downloadFolder.forgetAccount(accountSpaceId);
    this.temporaryPanelTools.delete(accountSpaceId);
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
      if (!allowed) {
        const reason = Date.parse(pending.prompt.expiresAt) <= Date.now() ? 'The permission request expired.' : 'The permission was declined or the source was unavailable.';
        this.logBlockedPermission(pending.prompt.accountSpaceId, pending.prompt.capability, reason + ' Request it again from the page.');
      }
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
    this.requireGoogleWriteAccount(accountSpaceId, 'gmail-send');
    return this.googleServices.prepareGmailSend(accountSpaceId, input, sourceRevision, this.gmailReplySource(accountSpaceId, sourceRevision));
  }

  async readGmailReplyDraft(accountSpaceId: AccountSpaceId, operationId: string, messageId: string): Promise<GoogleOperationResult<GmailReplyDraft>> {
    const readAccount = () => {
      const record = this.requireGoogleWriteAccount(accountSpaceId, 'gmail-send');
      if (!record.enabledModules.includes('gmail-metadata')) throw new Error('Enable Gmail headers to open a reply.');
      return record.googleIdentity!.sub;
    };
    const subject = readAccount();
    return this.runGoogleOperation(accountSpaceId, operationId, 'gmail', async (signal) => {
      const result = await this.googleServices.readGmailReplySource(accountSpaceId, messageId, signal);
      signal.throwIfAborted();
      if (readAccount() !== subject) throw new Error('The Google account changed. Open the original message again.');
      if (!result.ok || !result.data) return { ok: false, error: result.error };
      const sourceRevision = randomUUID();
      const expiresAt = Date.now() + 5 * 60_000;
      while (this.gmailReplySources.size >= 48) this.gmailReplySources.delete(this.gmailReplySources.keys().next().value!);
      this.gmailReplySources.set(sourceRevision, { accountSpaceId, subject, source: result.data, expiresAt });
      setTimeout(() => this.gmailReplySources.delete(sourceRevision), expiresAt - Date.now()).unref();
      return { ok: true, data: { sourceRevision, recipient: result.data.recipient, subject: result.data.subject } };
    });
  }

  private gmailReplySource(accountSpaceId: AccountSpaceId, revision?: string): GmailReplySource | undefined {
    if (revision === undefined) return undefined;
    const source = this.gmailReplySources.get(revision);
    const record = this.accounts.require(accountSpaceId);
    if (!source || source.accountSpaceId !== accountSpaceId || source.expiresAt <= Date.now() || record.googleIdentity?.sub !== source.subject
      || !record.enabledModules.includes('gmail-metadata')) throw new Error('The original Gmail message expired. Open it again to prepare a new reply.');
    return source.source;
  }

  gmailOverview(accountSpaceId: AccountSpaceId, operationId: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'gmail', (signal) => this.googleServices.gmailOverview(accountSpaceId, signal));
  }

  async googleOverviewPage(accountSpaceId: AccountSpaceId, operationId: string, service: GoogleOverviewService, cursor?: string):
    Promise<GoogleOperationResult<GoogleOverviewPage>> {
    const readCurrent = () => {
      const state = this.store.get();
      const account = this.requireAccountMembership(accountSpaceId);
      const record = this.accounts.require(accountSpaceId);
      if (this.sessionIsLocked || this.activeAccountSpaceId(state) !== accountSpaceId || account.workspaceId === 'banking'
        || account.locked || account.googleConnection !== 'connected' || !record.googleIdentity
        || !googleOverviewModule(service, record.enabledModules)) throw new Error('This Google tool is unavailable in the active Account Space.');
      return { subject: record.googleIdentity.sub, modules: record.enabledModules };
    };
    const before = readCurrent();
    const now = Date.now();
    for (const [id, pending] of this.googleOverviewCursors) {
      if (pending.expiresAt <= now) this.googleOverviewCursors.delete(id);
    }
    const previous = cursor ? this.googleOverviewCursors.get(cursor) : undefined;
    if (cursor && (!previous || previous.accountSpaceId !== accountSpaceId || previous.service !== service
      || previous.subject !== before.subject || previous.inUse)) throw new Error('This overview expired. Refresh the first page.');
    if (previous) previous.inUse = true;
    try {
      const timeMin = previous?.timeMin ?? new Date(now).toISOString();
      return await this.runGoogleOperation(accountSpaceId, operationId, service, async (signal) => {
        const result = await this.googleServices.recentOverviewPage(accountSpaceId, service, before.modules, previous?.token, timeMin, signal);
        signal.throwIfAborted();
        const after = readCurrent();
        if (before.subject !== after.subject || googleOverviewModule(service, before.modules) !== googleOverviewModule(service, after.modules)) {
          throw new Error('Google access changed. Refresh the first page.');
        }
        if (!result.ok || !result.data) return { ok: false, error: result.error };
        if (cursor) this.googleOverviewCursors.delete(cursor);
        const page = previous?.page ?? 1;
        let next: string | undefined;
        const { items, token } = result.data;
        const limited = Boolean(token && page >= GOOGLE_OVERVIEW_MAX_PAGES);
        if (token && !limited) {
          while (this.googleOverviewCursors.size >= 64) this.googleOverviewCursors.delete(this.googleOverviewCursors.keys().next().value!);
          next = randomUUID();
          this.googleOverviewCursors.set(next, {
            accountSpaceId, service, subject: before.subject, token, timeMin, page: page + 1,
            expiresAt: Date.now() + 2 * 60_000,
          });
          const key = next;
          setTimeout(() => this.googleOverviewCursors.delete(key), 2 * 60_000).unref();
        }
        return { ok: true, data: { items, page, next, limited } };
      });
    } finally {
      if (previous) previous.inUse = false;
    }
  }

  searchGmail(accountSpaceId: AccountSpaceId, operationId: string, query?: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'gmail', (signal) => this.googleServices.searchGmail(accountSpaceId, query ?? '', signal));
  }

  sendGmail(accountSpaceId: AccountSpaceId, operationId: string, input: GmailSendInput, confirmationToken: string, sourceRevision?: string) {
    this.requireGoogleWriteAccount(accountSpaceId, 'gmail-send');
    const source = this.gmailReplySource(accountSpaceId, sourceRevision);
    return this.runGoogleOperation(accountSpaceId, operationId, 'gmail', (signal) => this.googleServices.sendGmail(accountSpaceId, input, confirmationToken, sourceRevision, signal, source));
  }

  listDriveFiles(accountSpaceId: AccountSpaceId, operationId: string, query?: string, wholeDrive?: boolean) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'drive', (signal) => this.googleServices.listDriveFiles(accountSpaceId, query ?? '', wholeDrive === true, signal));
  }

  createDriveFile(accountSpaceId: AccountSpaceId, operationId: string, input: DriveCreateInput) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'drive', (signal) => this.googleServices.createDriveFile(accountSpaceId, input, signal));
  }

  prepareDriveShare(accountSpaceId: AccountSpaceId, fileId: string, email: string, role: 'reader' | 'writer', sourceRevision?: string) {
    this.requireGoogleWriteAccount(accountSpaceId, 'drive-files');
    return this.googleServices.prepareDriveShare(accountSpaceId, fileId, email, role, sourceRevision);
  }

  shareDriveFile(accountSpaceId: AccountSpaceId, operationId: string, fileId: string, email: string, role: 'reader' | 'writer', confirmationToken: string, sourceRevision?: string) {
    this.requireGoogleWriteAccount(accountSpaceId, 'drive-files');
    return this.runGoogleOperation(accountSpaceId, operationId, 'drive', (signal) => this.googleServices.shareDriveFile(accountSpaceId, fileId, email, role, confirmationToken, sourceRevision, signal));
  }

  listCalendarEvents(accountSpaceId: AccountSpaceId, operationId: string, query?: string) {
    return this.runGoogleOperation(accountSpaceId, operationId, 'calendar', (signal) => this.googleServices.upcomingCalendarEvents(accountSpaceId, query ?? '', signal));
  }

  prepareCalendarWrite(accountSpaceId: AccountSpaceId, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, sourceRevision?: string) {
    this.requireGoogleWriteAccount(accountSpaceId, 'calendar-write');
    return this.googleServices.prepareCalendarWrite(accountSpaceId, action, input, sourceRevision);
  }

  writeCalendarEvent(accountSpaceId: AccountSpaceId, operationId: string, action: 'create' | 'update' | 'delete', input: CalendarWriteInput, confirmationToken: string, sourceRevision?: string) {
    this.requireGoogleWriteAccount(accountSpaceId, 'calendar-write');
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
    if (conflictResolution) throw new Error('Review the local and remote backups before choosing how to resolve a conflict.');
    const payload = this.backupPayload(accountSpaceId);
    return this.runGoogleOperation(accountSpaceId, operationId, 'backup', async (signal) => {
      const result = await this.backups.upload(accountSpaceId, payload, undefined, signal);
      if (result.status === 'uploaded') this.refreshBackupSummary(accountSpaceId);
      return result;
    });
  }

  private backupPayload(accountSpaceId: AccountSpaceId) {
    const state = this.store.get();
    return this.backups.buildPayload(accountSpaceId, {
      bookmarks: state.bookmarks,
      folderTree: state.bookmarkFoldersByAccountSpace?.[accountSpaceId],
      trackerBlocking: state.trackerBlocking,
      openTabs: state.tabs,
      history: state.history,
    });
  }

  async previewBackupUpload(accountSpaceId: AccountSpaceId, operationId: string): Promise<BackupUploadPreview> {
    const account = this.requireBackupUploadTarget(accountSpaceId);
    this.backupUploadReview = undefined;
    const payload = this.backupPayload(accountSpaceId);
    return this.runGoogleOperation(accountSpaceId, operationId, 'backup', async (signal) => {
      const { details, expectedEtag } = await this.backups.reviewUpload(accountSpaceId, payload, signal);
      signal.throwIfAborted();
      if (this.requireBackupUploadTarget(accountSpaceId).subject !== account.subject) throw new Error('The Google account changed.');
      const id = randomUUID();
      this.backupUploadReview = { id, accountSpaceId, subject: account.subject, etag: expectedEtag,
        revision: backupUploadRevision(payload), expiresAt: Date.now() + 2 * 60_000 };
      return { id, accountSpaceId, ...details };
    });
  }

  async applyBackupUpload(id: string, operationId: string, resolution: 'merge' | 'overwrite'): Promise<BackupWriteResult> {
    const review = this.backupUploadReview;
    if (!review || review.id !== id) throw new Error('Review the backup again before saving.');
    this.backupUploadReview = undefined;
    const account = this.requireBackupUploadTarget(review.accountSpaceId);
    const payload = this.backupPayload(review.accountSpaceId);
    if (review.subject !== account.subject || review.expiresAt <= Date.now() || review.revision !== backupUploadRevision(payload)) {
      throw new Error('The browsing data changed or this review expired. Review it again.');
    }
    return this.runGoogleOperation(review.accountSpaceId, operationId, 'backup', async (signal) => {
      const result = await this.backups.upload(review.accountSpaceId, payload, resolution, signal, review.etag);
      if (result.status === 'uploaded') this.refreshBackupSummary(review.accountSpaceId);
      return result;
    });
  }

  cancelBackupUpload(id: string): void {
    if (this.backupUploadReview?.id === id) this.backupUploadReview = undefined;
  }

  setBackupReminder(accountSpaceId: AccountSpaceId, days: BackupReminderDays): void {
    this.requireBackupUploadTarget(accountSpaceId);
    this.accounts.update(accountSpaceId, (record) => { record.backup.reminderDays = days; });
    this.refreshBackupSummary(accountSpaceId);
  }

  private refreshBackupSummary(accountSpaceId: AccountSpaceId): void {
    this.store.refreshAccount(this.accounts.require(accountSpaceId));
    this.broadcast();
  }

  private requireBackupUploadTarget(accountSpaceId: AccountSpaceId) {
    const account = this.requireBackupRestoreTarget(accountSpaceId);
    if (this.sessionIsLocked || this.activeAccountSpaceId(this.store.get()) !== accountSpaceId || !this.accounts.require(accountSpaceId).backup.enabled) {
      throw new Error('Open the enabled backup in its unlocked Account Space.');
    }
    return account;
  }

  async previewBackupRestore(accountSpaceId: AccountSpaceId, operationId: string, recoveryCode?: string, generation?: string): Promise<BackupRestorePreview> {
    const account = this.requireBackupRestoreTarget(accountSpaceId);
    const previous = this.pendingBackupRequest;
    if (previous) this.cancelOperation(previous.operationId);
    const request = { accountSpaceId, operationId };
    this.pendingBackupRequest = request;
    this.backupRestoreReview = undefined;
    try {
      return await this.runGoogleOperation(accountSpaceId, operationId, 'backup', async (signal) => {
        const { payload, generations } = await this.backups.restoreGeneration(accountSpaceId, recoveryCode, generation, signal);
        if (signal.aborted || this.pendingBackupRequest !== request || this.requireBackupRestoreTarget(accountSpaceId).subject !== account.subject) {
          throw new Error('The backup request changed. Start a new preview.');
        }
        const state = this.store.get();
        const { counts, items } = planBackupRestore(payload, { accountSpaceId, workspaceId: account.workspaceId }, state);
        const preview: BackupRestorePreview = { id: randomUUID(), accountSpaceId, accountLabel: account.label,
          workspaceId: account.workspaceId, createdAt: payload.createdAt, counts, generations };
        this.backupRestoreReview = { preview, items, subject: account.subject,
          revision: backupRestoreRevision(accountSpaceId, state), expiresAt: Date.now() + 2 * 60_000 };
        return preview;
      });
    } finally {
      if (this.pendingBackupRequest === request) this.pendingBackupRequest = undefined;
    }
  }

  applyBackupRestore(id: string): void {
    const pending = this.backupRestoreReview;
    if (!pending || pending.preview.id !== id) throw new Error('Review the backup again before restoring.');
    this.backupRestoreReview = undefined;
    const { accountSpaceId } = pending.preview;
    const account = this.requireBackupRestoreTarget(accountSpaceId);
    if (pending.expiresAt <= Date.now() || pending.subject !== account.subject
      || pending.revision !== backupRestoreRevision(accountSpaceId, this.store.get())) {
      throw new Error('Backup review expired or its Account Space changed. Review it again.');
    }
    this.store.update((state) => {
      state.bookmarks.push(...pending.items.bookmarks);
      if (pending.items.folders.length) {
        const folders = state.bookmarkFoldersByAccountSpace ??= {};
        folders[accountSpaceId] = appendBookmarkFolders(folders[accountSpaceId] ?? [], pending.items.folders);
      }
      state.history.push(...pending.items.history);
      state.tabs.push(...pending.items.tabs.map((tab) => ({
        ...tab, restorePaused: true, loading: false, canGoBack: false, canGoForward: false, developerToolsAllowed: false, developerToolsOpen: false,
      })));
    });
    this.broadcast();
  }

  cancelBackupRestore(id: string): void {
    if (this.backupRestoreReview?.preview.id === id) this.backupRestoreReview = undefined;
  }

  private requireBackupRestoreTarget(accountSpaceId: AccountSpaceId) {
    const account = this.requireAccountMembership(accountSpaceId);
    const record = this.accounts.require(accountSpaceId);
    if (account.locked || account.workspaceId === 'banking' || account.googleConnection !== 'connected'
      || !record.googleIdentity || !record.enabledModules.includes('encrypted-backup')) {
      throw new Error('Connect the same Google account and enable Encrypted backup in a compatible Account Space.');
    }
    return { label: record.label, workspaceId: record.workspaceId, subject: record.googleIdentity.sub };
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
    if (!this.sessionIsLocked && !this.window.isDestroyed()) this.window.webContents.send('google:operation-progress', { operationId, accountSpaceId, service, phase });
  }

  private requireAccountMembership(accountSpaceId: AccountSpaceId) {
    const state = this.store.get();
    const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
    if (!account || account.workspaceId !== state.activeWorkspaceId) throw new Error('Account Space does not belong to the active workspace');
    return account;
  }

  private requireGoogleWriteAccount(accountSpaceId: AccountSpaceId, module: GoogleModule) {
    const state = this.store.get();
    const account = state.accountSpaces.find((item) => item.id === accountSpaceId);
    if (!account || !isAvailableRegularAccount(state, account) || this.activeAccountSpaceId(state) !== accountSpaceId
      || this.sessionIsLocked || this.store.isReadOnly()) throw new Error('Open the original unlocked Account Space to review this Google action.');
    const record = this.accounts.require(accountSpaceId);
    if (!record.googleIdentity || record.googleConnection !== 'connected' || !record.enabledModules.includes(module)) {
      throw new Error('This Google action requires its separate permission in the active Account Space.');
    }
    return record;
  }

  private closeAccountViews(accountSpaceId: AccountSpaceId): void {
    this.temporaryBrowsing.close(accountSpaceId);
    this.fillPicker.close();
    this.splitPairs.delete(accountSpaceId);
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
    for (const key of [...this.faviconRequests.keys()]) if (key.startsWith(`${accountSpaceId}:`)) this.faviconRequests.delete(key);
    this.closedTabs.delete(accountSpaceId);
    this.closedTabBatches.delete(accountSpaceId);
    this.bookmarkUndo.delete(accountSpaceId);
  }

  private cancelAccountOperations(accountSpaceId: AccountSpaceId): void {
    if (this.backupUploadReview?.accountSpaceId === accountSpaceId) this.backupUploadReview = undefined;
    this.trackerProtection.clearAccount(accountSpaceId);
    this.trackerExpiry.get(accountSpaceId)?.forEach((timer) => clearTimeout(timer));
    this.trackerExpiry.delete(accountSpaceId);
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
    for (const [revision, source] of this.gmailReplySources) if (source.accountSpaceId === accountSpaceId) this.gmailReplySources.delete(revision);
    this.googleChecks.delete(accountSpaceId);
    for (const [id, pending] of this.googleOverviewCursors) {
      if (pending.accountSpaceId === accountSpaceId) this.googleOverviewCursors.delete(id);
    }
    this.backups.clearAccount(accountSpaceId);
    if (this.backupRestoreReview?.preview.accountSpaceId === accountSpaceId) this.backupRestoreReview = undefined;
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

  get sessionIsLocked(): boolean { return this.sessionLock.reason !== undefined; }

  startSessionLockMonitoring(): void {
    if (process.platform !== 'win32') return;
    const onLock = () => {
      if (this.sessionLock.onWindowsLock(this.store.sessionPrivacyPreferences().lockOnWindowsSession === true)) this.enforceSessionLock();
    };
    if (powerMonitor.getSystemIdleState(1) === 'locked') onLock();
    powerMonitor.on('lock-screen', onLock);
    powerMonitor.on('unlock-screen', () => {
      if (!this.sessionLock.onWindowsUnlock()) return;
      void this.sessionLockWork.then(async () => {
        if (this.sessionIsLocked) return;
        this.refreshSessionChrome();
        await this.showActiveTab();
        await openPendingSystemLinks();
      }).catch(() => undefined);
    });
    setInterval(() => {
      if (this.sessionIsLocked) return;
      const minutes = this.store.sessionPrivacyPreferences().idleLockMinutes;
      if (minutes && this.sessionLock.checkIdle(powerMonitor.getSystemIdleTime(), minutes)) this.enforceSessionLock();
    }, 5_000).unref();
  }

  private enforceSessionLock(): void {
    this.downloadEnrollment?.abort();
    // Hide first. Subsequent IPC cannot reopen content while the lock marker is set.
    this.hideAllViews();
    this.temporaryBrowsing.close();
    this.sideApps.closeAll();
    this.managedUpdate.cancelTransfer();
    agentHost?.stop();
    const state = this.store.get();
    for (const account of state.accountSpaces) this.cancelAccountOperations(account.id);
    for (const runtime of this.runtimeTabs.values()) {
      if (!runtime.view) continue;
      this.window?.contentView.removeChildView(runtime.view);
      runtime.view.webContents.close();
    }
    this.runtimeTabs.clear();
    const availableWindow = this.window && !this.window.isDestroyed();
    if (availableWindow) this.refreshSessionChrome();
    this.sessionLockWork = Promise.allSettled([
      this.lockVault(),
      this.vscodeBridge.disconnect(false),
      ...[...this.configuredSessions].map((partition) => session.fromPartition(partition).closeAllConnections()),
    ]).then(() => undefined);
  }

  private refreshSessionChrome(): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.reloadIgnoringCache();
  }

  private queuePermissionPrompt(prompt: PermissionPrompt, respond: (allowed: boolean, displaySourceId?: string) => void, retainAllowOnce = false): void {
    if (this.pendingPermission) {
      respond(false);
      this.logBlockedPermission(prompt.accountSpaceId, prompt.capability, 'Finish the open permission request, then try again.');
      return;
    }
    this.pendingPermission = { prompt, respond, retainAllowOnce };
    const active = this.activeTab(this.store.get());
    this.runtimeTabs.get(active.id)?.view?.setVisible(false);
    if (this.visibleSplitTabId) this.applyLayout();
    this.broadcast();
  }

  private logBlockedPermission(accountId: AccountSpaceId, capability: PermissionCapability, detail: string): void {
    const title = 'Permission blocked · ' + capability.replaceAll('-', ' ');
    const state = this.store.get();
    if (this.activeAccountSpaceId(state) !== accountId) return;
    if (state.privacyLog.some((event) => event.accountSpaceId === accountId && event.title === title
      && event.detail === detail && Date.now() - Date.parse(event.at) < 15_000)) return;
    this.addPrivacyEvent('blocked', title, detail, accountId);
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
    if (runtime?.pdf?.mode === 'protected') {
      if (runtime.pdf.canOpen) await this.navigate(runtime.pdf.url);
      return;
    }
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
        this.addBookmark(next, tab, { location: 'bar', path: [] });
      }
    });
    const favicon = this.runtimeTabs.get(tab.id)?.favicon;
    if (favicon) this.rememberBookmarkIcon(tab.id, favicon);
    this.broadcast();
  }

  async openTemporaryBrowsing(accountSpaceId: AccountSpaceId): Promise<void> {
    const state = this.store.get();
    const account = state.accountSpaces.find((item) => item.id === accountSpaceId);
    if (!account || this.store.isReadOnly() || this.activeDownloadAccount(state) !== accountSpaceId || this.window.isDestroyed()) {
      throw new Error('Open an unlocked regular Account Space to start temporary browsing.');
    }
    await this.temporaryBrowsing.open(this.window, account);
  }

  private keepTemporaryBookmark(accountSpaceId: AccountSpaceId, url: string, title: string): void {
    this.requireEditableBookmarkAccount(accountSpaceId);
    const state = this.store.get();
    if (state.bookmarks.some((item) => item.accountSpaceId === accountSpaceId && item.url === url)) return;
    this.store.update((next) => this.addBookmark(next, { accountSpaceId, url, title, workspaceId: state.activeWorkspaceId }, { location: 'bar', path: [] }));
    this.broadcast();
  }

  private addBookmark(state: RuntimeBrowserStateV2, tab: Pick<RuntimeBrowserStateV2['tabs'][number], 'accountSpaceId' | 'workspaceId' | 'title' | 'url'>, folder: BookmarkLevelInput): void {
    const owned = state.bookmarks.filter((item) => item.accountSpaceId === tab.accountSpaceId);
    if (owned.length >= 25_000) throw new Error('This Account Space has reached its bookmark limit.');
    const orderPath = nextBookmarkOrder(owned, state.bookmarkFoldersByAccountSpace?.[tab.accountSpaceId] ?? [], folder);
    state.bookmarks.unshift({ id: randomUUID(), title: tab.title, url: tab.url, workspaceId: tab.workspaceId,
      accountSpaceId: tab.accountSpaceId, createdAt: new Date().toISOString(), location: folder.location,
      folderPath: [...folder.path], order: orderPath[0], orderPath });
  }

  saveBookmarkToFolder(accountId: AccountSpaceId, tabId: string, expectedUrl: string, folder: BookmarkLevelInput): void {
    this.requireEditableBookmarkAccount(accountId);
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (tab.id !== tabId || tab.url !== expectedUrl || tab.isHome || !isAllowedRemoteUrl(tab.url)) throw new Error('The page changed. Open the bookmark destination again.');
    const existing = state.bookmarks.find((item) => item.accountSpaceId === accountId && item.url === tab.url);
    if (existing) {
      this.changeBookmarks(accountId, [existing.id], folder);
      return;
    }
    this.store.update((next) => this.addBookmark(next, tab, folder));
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
   * Applies the launch-time Home or startup page settings after restoring tabs.
   * Restored tabs stay open and a failed Home load does not stop startup.
   */
  async openStartupHome(atLaunch: RuntimeBrowserStateV2): Promise<void> {
    const state = this.store.get();
    if (state.recovery || this.startupTabRecovery || state.activeWorkspaceId === 'banking') return;
    const accountId = this.activeAccountSpaceId(state);
    if (state.activeWorkspaceId !== atLaunch.activeWorkspaceId || accountId !== this.activeAccountSpaceId(atLaunch)) return;
    const settings = settingsForWorkspace(atLaunch, atLaunch.activeWorkspaceId);
    if (settings.startup === 'pages' && settings.startupPages?.length) {
      const account = state.accountSpaces.find((candidate) => candidate.id === accountId);
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
    if (settings.startup !== 'home' && settings.startup !== 'new-tab') return;
    try {
      const url = settings.startup === 'home' ? resolveHomeUrl(settings, false) : 'private://home';
      await this.newTab(state.activeWorkspaceId, url, accountId);
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

  private sidePanelTool(state: RuntimeBrowserStateV2, regularAccount: AccountSpaceId | undefined): SidePanelTool {
    if (!isPinnablePanelTool(state.ui.sidePanelTool)) return state.ui.sidePanelTool;
    return regularAccount ? state.sidePanelsByAccountSpace?.[regularAccount]?.tool ?? state.ui.sidePanelTool
      : this.temporaryPanelTools.get(this.activeAccountSpaceId(state)) ?? 'privacy';
  }

  async changeBrowsingPrivacy(id: AccountSpaceId, action: BrowsingPrivacyAction, value?: number | boolean): Promise<boolean> {
    const account = this.requireBrowsingPrivacyAccount(id);
    if (this.browsingPrivacyBusy) throw new Error('Finish the current browsing privacy action first.');
    this.browsingPrivacyBusy = true;
    try {
      if (action === 'protect') {
        const confirmed = await this.confirmBrowsingPrivacy('Encrypt local browsing data',
          'This protects tabs, bookmarks and history for all Account Spaces using this device. Export a recovery file for each space you need to move to another Windows profile. Existing backups and website cache files are outside this setting.', 'Enable encryption');
        if (!confirmed) return false;
        this.requireBrowsingPrivacyAccount(id);
        this.store.enableBrowsingProtection();
        return true;
      }
      if (action === 'retention' || action === 'log') {
        const retention = action === 'retention';
        if ((retention ? value !== 0 : value === true) && !await this.confirmBrowsingPrivacy(
          retention ? `Keep ${value} days of history` : 'Use a minimal privacy log',
          retention ? 'Older Private Browser history will be removed from every Account Space, including history imported later.'
            : 'Remove site names and detail text from existing and future privacy events. The log shows event type and time.',
          retention ? 'Change retention' : 'Use minimal log')) return false;
        this.requireBrowsingPrivacyAccount(id);
        this.store.update((state) => {
          if (retention) state.ui.historyRetentionDays = value as number;
          else state.ui.minimalPrivacyLog = value === true;
        });
        return true;
      }
      const filters = [{ name: 'Private Browser recovery file', extensions: ['pbbr'] }];
      if (action === 'export') {
        const selected = await dialog.showSaveDialog(this.window, { title: 'Save encrypted browsing recovery file', defaultPath: 'Private-Browser-Recovery.pbbr', filters });
        if (selected.canceled || !selected.filePath) return false;
        this.requireBrowsingPrivacyAccount(id);
        const secret = await this.secureDialogs.open('export-browsing') as UnlockDialogValue | undefined;
        if (!secret) return false;
        this.requireBrowsingPrivacyAccount(id);
        const state = this.store.get();
        const bytes = await sealBrowsingArchive({ version: 1, createdAt: new Date().toISOString(), workspaceId: account.workspaceId,
          bookmarks: state.bookmarks.filter((item) => item.accountSpaceId === id), bookmarkFolders: [], folderTree: state.bookmarkFoldersByAccountSpace?.[id],
          history: state.history.filter((item) => item.accountSpaceId === id), settings: { trackerBlocking: state.trackerBlocking } }, secret.password);
        this.requireBrowsingPrivacyAccount(id);
        try { await writeFile(selected.filePath, bytes, { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('That file already exists. Choose a new name to keep the existing copy.');
          throw new Error('The recovery file could not be saved.');
        }
        return true;
      }
      const selected = await dialog.showOpenDialog(this.window, { title: 'Open encrypted browsing recovery file', properties: ['openFile'], filters });
      if (selected.canceled || !selected.filePaths[0]) return false;
      this.requireBrowsingPrivacyAccount(id);
      const secret = await this.secureDialogs.open('restore-browsing') as UnlockDialogValue | undefined;
      if (!secret) return false;
      this.requireBrowsingPrivacyAccount(id);
      const payload = await unsealBrowsingArchive(selected.filePaths[0], secret.password);
      this.requireBrowsingPrivacyAccount(id);
      const before = this.store.get();
      const revision = backupRestoreRevision(id, before);
      const cutoff = before.ui.historyRetentionDays ? Date.now() - before.ui.historyRetentionDays * 86_400_000 : 0;
      const history = payload.history?.filter((entry) => Date.parse(entry.visitedAt) >= cutoff);
      const { items, counts } = planBackupRestore({ ...payload, history, openTabs: undefined }, { accountSpaceId: id, workspaceId: account.workspaceId }, before);
      const message = `Add ${counts.bookmarks.added} bookmarks, ${counts.folders?.added ?? 0} folders and ${counts.history.added} history entries to ${account.label}?`;
      const detail = 'Duplicates and entries outside your retention or storage limits are skipped.';
      if (!await this.confirmBrowsingPrivacy(message, detail, 'Merge browsing data')) return false;
      this.requireBrowsingPrivacyAccount(id);
      const current = this.store.get();
      if (current.ui.historyRetentionDays !== before.ui.historyRetentionDays || backupRestoreRevision(id, current) !== revision) {
        throw new Error('Browsing data changed during review. Open the recovery file again.');
      }
      this.store.update((state) => {
        state.bookmarks.push(...items.bookmarks);
        state.history = [...state.history, ...items.history].sort((left, right) => right.visitedAt.localeCompare(left.visitedAt));
        if (items.folders.length) {
          const folders = state.bookmarkFoldersByAccountSpace ??= {};
          folders[id] = appendBookmarkFolders(folders[id] ?? [], items.folders);
        }
      });
      return true;
    } finally {
      this.browsingPrivacyBusy = false;
      this.broadcast();
    }
  }

  async changeBookmarkSync(id: AccountSpaceId, action: BookmarkSyncAction, reviewId?: string, choice?: 'local' | 'remote'): Promise<BookmarkSyncStatus | BookmarkSyncPreview | undefined> {
    const scope = this.bookmarkSyncScope(id);
    if (action === 'status') return this.bookmarkSync.status(scope);
    if (this.bookmarkSyncRequest) throw new Error('Finish the current bookmark sync action first.');
    const request = new AbortController();
    this.bookmarkSyncRequest = request;
    const current = () => { request.signal.throwIfAborted(); this.bookmarkSyncScope(id, scope.subject); };
    const capture = () => {
      current();
      const state = this.store.get();
      const owned = state.bookmarks.filter((entry) => entry.accountSpaceId === id);
      const syncable = owned.filter((entry) => canSyncBookmark(entry.url));
      return { data: bookmarkReplica(scope.workspaceId, syncable, state.bookmarkFoldersByAccountSpace?.[id] ?? []), deviceOnly: owned.length - syncable.length };
    };
    try {
      if (action === 'start') {
        if (!await this.confirmBrowsingPrivacy('Pair this bookmark library?', 'A separate encrypted copy of this Account Space’s bookmarks and folders will be stored in the connected Google Drive app data.', 'Start pairing')) return undefined;
        return await this.bookmarkSync.start(scope, capture().data, request.signal);
      }
      if (action === 'review') {
        const local = capture();
        return await this.bookmarkSync.prepare(scope, local.data, local.deviceOnly, request.signal);
      }
      if (action === 'apply') {
        const result = await this.bookmarkSync.apply(scope, reviewId!, choice, () => capture().data, (replica) => {
          current();
          this.store.update((state) => {
            const retained = state.bookmarks.filter((item) => item.accountSpaceId !== id || !canSyncBookmark(item.url));
            const keptOnDevice = retained.filter((item) => item.accountSpaceId === id).length;
            if (keptOnDevice + replica.bookmarks.length > 25_000) throw new Error('This Account Space exceeds the bookmark limit.');
            state.bookmarks = [...retained, ...replica.bookmarks.map((item) => ({ ...item, accountSpaceId: id, workspaceId: scope.workspaceId }))];
            const folders = state.bookmarkFoldersByAccountSpace ??= {};
            folders[id] = replica.folders;
          });
          this.bookmarkUndo.delete(id);
        }, request.signal);
        this.broadcast();
        return result;
      }
      if (action === 'unpair') {
        if (!await this.confirmBrowsingPrivacy('Disconnect this device?', 'Local bookmarks stay on this device. Other paired devices can continue using the shared library.', 'Disconnect this device')) return undefined;
        current();
        this.bookmarkSync.disconnect(scope);
        return this.bookmarkSync.status(scope);
      }
      const filters = [{ name: 'Encrypted bookmark pairing', extensions: ['pbpair'] }];
      if (action === 'export-pairing') {
        const file = await dialog.showSaveDialog(this.window, { title: 'Save bookmark pairing file', defaultPath: 'Private-Browser-Bookmarks.pbpair', filters });
        if (file.canceled || !file.filePath) return undefined;
        current();
        const secret = await this.secureDialogs.open('export-bookmark-pair') as UnlockDialogValue | undefined;
        if (!secret) return undefined;
        current();
        await writeBookmarkPairing(file.filePath, this.bookmarkSync.exportPair(scope), secret.password, current);
        return this.bookmarkSync.status(scope);
      }
      const file = await dialog.showOpenDialog(this.window, { title: 'Open bookmark pairing file', properties: ['openFile'], filters });
      if (file.canceled || !file.filePaths[0]) return undefined;
      current();
      const secret = await this.secureDialogs.open('import-bookmark-pair') as UnlockDialogValue | undefined;
      if (!secret) return undefined;
      const pair = await readBookmarkPairing(file.filePaths[0], secret.password);
      current();
      await this.bookmarkSync.importPair(scope, pair, request.signal);
      return this.bookmarkSync.status(scope);
    } finally { if (this.bookmarkSyncRequest === request) this.bookmarkSyncRequest = undefined; }
  }

  private bookmarkSyncScope(id: AccountSpaceId, subject?: string) {
    const account = this.requireGoogleWriteAccount(id, 'encrypted-backup');
    const current = account.googleIdentity!.sub;
    if (subject !== undefined && current !== subject) throw new Error('The connected Google account changed.');
    return { id, workspaceId: account.workspaceId, subject: current };
  }

  private requireBrowsingPrivacyAccount(id: AccountSpaceId) {
    const state = this.store.get();
    const account = state.accountSpaces.find((candidate) => candidate.id === id);
    if (id !== this.activeDownloadAccount(state) || !account || account.locked || this.store.isReadOnly() || this.sessionIsLocked) {
      throw new Error('Open the original unlocked Account Space to use browsing privacy settings.');
    }
    return account;
  }

  private async confirmBrowsingPrivacy(message: string, detail: string, action: string): Promise<boolean> {
    const choice = await dialog.showMessageBox(this.window, { type: 'warning', message, detail, buttons: ['Cancel', action], cancelId: 0, defaultId: 0 });
    return choice.response === 1;
  }

  setUiPreferences(patch: UiPreferencesPatch, expectedAccount?: AccountSpaceId): void {
    const before = this.store.get();
    const activeId = this.activeAccountSpaceId(before);
    if (expectedAccount !== undefined && activeId !== expectedAccount) throw new Error('The Account Space changed. Open the tool again.');
    const regularAccount = this.activeDownloadAccount(before);
    const { sidePanelTool, ...globalPreferences } = patch;
    const scopedTool = isPinnablePanelTool(sidePanelTool) ? sidePanelTool : undefined;
    const next = this.store.update((state) => {
      state.ui = mergeUiPreferences(state.ui, globalPreferences);
      // Keep settings and library views open when switching the account they show.
      if (sidePanelTool && !scopedTool) state.ui.sidePanelTool = sidePanelTool;
      if (scopedTool && !isPinnablePanelTool(state.ui.sidePanelTool)) state.ui.sidePanelTool = 'assistant';
      if (scopedTool && regularAccount) {
        const panels = state.sidePanelsByAccountSpace ??= {};
        panels[regularAccount] = { ...panels[regularAccount], tool: scopedTool };
      }
    });
    if (scopedTool && !regularAccount) this.temporaryPanelTools.set(activeId, scopedTool);
    if (next.ui.theme !== before.ui.theme) {
      nativeTheme.themeSource = next.ui.theme;
      this.applyFrameColors();
    }
    // Hide the previous tool before the renderer can report the next slot.
    this.layoutSideApps();
    this.broadcast();
  }

  setSidePanelPin(id: AccountSpaceId, tool: PinnablePanelTool, enabled: boolean): void {
    if (id !== this.activeDownloadAccount() || this.store.isReadOnly()) {
      throw new Error('Tool pins are unavailable in this Account Space.');
    }
    this.store.update((state) => {
      const panels = state.sidePanelsByAccountSpace ??= {};
      const current = panels[id];
      const pins = new Set(current?.pins);
      if (enabled) pins.add(tool);
      else pins.delete(tool);
      const updated = sanitizeAccountPanel({ ...current, pins: [...pins] });
      if (updated) panels[id] = updated;
      else delete panels[id];
    });
    this.broadcast();
  }

  /**
   * A still image of the active page, so trusted menus can draw over the
   * content area while the live view is hidden. Protected workspaces and
   * protected pages (banking, payment, identity) never leave pixels in the
   * chrome renderer: they fail closed to a neutral backdrop.
   */
  async freezeContent(): Promise<string | null> {
    if (this.visibleSplitTabId) return null;
    const tab = this.activeTab(this.store.get());
    const view = this.runtimeTabs.get(tab.id)?.view;
    const workspace = WORKSPACES.find((item) => item.id === tab.workspaceId);
    if (tab.isHome || !view || !view.getVisible() || workspace?.protected || isProtectedPage(tab.url)) return null;
    // The stored URL changes before a navigation commits, so also judge what the
    // view is actually painting, and refuse while a main-frame load is in flight.
    const painted = () => view.webContents.getURL();
    if (view.webContents.isLoadingMainFrame() || isProtectedPage(painted())) return null;
    const before = painted();
    const expires = performance.now() + MENU_FREEZE_BUDGET_MS;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const image = await Promise.race([
        view.webContents.capturePage(),
        new Promise<null>((resolve) => { deadline = setTimeout(() => resolve(null), MENU_FREEZE_BUDGET_MS); }),
      ]);
      if (!image || performance.now() >= expires || image.isEmpty() || !view.getVisible()
        || painted() !== before || isProtectedPage(painted())) return null;
      return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`;
    } catch {
      return null;
    } finally {
      if (deadline) clearTimeout(deadline);
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
    const tab = this.activeTab(this.store.get());
    if (this.runtimeTabs.get(tab.id)?.pdf?.mode === 'protected') throw new Error('Printing is blocked for this protected PDF.');
    const contents = this.activeContents();
    if (contents && !tab.isHome) contents.print({}, () => undefined);
  }

  async openPdfInTab(): Promise<void> {
    const state = this.store.get();
    const tab = this.activeTab(state);
    const runtime = this.runtimeTabs.get(tab.id);
    const document = runtime?.pdf;
    const contents = runtime?.view?.webContents;
    const account = state.accountSpaces.find(({ id }) => id === tab.accountSpaceId);
    if (!document?.canOpen || !contents || contents.isDestroyed() || !account || account.locked || this.sessionIsLocked
      || this.store.isReadOnly() || agentHost?.isLentContents(contents.id)) throw new Error('This PDF cannot be reopened from the current page.');
    if (document.mode === 'protected') {
      await this.protectedPdf.open(this.window, contents.session, document.url, () => !this.sessionIsLocked
        && !contents.isDestroyed() && this.activeTab(this.store.get()).id === tab.id && runtime?.pdf === document);
      return;
    }
    const id = this.addBackgroundTab(tab.workspaceId, document.url, tab.accountSpaceId, 'PDF document');
    if (!id) throw new Error('The PDF tab could not be created.');
    this.runtimeTabs.get(id)!.inlinePdfUrl = document.url;
    await this.activateTab(id);
  }

  savePdf(): void {
    const state = this.store.get();
    const tab = this.activeTab(state);
    const runtime = this.runtimeTabs.get(tab.id);
    const contents = this.activeContents();
    if (this.sessionIsLocked || this.store.isReadOnly() || !contents || runtime?.pdf?.mode !== 'native' || !runtime.pdf.canOpen
      || tab.workspaceId === 'banking' || agentHost?.isLentContents(contents.id)) {
      throw new Error('Saving is unavailable for this PDF in the current workspace.');
    }
    contents.downloadURL(runtime.pdf.url);
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
    this.requireEditableBookmarkAccount(accountSpaceId);
    if (key.kind === 'bookmark') this.requireActiveBookmark(key.id);
    this.store.update((state) => {
      const folders = state.bookmarkFoldersByAccountSpace ??= {};
      const result = reorderBookmarkLevel(state.bookmarks, folders[accountSpaceId] ?? [], accountSpaceId, level, key, toIndex);
      state.bookmarks = result.bookmarks;
      folders[accountSpaceId] = result.folders;
    });
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
    const current = this.store.get();
    const plan = changeBookmarkBatch(current.bookmarks, accountSpaceId, ids, destination, current.bookmarkFoldersByAccountSpace?.[accountSpaceId]);
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
    if (this.sessionIsLocked || account.locked || state.accountHealth.some((item) => item.accountSpaceId === active && item.status === 'account-corrupt')) {
      throw new Error('This Account Space is unavailable for bookmark changes.');
    }
  }

  renameBookmarkFolder(level: BookmarkLevelInput, name: string, nextName: string, accountSpaceId = this.activeBookmarkScope().accountSpaceId): void {
    const clean = nextName.trim();
    if (!clean || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error('Enter a folder name.');
    this.updateBookmarkFolder(accountSpaceId, { location: level.location, path: [...level.path, name] },
      { location: level.location, path: [...level.path, clean] });
  }

  removeBookmarkFolder(level: BookmarkLevelInput, name: string, accountSpaceId = this.activeBookmarkScope().accountSpaceId): void {
    this.updateBookmarkFolder(accountSpaceId, { location: level.location, path: [...level.path, name] });
  }

  addBookmarkFolder(accountId: AccountSpaceId, parent: BookmarkLevelInput, name: string): void {
    this.requireEditableBookmarkAccount(accountId);
    this.store.update((state) => {
      const folders = state.bookmarkFoldersByAccountSpace ??= {};
      folders[accountId] = createBookmarkFolder(state.bookmarks.filter((item) => item.accountSpaceId === accountId), folders[accountId] ?? [], parent, name);
    });
    this.broadcast();
  }

  moveBookmarkFolder(accountId: AccountSpaceId, folder: BookmarkLevelInput, parent: BookmarkLevelInput): void {
    const name = folder.path.at(-1);
    if (!name) throw new Error('Choose a folder to move.');
    this.updateBookmarkFolder(accountId, folder, { location: parent.location, path: [...parent.path, name] });
  }

  private updateBookmarkFolder(accountId: AccountSpaceId, source: BookmarkLevelInput, destination?: BookmarkLevelInput): void {
    this.requireEditableBookmarkAccount(accountId);
    this.store.update((state) => {
      const folders = state.bookmarkFoldersByAccountSpace ??= {};
      const result = editBookmarkFolder(state.bookmarks, folders[accountId] ?? [], accountId, source, destination);
      state.bookmarks = result.bookmarks;
      folders[accountId] = result.folders;
    });
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
    await writeFile(result.filePath, exportBookmarksHtml(bookmarks, state.bookmarkFoldersByAccountSpace?.[accountSpaceId]), { encoding: 'utf8' });
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
    if (batch.bookmarks.length || batch.folders.length) {
      this.store.update((state) => {
        const folders = state.bookmarkFoldersByAccountSpace ??= {};
        folders[accountSpaceId] = appendBookmarkFolders(folders[accountSpaceId] ?? [], batch.folders);
        imported = appendImportedBookmarks(state.bookmarks, batch.bookmarks);
      });
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
    const state = this.store.get();
    if (state.activeWorkspaceId === 'banking' || this.store.isReadOnly()) return [];
    const destinations = state.accountSpaces.filter((account) => account.workspaceId === state.activeWorkspaceId && isAvailableRegularAccount(state, account));
    return listChromeProfiles().map((profile) => {
      const imported = state.chromeProfileImports?.[chromeProfileKey(profile.id)];
      const matches = destinations.filter((account) => account.label.localeCompare(profile.name, undefined, { sensitivity: 'accent' }) === 0);
      return {
        ...profile, imported: Boolean(imported),
        importedInto: destinations.find(({ id }) => id === imported)?.id,
        suggestedAccountSpaceId: imported ? undefined : matches.length === 1 ? matches[0].id
          : profile.isDefault ? destinations.find(({ id }) => id === this.activeAccountSpaceId(state))?.id : undefined,
      };
    });
  }

  private unimportedChromeProfile(state: RuntimeBrowserStateV2, profileKey: string): void {
    if (state.chromeProfileImports?.[profileKey]) throw new Error('This Chrome profile has already been imported.');
    if (Object.keys(state.chromeProfileImports ?? {}).length >= MAX_CHROME_PROFILE_RECEIPTS) {
      throw new Error('This browser has reached its Chrome import receipt limit.');
    }
  }

  private requireChromeDestination(id: AccountSpaceId, workspaceId?: WorkspaceId) {
    const account = this.requireAccountMembership(id);
    if (this.store.isReadOnly() || !isAvailableRegularAccount(this.store.get(), account) || (workspaceId && workspaceId !== account.workspaceId)) {
      throw new Error('Choose an unlocked Account Space in the current regular workspace.');
    }
    return account;
  }

  private planScopedChromeImport(state: RuntimeBrowserStateV2, accountSpaceId: AccountSpaceId, source: ChromeProfileData) {
    return planChromeImport({
      bookmarks: state.bookmarks.filter((item) => item.accountSpaceId === accountSpaceId),
      history: state.history.filter((item) => item.accountSpaceId === accountSpaceId),
    }, source, state.bookmarkFoldersByAccountSpace?.[accountSpaceId]);
  }

  previewChromeImport(options: ChromeImportOptions): ChromeImportReview {
    const { accountSpaceId } = options;
    this.requireChromeDestination(accountSpaceId, options.workspaceId);
    const state = this.store.get();
    const profileKey = chromeProfileKey(options.profileId);
    this.unimportedChromeProfile(state, profileKey);
    this.pendingChromeImport = undefined;
    const source = readChromeProfile(options.profileId, options.workspaceId, accountSpaceId, options.bookmarks, options.history, undefined, options.settings);
    const plan = this.planScopedChromeImport(state, accountSpaceId, source);
    const id = randomUUID();
    const expiresIn = 5 * 60_000;
    this.pendingChromeImport = {
      id, accountSpaceId, initiatingAccount: this.activeAccountSpaceId(state), source, importKey: chromeImportKey(plan), expiresAt: Date.now() + expiresIn,
      profileKey, settingsRevision: source.settingsPatch ? JSON.stringify(settingsForWorkspace(state, options.workspaceId)) : undefined,
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
    const account = this.requireChromeDestination(review.accountSpaceId);
    const state = this.store.get();
    this.unimportedChromeProfile(state, review.profileKey);
    if (review.settingsRevision !== undefined && review.settingsRevision !== JSON.stringify(settingsForWorkspace(state, account.workspaceId))) {
      throw new Error('Workspace settings changed. Preview this Chrome import again.');
    }
    const plan = this.planScopedChromeImport(state, review.accountSpaceId, review.source);
    if (chromeImportKey(plan) !== review.importKey) throw new Error('Browsing data changed. Preview this Chrome import again.');
    return this.applyChromeImport(review.accountSpaceId, account.workspaceId, review.profileKey, plan);
  }

  importChrome(options: ChromeImportOptions): ChromeImportResult {
    this.requireChromeDestination(options.accountSpaceId, options.workspaceId);
    if (Object.values(options.settings ?? {}).some(Boolean)) throw new Error('Preview Chrome settings before importing them.');
    const state = this.store.get();
    const profileKey = chromeProfileKey(options.profileId);
    this.unimportedChromeProfile(state, profileKey);
    return this.applyChromeImport(options.accountSpaceId, options.workspaceId, profileKey, this.planScopedChromeImport(state, options.accountSpaceId,
      readChromeProfile(options.profileId, options.workspaceId, options.accountSpaceId, options.bookmarks, options.history)));
  }

  private applyChromeImport(id: AccountSpaceId, workspaceId: WorkspaceId, profileKey: string, plan: ReturnType<typeof planChromeImport>): ChromeImportResult {
    const patch = plan.summary.settingsPatch;
    if (plan.bookmarks.length || plan.history.length || plan.folders.length || patch) {
      const before = patch ? settingsForWorkspace(this.store.get(), workspaceId) : undefined;
      const newSettings = before && patch ? { workspaceId, before, after: mergeBrowserSettings(before, patch) } : undefined;
      this.store.update((state) => {
        state.bookmarks.push(...plan.bookmarks);
        const folders = state.bookmarkFoldersByAccountSpace ??= {};
        folders[id] = appendBookmarkFolders(folders[id] ?? [], plan.folders);
        state.history.push(...plan.history);
        state.history.sort((left, right) => right.visitedAt.localeCompare(left.visitedAt));
        (state.chromeProfileImports ??= {})[profileKey] = id;
        if (newSettings) (state.workspaceSettings ??= {})[workspaceId] = newSettings.after;
        state.privacyLog.unshift({
          id: randomUUID(), at: new Date().toISOString(), kind: 'local-read', title: 'Chrome data imported',
          detail: `${plan.bookmarks.length} bookmarks and ${plan.history.length} history entries imported locally`,
          accountSpaceId: id, service: 'browser',
        });
        state.privacyLog = state.privacyLog.slice(0, 100);
      });
      this.chromeImportUndo.set(id, {
        profileKey, settings: newSettings,
        bookmarks: new Map(plan.bookmarks.map((item) => [item.id, chromeImportBookmarkStamp(item)])),
        history: new Set(plan.history.map((item) => item.id)),
        folders: plan.folders,
      });
      this.broadcast();
    }
    return plan.summary.result;
  }

  canUndoChromeImport(id: AccountSpaceId): boolean {
    this.requireChromeDestination(id);
    return this.chromeImportUndo.has(id);
  }

  undoChromeImport(id: AccountSpaceId): { bookmarks: number; history: number; settingsRestored?: boolean } {
    this.requireChromeDestination(id);
    const undo = this.chromeImportUndo.get(id);
    const removed: { bookmarks: number; history: number; settingsRestored?: boolean } = { bookmarks: 0, history: 0 };
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
      const folders = state.bookmarkFoldersByAccountSpace ??= {};
      const previous = folders[id] ?? [];
      folders[id] = undoImportedBookmarkFolders(state.bookmarks.filter((item) => item.accountSpaceId === id), previous, undo.folders);
      const foldersRemoved = previous.length - folders[id].length;
      if (undo.settings) {
        const { workspaceId, before, after } = undo.settings;
        removed.settingsRestored = JSON.stringify(settingsForWorkspace(state, workspaceId)) === JSON.stringify(after);
        if (removed.settingsRestored) (state.workspaceSettings ??= {})[workspaceId] = before;
      }
      if (removed.bookmarks === undo.bookmarks.size && removed.history === undo.history.size
        && foldersRemoved === undo.folders.length && (!undo.settings || removed.settingsRestored) && state.chromeProfileImports?.[undo.profileKey] === id) {
        delete state.chromeProfileImports[undo.profileKey];
      }
    });
    this.chromeImportUndo.delete(id);
    this.broadcast();
    return removed;
  }

  toggleTrackerBlocking(): void {
    if (this.store.get().activeWorkspaceId === 'banking') throw new Error('Tracker blocking stays on in Banking.');
    this.store.update((state) => { state.trackerBlocking = !state.trackerBlocking; });
    this.broadcast();
  }

  setTrackerCompatibility(tabId: string, expectedOrigin: string, paused: boolean): void {
    const state = this.store.get();
    const tab = this.activeTab(state);
    const account = this.activeDownloadAccount(state);
    if (!account || this.store.isReadOnly() || tab.id !== tabId || tab.isHome
      || this.runtimeTabs.get(tab.id)?.problem === 'certificate' || !canPauseTrackersAt(tab.url) || safeOrigin(tab.url) !== expectedOrigin) {
      throw new Error('Tracker compatibility is unavailable on this page.');
    }
    if (paused && !state.trackerBlocking) throw new Error('Turn on tracker blocking before pausing it for one site.');
    this.trackerProtection.pause(account, expectedOrigin, paused);
    let timers = this.trackerExpiry.get(account);
    if (!timers) this.trackerExpiry.set(account, timers = new Map());
    clearTimeout(timers.get(expectedOrigin));
    timers.delete(expectedOrigin);
    if (paused) timers.set(expectedOrigin, setTimeout(() => {
      timers.delete(expectedOrigin);
      this.scheduleTrackerBroadcast();
    }, TRACKER_COMPATIBILITY_MS + 50).unref());
    this.broadcast();
  }

  setMemorySaverSite(tabId: string, expectedOrigin: string, keepAwake: boolean): void {
    const state = this.store.get();
    const tab = this.activeTab(state);
    const account = this.activeDownloadAccount(state);
    const origin = !tab.isHome && tab.id === tabId ? memorySaverOrigin(tab.url) : undefined;
    if (!account || !origin || origin !== expectedOrigin || this.store.isReadOnly()) {
      throw new Error('The site changed. Open Site information again.');
    }
    const record = this.accounts.update(account, (entry) => {
      const sites = new Set(entry.memorySaverExclusions);
      if (keepAwake) {
        if (sites.size >= MAX_MEMORY_SAVER_EXCLUSIONS && !sites.has(origin)) throw new Error('This Account Space already has 64 sites marked to stay awake.');
        sites.add(origin);
      } else {
        sites.delete(origin);
      }
      entry.memorySaverExclusions = [...sites];
    });
    this.store.refreshAccount(record);
    this.broadcast();
  }

  private scheduleTrackerBroadcast(): void {
    if (this.trackerBroadcast) return;
    this.trackerBroadcast = setTimeout(() => {
      this.trackerBroadcast = undefined;
      this.broadcast();
    }, 300).unref();
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

  cancelBridgePairing() { this.requireDeveloperWorkspace(); return this.vscodeBridge.cancelPairing(); }

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
    const allowed: ReadonlySet<string> = new Set(['project.open', 'project.revision', 'server.discover', 'server.status', 'server.start', 'server.stop', 'server.restart', 'inspect.open-source', 'test.configuration', 'test.run', 'test.cancel', 'test.rerun', 'test.save-artifact', 'ai.handoff', 'ai.apply-edits', 'ai.review-patch', 'ai.apply-patch', 'ai.undo-patch', 'ai.rerun-patch', 'reports.list', 'reports.search', 'reports.get', 'reports.delete', 'reports.clear', 'reports.open', 'reports.retention']);
    if (!allowed.has(action)) throw new Error('Unsupported VS Code action');
    const bridge = this.vscodeBridge.status();
    const projectId = bridge.project?.project.id;
    if (action === 'inspect.open-source') {
      const target = this.requireDeveloperTarget();
      const source = this.inspectedSource;
      if (this.sessionIsLocked || !source || source.reference !== payload.reference || source.projectId !== projectId
        || source.tabId !== target.tab.id || source.url !== target.tab.url || source.expiresAt <= Date.now()) {
        throw new Error('Inspect the current page again to confirm the source file.');
      }
      return this.vscodeBridge.request(action, { projectId, reference: source.reference });
    }
    if ((action.startsWith('test.') || action.startsWith('reports.')) && !projectId) throw new Error('Choose an approved workspace first.');
    if (action === 'ai.review-patch' || action === 'ai.apply-patch' || action === 'ai.undo-patch' || action === 'ai.rerun-patch') {
      if (!projectId) throw new Error('Choose an approved workspace first.');
      const [major, minor, patch] = (bridge.extensionVersion ?? '').split('.').map(Number);
      if (!(major > 0 || minor > 4 || (minor === 4 && patch >= 8))) throw new Error('Install Private Browser Bridge 0.4.8 or later for patch review.');
      const originalAccount = this.activeAccountSpaceId(this.store.get());
      if (action !== 'ai.review-patch' && (typeof payload.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(payload.id))) throw new Error('Review the patch before using it.');
      const result = await this.vscodeBridge.request(action, action === 'ai.review-patch'
        ? { projectId, request: reviewedPatchInputSchema.parse(payload) } : { projectId, id: payload.id });
      this.requireDeveloperWorkspace();
      if (this.sessionIsLocked || this.activeAccountSpaceId(this.store.get()) !== originalAccount || this.vscodeBridge.status().project?.project.id !== projectId) {
        throw new Error('The selected project or Account Space changed.');
      }
      return action === 'ai.rerun-patch' ? testReportSchema.parse(result) : reviewedPatchResultSchema.parse(result);
    }
    if (action === 'test.run' && payload.kind === 'record-flow') {
      const [major, minor, patch] = (bridge.extensionVersion ?? '').split('.').map(Number);
      if (!(major > 0 || minor > 4 || (minor === 4 && patch >= 7))) throw new Error('Install Private Browser Bridge 0.4.7 or later to record a fixture.');
      const active = this.requireDeveloperTarget().tab;
      const url = typeof payload.url === 'string' ? localDevelopmentAddress(payload.url) : undefined;
      if (!url || active.url !== url.href || url.search || url.hash || payload.liveUrl) {
        throw new Error('Open the local fixture in front and use its plain URL to record.');
      }
      const discovered = localDevelopmentAddress(bridge.project?.devServerUrl ?? '');
      if (discovered && discovered.origin !== url.origin) throw new Error('Open the selected project’s local fixture first.');
    }
    if (action === 'test.configuration' || (action === 'test.run' && (payload.viewports || payload.fixture
      || payload.kind === 'baseline' || payload.kind === 'baseline-compare'))) {
      const [major, minor, patch] = (bridge.extensionVersion ?? '').split('.').map(Number);
      if (!(major > 0 || minor > 4 || (minor === 4 && patch >= 5))) {
        throw new Error('Install Private Browser Bridge 0.4.5 or later for test scenarios.');
      }
    }
    if (action === 'test.configuration') {
      const result = await this.vscodeBridge.request(action, { projectId, includeKeyboard: true });
      this.requireDeveloperWorkspace();
      if (this.sessionIsLocked || this.vscodeBridge.status().project?.project.id !== projectId) throw new Error('The selected project changed.');
      return testConfigurationSchema.parse(result);
    }
    if (action === 'reports.search' || action === 'test.cancel' || (action === 'test.rerun' && payload.reportId)) {
      const [major, minor, patch] = (bridge.extensionVersion ?? '').split('.').map(Number);
      if (!(major > 0 || minor > 4 || (minor === 4 && patch >= 3))) {
        throw new Error('Install Private Browser Bridge 0.4.3 or later for report history and test controls.');
      }
    }
    if (action === 'reports.search') {
      const query = reportHistoryQuerySchema.parse(payload.query);
      const result = await this.vscodeBridge.request(action, { projectId, query });
      this.requireDeveloperWorkspace();
      if (this.sessionIsLocked || projectId !== this.vscodeBridge.status().project?.project.id) throw new Error('The selected project changed.');
      return reportHistoryPageSchema.parse(result);
    }
    if (action === 'project.revision') {
      if (!projectId) throw new Error('Choose an approved workspace first.');
      const [major, minor, patch] = (bridge.extensionVersion ?? '').split('.').map(Number);
      if (!(major > 0 || minor > 4 || (minor === 4 && patch >= 1))) {
        throw new Error('Install Private Browser Bridge 0.4.1 or later to view the Git revision.');
      }
      const result = await this.vscodeBridge.request(action, { projectId });
      this.requireDeveloperWorkspace();
      if (projectId !== this.vscodeBridge.status().project?.project.id) throw new Error('The selected project changed.');
      return gitRevisionSchema.nullable().parse(result);
    }
    if (action === 'server.status' || action === 'server.start' || action === 'server.restart' || action === 'server.stop') {
      if (!projectId) throw new Error('Choose an approved workspace first.');
      const [major, minor, patch] = (bridge.extensionVersion ?? '').split('.').map(Number);
      if (!(major > 0 || minor > 4 || (minor === 4 && patch >= 2))) {
        throw new Error('Install Private Browser Bridge 0.4.2 or later for development server controls.');
      }
      const originalTab = this.activeTab(this.store.get());
      const result = await this.vscodeBridge.request(action, { projectId, ...(action === 'server.status' && payload.refresh === true ? { refresh: true } : {}) });
      this.requireDeveloperWorkspace();
      const currentProject = this.vscodeBridge.status().project;
      if (this.sessionIsLocked || projectId !== currentProject?.project.id) throw new Error('The selected project changed.');
      if (action === 'server.stop') {
        if (currentProject.devServerUrl) this.vscodeBridge.setProject({ ...currentProject, devServerUrl: undefined });
        return result;
      }
      const rawStatus = action === 'server.status' ? result : result && typeof result === 'object' && 'status' in result ? result.status : undefined;
      const status = devServerStatusSchema.parse(rawStatus);
      if (currentProject.devServerUrl !== status.address) this.vscodeBridge.setProject({ ...currentProject, devServerUrl: status.address });
      const active = this.activeTab(this.store.get());
      if (action !== 'server.status' && status.address && originalTab.id === active.id && originalTab.url === active.url) {
        await this.navigate(status.address);
      }
      return status;
    }
    let safePayload: Record<string, unknown> = { ...payload, ...(projectId ? { projectId } : {}) };
    if (action === 'ai.handoff') {
      const preview = this.consumeAiApproval(String(payload.approvalToken ?? ''));
      safePayload = { projectId, action: String(payload.action ?? 'Diagnose').slice(0, 100), context: `${preview.text}${preview.dom ? `\n\nStructural DOM:\n${preview.dom}` : ''}` };
      this.addPrivacyEvent('cloud-approved', 'VS Code AI handoff approved', preview.title);
    }
    return this.vscodeBridge.request(action, safePayload);
  }

  async inspectDeveloperPage(selectElement: boolean): Promise<DeveloperPageInfo> {
    const target = this.requireDeveloperTarget();
    this.inspectedSource = undefined;
    const initialUrl = target.tab.url;
    const expression = selectElement ? `new Promise((resolve) => {
      const finish = (value) => { document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); resolve(value); };
      const selector = (node) => { if (node.id) return '#' + CSS.escape(node.id); const parts = []; for (let item = node; item && item.nodeType === 1 && parts.length < 5; item = item.parentElement) { let part = item.tagName.toLowerCase(); if (item.classList.length) part += '.' + [...item.classList].slice(0, 2).map((name) => CSS.escape(name)).join('.'); parts.unshift(part); } return parts.join(' > '); };
      const click = (event) => {
        event.preventDefault(); event.stopPropagation();
        const node = event.target;
        if (!(node instanceof Element)) { finish({}); return; }
        const source = node instanceof HTMLScriptElement ? node.src : node instanceof HTMLLinkElement && node.rel === 'stylesheet' ? node.href : undefined;
        finish({ route: location.pathname, framework: window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ? 'React' : 'Unknown', viewport: innerWidth + ' × ' + innerHeight, selector: selector(node), element: node.tagName.toLowerCase(), source });
      };
      const key = (event) => { if (event.key === 'Escape') finish({ route: location.pathname, framework: 'Unknown', viewport: innerWidth + '?' + innerHeight }); };
      document.addEventListener('click', click, true); document.addEventListener('keydown', key, true); setTimeout(() => finish({ route: location.pathname, framework: 'Unknown', viewport: innerWidth + '?' + innerHeight }), 60000);
    })` : `(() => ({ route: location.pathname, framework: window.__REACT_DEVTOOLS_GLOBAL_HOOK__ ? 'React' : 'Unknown', viewport: innerWidth + '?' + innerHeight }))()`;
    const result = await this.evaluateWithCdp(target.contents, expression, selectElement);
    const raw = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    const requireSamePage = () => {
      const current = this.requireDeveloperTarget();
      if (current.contents !== target.contents || current.tab.url !== initialUrl || this.sessionIsLocked) {
        throw new Error('The page changed. Inspect it again.');
      }
      return current;
    };
    const current = requireSamePage();
    const clean = (value: unknown, limit: number) => sanitizeDiagnosticText(String(value ?? ''), limit).text;
    const selector = clean(raw.selector, 500);
    const page: DeveloperPageInfo = { route: clean(raw.route, 1_000), framework: clean(raw.framework, 100), viewport: clean(raw.viewport, 50),
      ...(selector ? { selector, element: clean(raw.element, 100) } : {}),
      failures: current.runtime.network.slice(-12).reverse().map(({ redactions: _redactions, ...issue }) => issue) };
    const bridge = this.vscodeBridge.status();
    const project = bridge.project;
    if (bridge.state !== 'connected' || !project) return page;
    const nearest: DeveloperPageInfo = project.activeFile ? { ...page, confidence: 'nearest' } : page;
    const [major, minor, patch] = (bridge.extensionVersion ?? '').split('.').map(Number);
    if (!(major > 0 || minor > 4 || (minor === 4 && patch >= 4)) || !project.devServerUrl) return nearest;
    const original = new URL(initialUrl);
    const server = localDevelopmentAddress(project.devServerUrl);
    if (server?.origin !== original.origin) return nearest;
    const candidate = selectElement ? (typeof raw.source === 'string' ? localDevelopmentAddress(raw.source) : undefined) : original;
    if (!candidate || candidate.origin !== original.origin || (!selectElement && !/\.html?$/i.test(candidate.pathname))) return nearest;
    const pathname = inspectionSourcePath(candidate.pathname);
    if (!pathname) return nearest;
    const projectId = project.project.id;
    const match = inspectionSourceSchema.nullable().parse(await this.vscodeBridge.request('inspect.page', { projectId, pathname: candidate.pathname }));
    requireSamePage();
    const latest = this.vscodeBridge.status();
    if (!match || latest.project?.project.id !== projectId || latest.instanceId !== bridge.instanceId) return nearest;
    this.inspectedSource = { reference: match.reference, projectId, tabId: target.tab.id, url: initialUrl, expiresAt: Date.now() + 2 * 60_000 };
    return { ...page, confidence: 'exact', sourcePath: match.path, sourceReference: match.reference };
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
      capturedAt: report.capturedAt,
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
    const tab = this.activeTab(this.store.get());
    return this.controlCenter.tasks({ accountSpaceId: tab.accountSpaceId, url: tab.url });
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
      currentPage: { accountSpaceId: tab.accountSpaceId, url: tab.url },
      capturedAt: preview.capturedAt,
      ...(screenshot ? { screenshotJpegBase64: screenshot } : {}),
    });
  }

  async recheckControlCenterTask(input: ControlCenterRecheckInput) {
    this.requireDeveloperWorkspace();
    const preview = this.consumeDeveloperApproval(input.approvalToken);
    const tab = this.activeTab(this.store.get());
    if (!preview.capturedAt) throw new Error('Capture fresh evidence before attaching it.');
    if (preview.screenshotDataUrl) throw new Error('Capture a re-check before attaching evidence to an existing task.');
    this.addPrivacyEvent('cloud-approved', 'Control Center re-check approved', `${preview.title} · ${input.taskId}`);
    return this.controlCenter.addRecheck(input.taskId, { accountSpaceId: tab.accountSpaceId, url: tab.url }, developerEvidence(preview), preview.capturedAt);
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

  async prepareClaudeExcerpt(): Promise<PageExcerptReview> {
    this.claudeExcerpt = undefined;
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (!workspaceVaultPolicy(tab.workspaceId).aiExtraction || classifyAiSource(tab.url) !== 'browser') {
      throw new Error('Page excerpts are unavailable here.');
    }
    const capture = await this.captureAssistantSelection(tab, 'selection', MAX_ASSISTANT_SOURCE_TEXT);
    if (this.sessionIsLocked) throw new Error('The session locked before the selection was reviewed.');
    this.validateAssistantSource(capture.preview, capture.navigationGeneration);
    this.claudeExcerpt = { ...capture, expiresAt: Date.now() + 2 * 60_000 };
    const { id, url, text, redactions } = capture.preview;
    return { id, url, text, redactions: redactions - redactSensitiveText(tab.title).redactions };
  }

  cancelClaudeExcerpt(id: string): void {
    if (this.claudeExcerpt?.preview.id === id) this.claudeExcerpt = undefined;
  }

  async copyClaudeExcerpt(id: string): Promise<void> {
    const pending = this.claudeExcerpt;
    if (!pending || pending.preview.id !== id) throw new Error('Review the selection again before copying.');
    this.claudeExcerpt = undefined;
    await this.clipboardGuard.copy(pending.preview.text, () => {
      if (this.sessionIsLocked || clipboardQuit !== 'not-started' || pending.expiresAt <= Date.now()) {
        throw new Error('Review the selection again before copying.');
      }
      this.validateAssistantSource(pending.preview, pending.navigationGeneration);
    });
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
      this.addPrivacyEvent(kind, 'Assistant request completed', 'Provider returned a response', pending.preview.accountSpaceId);
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
    this.addPrivacyEvent(mode === 'local' ? 'local-read' : 'cloud-approved', mode === 'local' ? 'Local AI request completed' : 'Cloud AI request completed', 'Provider returned a response', preview.accountSpaceId);
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
    this.claudeExcerpt = undefined;
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
      conflictRecoveryAvailable: status.lifecycle === 'unlocked' && this.activeVaultPolicy().vaultSurface && Boolean(this.vault.conflictRecoveryFolder()),
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
    this.armWordPressSave(this.activeTab(this.store.get()).id);
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
    this.armWordPressSave(this.activeTab(this.store.get()).id);
    return this.listVault();
  }

  async lockVault() {
    this.clearWordPressCaptures();
    this.secureDialogs.closeAll();
    this.vaultConflictOwner = undefined;
    this.vaultSync.clearConflictReview();
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
    const account = this.activeAccountSpaceId(this.store.get());
    const review = await this.vaultSync.reviewConflict();
    this.assertVaultSurface();
    if (account !== this.activeAccountSpaceId(this.store.get())) throw new Error('The Account Space changed. Review the conflict again.');
    this.vaultConflictOwner = { id: review.id, account };
    const describe = (entries: typeof review.local, other: typeof review.local, updatedAt: string): VaultConflictSide => {
      const counterpart = new Map(other.map((item) => [item.id, item]));
      const changes: VaultConflictSide['changes'] = [];
      for (const item of entries) {
        const prior = counterpart.get(item.id);
        if (prior && prior.updatedAt === item.updatedAt && prior.title === item.title && prior.username === item.username
          && prior.type === item.type && prior.url === item.url && prior.favorite === item.favorite) continue;
        changes.push({ id: item.id, label: item.title, username: item.username, kind: prior ? 'changed' : 'only-copy' });
      }
      return { updatedAt, entries: entries.length, changes };
    };
    return { id: review.id, cloudVersion: review.cloudVersion, local: describe(review.local, review.cloud, review.localUpdatedAt),
      cloud: describe(review.cloud, review.local, review.cloudUpdatedAt), itemChoices: review.itemChoices };
  }

  async resolveVaultConflict(choice: VaultConflictResolution, reviewId: string) {
    this.assertVaultSurface();
    const owner = this.vaultConflictOwner;
    if (!owner || owner.id !== reviewId || owner.account !== this.activeAccountSpaceId(this.store.get())) {
      throw new Error('Review the current MyVault conflict in this Account Space first.');
    }
    this.vaultConflictOwner = undefined;
    const assertOwner = () => {
      this.assertVaultSurface();
      if (owner.account !== this.activeAccountSpaceId(this.store.get())) throw new Error('The Account Space changed. Review the conflict again.');
    };
    await this.vaultSync.resolveConflict(choice, reviewId, assertOwner);
    return this.listVault();
  }

  async showVaultConflictRecovery(): Promise<void> {
    this.assertVaultSurface();
    if (this.vault.status().lifecycle !== 'unlocked') throw new Error('Unlock MyVault to open its recovery folder.');
    const path = this.vault.conflictRecoveryFolder();
    if (!path) throw new Error('No conflict recovery files are present.');
    if (await shell.openPath(path)) throw new Error('Windows could not open the recovery folder.');
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

  private wordPressSiteStatus(tab: BrowserTab): BrowserSnapshot['wordPressSaveSite'] {
    const runtime = this.runtimeTabs.get(tab.id);
    const flow = workspaceVaultPolicy(tab.workspaceId).saveCapture && !tab.isHome && !runtime?.certificateError
      ? wordPressLoginFlow(tab.url) : undefined;
    if (flow) return { origin: flow.origin, enabled: this.store.offersWordPressSave(tab.accountSpaceId, flow.origin) };
    return undefined;
  }

  setWordPressSaveSite(id: string, origin: string, enabled: boolean): void {
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (id !== tab.id || this.wordPressSiteStatus(tab)?.origin !== origin || this.activeDownloadAccount(state) !== tab.accountSpaceId) {
      throw new Error('The site changed. Open Site information again.');
    }
    this.saveWordPressPreference(tab.accountSpaceId, origin, enabled);
    this.armWordPressSave(tab.id);
    this.broadcast();
  }

  private saveWordPressPreference(id: AccountSpaceId, origin: string, enabled: boolean): void {
    const record = this.accounts.update(id, (entry) => {
      const origins = new Set(entry.wordPressSaveOrigins);
      if (enabled && origins.size >= MAX_WORDPRESS_SAVE_ORIGINS && !origins.has(origin)) throw new Error('This Account Space already has 100 sites enabled.');
      if (enabled) origins.add(origin);
      else origins.delete(origin);
      entry.wordPressSaveOrigins = [...origins];
    });
    this.store.refreshAccount(record);
  }

  private wordPressScopeIsCurrent(tabId: string, contents: Electron.WebContents): boolean {
    const state = this.store.get();
    const tab = this.activeTab(state);
    const runtime = this.runtimeTabs.get(tabId);
    return tab.id === tabId && this.activeDownloadAccount(state) === tab.accountSpaceId && !tab.isHome && !this.store.isReadOnly()
      && !runtime?.certificateError && runtime?.view?.webContents === contents && !contents.isDestroyed()
      && !agentHost?.isLentContents(contents.id) && workspaceVaultPolicy(tab.workspaceId).saveCapture && this.vault.status().lifecycle === 'unlocked';
  }

  private armWordPressSave(tabId: string): void {
    const runtime = this.runtimeTabs.get(tabId);
    const contents = runtime?.view?.webContents;
    if (!runtime || !contents || contents.isDestroyed()) return;
    runtime.wordPressAttempt?.clear();
    const flow = wordPressLoginFlow(contents.getURL());
    const tab = this.store.getTab(tabId);
    if (!flow || !tab || !this.wordPressScopeIsCurrent(tabId, contents) || !this.store.offersWordPressSave(tab.accountSpaceId, flow.origin)) {
      if (runtime.wordPressAttempt) contents.send('wordpress-save:arm', undefined);
      runtime.wordPressAttempt = undefined;
      return;
    }
    const attempt = runtime.wordPressAttempt = new WordPressLoginAttempt();
    contents.send('wordpress-save:arm', { nonce: attempt.arm(flow), flow });
  }

  private clearWordPressCaptures(): void {
    this.wordPressPrompt?.abort();
    for (const runtime of this.runtimeTabs.values()) runtime.wordPressAttempt?.clear();
  }

  private observeWordPressLogin(details: Electron.OnHeadersReceivedListenerDetails): void {
    if (details.resourceType !== 'mainFrame' || details.method !== 'POST' || details.webContentsId === undefined) return;
    this.contentsTabs.get(details.webContentsId)?.wordPressAttempt?.response(details);
  }

  private async offerWordPressSave(tabId: string, url: string, status: number): Promise<void> {
    const runtime = this.runtimeTabs.get(tabId);
    const contents = runtime?.view?.webContents;
    const candidate = runtime?.wordPressAttempt?.commit(url, status);
    if (!candidate) return;
    const abort = new AbortController();
    try {
      if (!contents || !runtime || !this.wordPressScopeIsCurrent(tabId, contents) || this.wordPressPrompt || this.pendingPermission) return;
      const initial = this.currentFillContext();
      if (candidate.origin !== initial.origin || !this.store.offersWordPressSave(initial.accountSpaceId, candidate.origin)) return;
      const matches = this.vault.searchMetadata('', candidate.origin).filter((entry) => entry.url && isAutofillTarget(entry.url, candidate.origin) && entry.username === candidate.username);
      if (matches.length > 1) return;
      const match = matches[0];
      if (match && this.vault.resolveSecretForTrustedOperation(match.id, 'password') === candidate.password.toString('utf8')) return;
      this.wordPressPrompt = abort;
      const timer = setTimeout(() => { candidate.password.fill(0); abort.abort(); }, 30_000);
      timer.unref();
      try {
        const { response } = await dialog.showMessageBox(this.window, { type: 'question', title: 'MyVault',
          message: match ? 'Update saved login?' : 'Save login?', detail: `${candidate.origin}\n${candidate.username}`,
          buttons: [match ? 'Update login' : 'Save login', 'Not now', 'Never on this site'], defaultId: 1, cancelId: 1, signal: abort.signal });
        if (abort.signal.aborted || !this.wordPressScopeIsCurrent(tabId, contents)
          || JSON.stringify(this.currentFillContext()) !== JSON.stringify(initial)) return;
        if (response === 2) {
          this.saveWordPressPreference(initial.accountSpaceId, candidate.origin, false);
          this.broadcast();
        } else if (response === 0) {
          const current = this.vault.searchMetadata('', candidate.origin).filter((entry) => entry.url && isAutofillTarget(entry.url, candidate.origin) && entry.username === candidate.username);
          if (current.length !== matches.length || current[0]?.id !== match?.id || current[0]?.updatedAt !== match?.updatedAt) return;
          await this.vault.saveLogin({ id: match?.id, title: match?.title ?? new URL(candidate.origin).hostname, url: candidate.origin,
            username: candidate.username, password: candidate.password.toString('utf8') });
          this.addPrivacyEvent('vault', match ? 'MyVault login updated' : 'MyVault login saved', candidate.origin, initial.accountSpaceId);
        }
      } finally { clearTimeout(timer); }
    } catch {
      // A lock, closed tab or expired decision invalidates the candidate.
    } finally {
      if (this.wordPressPrompt === abort) this.wordPressPrompt = undefined;
      candidate.password.fill(0);
    }
  }

  async copyGeneratedCredential(kind: GeneratedCredentialKind): Promise<void> {
    const policy = this.activeVaultPolicy();
    if (!policy.vaultSurface || !policy.passwordClipboard) throw new Error('Credential clipboard is disabled in this workspace');
    if (!['password', 'passphrase', 'pin'].includes(kind)) throw new Error('Unsupported generator type');
    await this.copySensitiveValue(this.vault.generateCredential(kind));
    this.addPrivacyEvent('vault', 'Generated credential copied', 'Generated by the broker; clipboard auto-clear enabled');
  }

  private activeDownloadAccount(state = this.store.get()): AccountSpaceId | undefined {
    if (this.sessionIsLocked) return undefined;
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

  private downloadSnapshot(accountId: AccountSpaceId): { downloads: DownloadEntry[]; downloadBatch: DownloadBatchStatus } {
    const live = [...this.downloads.values()].filter((entry) => entry.accountSpaceId === accountId);
    const retained = this.downloadHistory.entries(accountId).filter(({ entry }) => !this.downloads.has(entry.id));
    const downloadBatch = { active: 0, completed: 0, stopped: 0 };
    const downloads: DownloadEntry[] = live.map(({ savePath: _path, expectedInstaller: _expected, verifiedStamp: _stamp, retainedFileStamp: _retained, ...entry }) => {
      if (entry.state === 'progressing' || entry.canCancel) downloadBatch.active++;
      else if (entry.state === 'completed') downloadBatch.completed++;
      else downloadBatch.stopped++;
      return entry;
    });
    downloads.push(...retained.map(({ entry }) => entry));
    return { downloads, downloadBatch };
  }

  private scheduleDownloadProgress(accountSpaceId: AccountSpaceId): void {
    this.downloadProgressRevision++;
    this.downloadProgressAccounts.add(accountSpaceId);
    if (this.downloadProgressTimer) return;
    this.downloadProgressTimer = setTimeout(() => {
      this.downloadProgressTimer = undefined;
      const active = this.activeDownloadAccount();
      const changed = active && this.downloadProgressAccounts.has(active);
      this.downloadProgressAccounts.clear();
      if (!active || !changed || !this.window || this.window.isDestroyed()) return;
      const entries: DownloadByteProgress['entries'] = [];
      for (const { accountSpaceId, id, receivedBytes, totalBytes, state } of this.downloads.values()) {
        if (accountSpaceId === active && state === 'progressing') entries.push({ id, receivedBytes, totalBytes });
      }
      this.window.webContents.send('downloads:progress', { accountSpaceId: active, revision: this.downloadProgressRevision, entries } satisfies DownloadByteProgress);
    }, DOWNLOAD_PROGRESS_INTERVAL_MS).unref();
  }

  private assertOwnDownloadFolder(accountId: AccountSpaceId): void {
    if (accountId !== this.activeDownloadAccount() || this.store.isReadOnly()) {
      throw new Error('Download folders are unavailable in this Account Space.');
    }
  }

  async chooseDownloadFolder(accountId: AccountSpaceId): Promise<void> {
    this.assertOwnDownloadFolder(accountId);
    if (this.downloadFolderPickerOpen) throw new Error('The download folder picker is already open.');
    if (!this.downloadFolder.status(accountId).available) throw new Error('Windows protected storage is unavailable for download folders.');
    this.downloadFolderPickerOpen = true;
    try {
      const choice = await dialog.showOpenDialog(this.window, {
        title: 'Choose a download folder for this Account Space',
        defaultPath: this.downloadFolder.get(accountId)?.path ?? app.getPath('downloads'),
        properties: ['openDirectory', 'dontAddToRecent'],
      });
      if (choice.canceled || !choice.filePaths[0]) return;
      this.assertOwnDownloadFolder(accountId);
      this.downloadFolder.choose(accountId, choice.filePaths[0]);
      this.broadcast();
    } finally {
      this.downloadFolderPickerOpen = false;
    }
  }

  setDownloadFolderMode(accountId: AccountSpaceId, mode: DownloadFolderMode): void {
    this.assertOwnDownloadFolder(accountId);
    if (mode === 'default') this.downloadFolder.forgetAccount(accountId);
    else this.downloadFolder.setAsk(accountId, mode === 'ask');
    this.broadcast();
  }

  private setDownloadDestination(entry: LocalDownload, item: DownloadItem): string | undefined {
    const state = this.store.get();
    const account = state.accountSpaces.find(({ id }) => id === entry.accountSpaceId);
    if (!account || !isAvailableRegularAccount(state, account) || this.store.isReadOnly()) return;
    try {
      const preference = this.downloadFolder.get(entry.accountSpaceId);
      if (!preference) return;
      const folder = availableDownloadFolder(preference.path);
      const filename = safeDownloadFilename(entry.filename);
      if (preference.ask || entry.risk !== 'ordinary' || downloadRisk(filename) !== 'ordinary' || entry.expectedInstaller) {
        item.setSaveDialogOptions({ defaultPath: join(folder, filename), properties: ['dontAddToRecent'] });
        return;
      }
      const staged = stageDownload(folder, filename);
      try {
        item.setSavePath(staged);
        return staged;
      } catch (error) {
        void discardDownloadStage(staged);
        throw error;
      }
    } catch {
      entry.destinationNote = 'folder-unavailable';
    }
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
    if (entry.state === 'progressing' || this.downloadItems.has(id) || entry.checksum === 'checking') throw new Error('Wait until this download finishes.');
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

  async requestDownloadEnrollment() {
    const account = this.activeDownloadAccount();
    if (!account || this.store.isReadOnly()) throw new Error('Use an unlocked regular Account Space to enroll this device.');
    if (this.downloadEnrollment) throw new Error('Finish the current download enrollment first.');
    const operation = new AbortController();
    this.downloadEnrollment = operation;
    try {
      const value = await this.secureDialogs.open('enroll-download-device');
      if (!value || !('code' in value)) return undefined;
      operation.signal.throwIfAborted();
      if (this.activeDownloadAccount() !== account) throw new Error('The Account Space changed. Start enrollment again.');
      const result = await this.updates.enrollDevice(value.code, app.getVersion(), operation.signal);
      this.addPrivacyEvent('vault', 'Private download device enrolled', 'Windows protects this device’s update credential', account);
      return result;
    } finally { if (this.downloadEnrollment === operation) this.downloadEnrollment = undefined; }
  }

  configureUpdateService(input: UpdateServiceInput) {
    if (this.downloadEnrollment) throw new Error('Finish the current download enrollment first.');
    const status = this.updates.configure(input, app.getVersion());
    this.addPrivacyEvent('vault', 'Download service connected', status.endpoint ?? 'Encrypted update service');
    return status;
  }

  clearUpdateService() {
    if (this.downloadEnrollment) throw new Error('Finish the current download enrollment first.');
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
    if (this.getUpdateService().deviceEnrolled) throw new Error('Download the verified private installer from App updates.');
    const result = await this.checkForUpdates();
    await this.newTab('development', result.latest.downloadPageUrl);
  }

  async openReleaseHistory(): Promise<void> {
    await this.newTab('development', PUBLIC_UPDATE_ENDPOINT + '/#release-history');
  }

  downloadManagedUpdate(version: string, sha256: string): Promise<void> { return this.managedUpdate.download(version, sha256); }

  cancelManagedUpdate(): void { this.managedUpdate.cancel(); }

  installManagedUpdate(): Promise<void> { return this.managedUpdate.install(); }

  async checkForUpdatesInBackground(): Promise<void> {
    if (this.sessionIsLocked || this.window.isDestroyed()) return;
    try {
      const result = await this.checkForUpdates();
      if (!this.sessionIsLocked && result.state === 'available') this.window.webContents.send('updates:available', result);
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
    return { loading: false, canGoBack: false, canGoForward: false, developerToolsOpen: false, console: [], network: [], navigationGeneration: 0, certificateError: false, automaticFillPending: false,
      memorySaver: { lastVisibleAt: Date.now() } };
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
    trackNetworkFailure(target.runtime.network, {
      at: new Date().toISOString(),
      method: details.method.slice(0, 16),
      resourceType: details.resourceType,
      url: url.text,
      ...('statusCode' in details ? { status: details.statusCode } : {}),
      ...(error.text ? { error: error.text } : {}),
      redactions: url.redactions + error.redactions,
    });
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
    if (runtime.view && !runtime.view.webContents.isDestroyed()) return runtime.view;
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
        ...(workspaceVaultPolicy(tab.workspaceId).saveCapture ? { preload: join(import.meta.dirname, 'myvault/wordpress-save-preload.cjs') } : {}),
      },
    });
    runtime.view = view;
    runtime.sleeping = undefined;
    runtime.sleepPending = false;
    runtime.memorySaver = { lastVisibleAt: Date.now() };
    const contentsId = view.webContents.id;
    this.contentsTabs.set(contentsId, runtime);
    view.webContents.once('destroyed', () => {
      runtime.wordPressAttempt?.clear();
      this.contentsTabs.delete(contentsId);
    });
    view.webContents.on('ipc-message', (event, channel, ...args: unknown[]) => {
      if (channel !== 'wordpress-save:submitted' || event.senderFrame !== view.webContents.mainFrame || args.length !== 3
        || !runtime.wordPressAttempt || !view.getVisible() || !this.wordPressScopeIsCurrent(tabId, view.webContents)) return;
      runtime.wordPressAttempt.submit(args[0], args[1], args[2]);
    });
    this.window.contentView.addChildView(view);
    // Every guard is attached before anything below that could throw: a view
    // that exists without them would run a hostile page with no popup,
    // navigation or tab-tracking control for its whole life (F-28).
    const popupTimes: number[] = [];
    // `popup` is set when the request comes from a popup window this tab opened.
    const openFromPage = ({ url, disposition, postBody }: HandlerDetails, popup?: BrowserWindow): WindowOpenHandlerResponse => {
      if (agentHost?.isLentContents(view.webContents.id)) return { action: 'deny' };
      if (tab.workspaceId === 'banking') {
        this.addPrivacyEvent('blocked', 'Popup blocked in Banking', 'Banking blocks site-opened windows. Open a link yourself from the original tab if you trust the address.', tab.accountSpaceId);
        return { action: 'deny' };
      }
      if (!isAllowedRemoteUrl(url)) {
        this.addPrivacyEvent('blocked', 'Popup address blocked', 'Site-opened windows require an HTTP or HTTPS address. Check the link on the original page.', tab.accountSpaceId);
        return { action: 'deny' };
      }
      const now = Date.now();
      while (popupTimes.length && now - popupTimes[0]! > POPUP_WINDOW_MS) popupTimes.shift();
      if (popupTimes.length >= MAX_POPUPS_PER_WINDOW) {
        this.addPrivacyEvent('blocked', 'Popups blocked', `${urlOriginForSharing(url)} opened too many windows. Wait a few seconds, then reopen the page.`, tab.accountSpaceId);
        return { action: 'deny' };
      }
      popupTimes.push(now);
      // Only the page the user is looking at may take the foreground; a hidden
      // or background tab's popup is added behind the current one (F-31).
      const opener = this.activeTab(this.store.get());
      const inForeground = popup
        ? !popup.isDestroyed() && popup.isFocused()
        : opener.id === tabId && view.getVisible() && !this.window.isDestroyed() && this.window.isFocused();
      if (inForeground && wantsPopupWindow(disposition)) {
        if (this.popupReview.pending || this.pendingPermission) {
          this.addPrivacyEvent('blocked', 'Popup waiting for an earlier decision', 'Finish the open permission or window review, then try again from the page.', tab.accountSpaceId);
          return { action: 'deny' };
        }
        const from = popup?.webContents ?? view.webContents;
        const requestOrigin = safeOrigin(from.getURL());
        const destination = safeOrigin(url);
        const generation = runtime.navigationGeneration;
        const requestPage = from.getURL();
        const account = this.accounts.require(tab.accountSpaceId);
        const accountLabel = account.label.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 100);
        return popupWindowResponse(this.window, (options) => {
          const child = new BrowserWindow({ ...options, show: false });
          adoptPopupWindow(child, (window) => (details) => openFromPage(details, window));
          this.popupReview.start(child, {
            url, method: postBody ? 'POST' : 'GET',
            current: () => !this.sessionIsLocked && !from.isDestroyed() && from.getURL() === requestPage
              && runtime.navigationGeneration === generation && this.activeTab(this.store.get()).id === tabId
              && !agentHost?.isLentContents(view.webContents.id),
            ask: (signal) => dialog.showMessageBox(this.window, {
              type: 'question', title: 'Review site-opened window', message: 'Open this window?',
              detail: ['Requesting site: ' + requestOrigin, 'Destination: ' + destination, 'Account Space: ' + accountLabel,
                'Continue only if you expected this sign-in or payment. This request expires after 30 seconds.'].join('\n'),
              buttons: ['Continue', 'Cancel'], defaultId: 1, cancelId: 1, signal,
            }).then(({ response }) => response === 0),
            finish: (outcome) => {
              if (outcome === 'continued' || this.window.isDestroyed()) return;
              const reason = outcome === 'expired' ? 'The window review expired.'
                : outcome === 'changed' ? 'The original page or Account Space changed.' : 'You cancelled the window.';
              this.addPrivacyEvent('blocked', 'Site-opened window stopped', reason + ' Try again from the original page.', tab.accountSpaceId);
            },
          });
          return child.webContents;
        });
      }
      if (inForeground) void this.newTab(tab.workspaceId, stripTrackingParameters(url), tab.accountSpaceId);
      else this.addBackgroundTab(tab.workspaceId, stripTrackingParameters(url), tab.accountSpaceId);
      return { action: 'deny' };
    };
    view.webContents.setWindowOpenHandler((details) => openFromPage(details));
    guardPageNavigation(view.webContents);
    view.webContents.on('will-frame-navigate', (event) => {
      if (event.url.startsWith('chrome-extension:') && tab.workspaceId === 'banking') {
        event.preventDefault();
      }
    });
    view.webContents.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      if (!_isInPlace) {
        if (runtime.pdf?.mode === 'protected') this.protectedPdf.close();
        runtime.pdf = undefined;
        if (runtime.inlinePdfUrl !== url) runtime.inlinePdfUrl = undefined;
      }
      if (this.wordPressPrompt && this.activeTab(this.store.get()).id === tabId) this.wordPressPrompt.abort();
      if (isProtectedPage(url)) this.endSplitForTab(tabId, tab.accountSpaceId);
      if (runtime.problem && !this.overlayOpen && this.activeTab(this.store.get()).id === tabId) view.setVisible(true);
      runtime.navigationGeneration += 1;
      if (!_isInPlace) runtime.favicon = undefined;
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
      runtime.wordPressAttempt?.clear();
      if (runtime.pdf?.mode === 'protected' && runtime.pdf.url === url) return;
      const problem = problemForFailedLoad(code, runtime.certificateError);
      if (problem) this.markTabProblem(tabId, problem, url);
    });
    view.webContents.on('did-start-loading', () => this.updateRuntime(tabId, { loading: true }));
    view.webContents.on('did-stop-loading', () => this.updateRuntime(tabId, { loading: false }));
    view.webContents.on('did-finish-load', () => {
      void this.updateGoogleWebsiteState(tabId, view);
      this.scheduleAutomaticFill(tabId);
      this.armWordPressSave(tabId);
    });
    view.webContents.on('did-navigate', (_event, url, status) => {
      this.commitNavigation(tabId, url);
      void this.offerWordPressSave(tabId, url, status);
    });
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      runtime.wordPressAttempt?.clear();
      this.commitNavigation(tabId, url, false);
      this.scheduleAutomaticFill(tabId);
    });
    view.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      this.store.update((state) => {
        const target = state.tabs.find((candidate) => candidate.id === tabId);
        if (target) target.title = title || 'Untitled';
      }, 'routine');
      this.broadcast();
    });
    view.webContents.on('page-favicon-updated', (_event, favicons) => void this.updateFavicon(tabId, ses, favicons[0]));
    view.webContents.on('devtools-opened', () => {
      this.endSplitForTab(tabId, tab.accountSpaceId);
      this.passkeyController.detach(view.webContents);
      this.updateRuntime(tabId, { developerToolsOpen: true });
    });
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
        () => Boolean(this.developerTarget(tabId)),
        this.notesSourceCurrent(tabId, generation) ? (selection) => this.prepareNotesDraft(tabId, generation, selection) : undefined);
    });
    view.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown') {
        runtime.memorySaver.interacted = true;
        this.focusSplitTab(tabId, view);
      }
      if (!agentHost?.isLentContents(view.webContents.id) && this.handleFillPickerKey(tabId, event, input)) return;
      this.handleShortcut(event, input);
    });
    view.webContents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown') this.focusSplitTab(tabId, view);
    });
    // Only genuine user input opens the login picker; nothing the page does can.
    view.webContents.on('input-event', (_event, input) => {
      if (input.type === 'mouseDown' || input.type === 'mouseWheel' || input.type === 'gestureScrollBegin') runtime.memorySaver.interacted = true;
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
      const capability = permissionCapability(permission, details);
      if (protectedWorkspace || !details.isMainFrame || agentHost?.isLentContents(_webContents?.id)) {
        callback(false);
        if (capability && protectedWorkspace) this.logBlockedPermission(accountSpaceId, capability, 'Banking blocks site permissions. Use a regular Account Space for a call or notifications.');
        return;
      }
      if (!capability) {
        callback(isAllowedSitePermission(permission, details.requestingUrl, false, details.isMainFrame));
        return;
      }
      const origin = safeOrigin(details.requestingUrl);
      const evaluation = this.permissions.evaluate(accountSpaceId, workspaceId, origin, capability);
      if (evaluation !== 'prompt') {
        callback(evaluation === 'granted');
        if (evaluation === 'denied') {
          const guidance = capability === 'geolocation' ? 'This browser blocks location access from websites.'
            : capability === 'notifications' ? 'Notifications require an allowed Google service origin.'
              : 'Camera, microphone and screen sharing require the Google Meet site.';
          this.logBlockedPermission(accountSpaceId, capability, guidance + ' Review Site permissions from the address bar.');
        }
        return;
      }
      try {
        const secondary = this.visibleSplitTabId ? this.runtimeTabs.get(this.visibleSplitTabId)?.view : undefined;
        if (secondary && _webContents === secondary.webContents) callback(false);
        else this.queuePermissionPrompt(this.permissions.createPrompt(accountSpaceId, workspaceId, origin, capability), callback);
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
        if (active.accountSpaceId === accountSpaceId) {
          this.logBlockedPermission(accountSpaceId, 'display-capture', protectedWorkspace
            ? 'Banking blocks screen sharing. Use Google Meet in a regular Account Space.'
            : 'Open Google Meet in front, then start screen sharing from that page.');
        }
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
    const checkRequest = (details: Electron.OnBeforeRequestListenerDetails, callback: (result: Electron.CallbackResponse) => void) => {
      if (agentHost?.allowLentRequest(details) === false) { callback({ cancel: true }); return; }
      if (details.resourceType === 'mainFrame' && details.webContentsId !== undefined) {
        const tab = this.contentsTabs.get(details.webContentsId);
        if (tab) tab.memorySaver.request = { url: details.url, method: details.method };
      }
      const category = trackerCategory(details.url);
      const enabled = this.store.trackerBlockingEnabled();
      if (!category || (!enabled && !protectedWorkspace)) { callback({ cancel: false }); return; }
      let top: string | undefined;
      if (details.resourceType !== 'mainFrame') {
        try { top = details.frame?.top?.url; } catch { /* The requesting frame may have closed. */ }
      }
      const origin = top && isAllowedRemoteUrl(top) ? safeOrigin(top) : undefined;
      const strict = protectedWorkspace || Boolean(top && isProtectedPage(top));
      const blocked = this.trackerProtection.shouldBlock(accountSpaceId, category, { origin, strict, enabled });
      if (blocked && origin) this.scheduleTrackerBroadcast();
      callback({ cancel: blocked });
    };
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (!this.popupReview.hold(details, (allowed) => {
        if (allowed) checkRequest(details, callback);
        else callback({ cancel: true });
      })) checkRequest(details, callback);
    });
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } });
    });
    ses.webRequest.onHeadersReceived((details, callback) => {
      this.observeWordPressLogin(details);
      if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') { callback({}); return; }
      const runtime = details.webContentsId === undefined ? undefined : this.contentsTabs.get(details.webContentsId);
      const protectedDocument = protectedWorkspace;
      if (!pdfResponse(details.responseHeaders)) {
        callback(protectedDocument ? { responseHeaders: blockInlinePdf(details.responseHeaders) } : {});
        return;
      }
      if (details.resourceType === 'mainFrame' && runtime && isAllowedRemoteUrl(details.url)) {
        runtime.pdf = { url: details.url, mode: protectedDocument ? 'protected' : 'native', canOpen: details.method === 'GET' };
        if (protectedDocument) {
          runtime.view?.setVisible(false);
          callback({ cancel: true });
        } else if (runtime.inlinePdfUrl === details.url) {
          const responseHeaders = { ...details.responseHeaders };
          const disposition = Object.keys(responseHeaders).find((key) => key.toLowerCase() === 'content-disposition') ?? 'Content-Disposition';
          responseHeaders[disposition] = ['inline'];
          callback({ responseHeaders });
        } else callback({});
        queueMicrotask(() => { if (!this.window.isDestroyed()) { this.applyLayout(); this.broadcast(); } });
        return;
      }
      callback({ cancel: protectedDocument });
    });
    ses.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400) this.recordNetworkIssue(details);
    });
    ses.webRequest.onErrorOccurred((details) => this.recordNetworkIssue(details));
    ses.on('will-download', (event, item, sourceContents) => {
      if (agentHost?.isLentContents(sourceContents?.id)) { event.preventDefault(); return; }
      if (protectedWorkspace) {
        event.preventDefault();
        this.addPrivacyEvent('blocked', 'Download blocked in Banking', 'Banking does not allow saving downloads', accountSpaceId);
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
      const staged = this.setDownloadDestination(entry, item);
      this.downloads.set(id, entry);
      this.downloadItems.set(id, item);
      this.updateDownloadProgress(entry, item, 'progressing');
      item.on('updated', (_downloadEvent, state) => {
        const { state: previousState, paused, canPause, canResume, canCancel, receivedBytes, totalBytes } = entry;
        this.updateDownloadProgress(entry, item, state);
        if (entry.state !== previousState || entry.paused !== paused || entry.canPause !== canPause
          || entry.canResume !== canResume || entry.canCancel !== canCancel) this.broadcast();
        else if (entry.receivedBytes !== receivedBytes || entry.totalBytes !== totalBytes) this.scheduleDownloadProgress(entry.accountSpaceId);
      });
      item.once('done', async (_downloadEvent, state) => {
        this.downloadItems.delete(id);
        const receivedBytes = item.getReceivedBytes();
        const totalBytes = item.getTotalBytes();
        let savePath = item.getSavePath();
        if (staged && state !== 'completed') await discardDownloadStage(staged);
        if (staged && state === 'completed' && this.downloads.get(id) === entry) {
          Object.assign(entry, { state: 'progressing', receivedBytes, totalBytes, paused: false, canPause: false, canResume: false, canCancel: false });
          try {
            if (savePath !== staged || !downloadFileStamp(staged)) throw new Error('The staged download is unavailable.');
            savePath = await finishStagedDownload(staged, dirname(dirname(staged)), basename(staged));
          } catch {
            entry.destinationNote = 'saved-in-temporary-folder';
          }
        }
        if (this.downloads.get(id) !== entry) return;
        Object.assign(entry, { receivedBytes, totalBytes, state, savePath,
          finishedAt: new Date().toISOString(), paused: false, canPause: false, canResume: false, canCancel: false });
        if (entry.savePath) {
          const savedFilename = basename(entry.savePath);
          entry.filename = savedFilename;
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
    if (this.startingWindow || this.sessionIsLocked) return;
    const state = this.store.get();
    if (state.activeWorkspaceId === 'banking') this.temporaryBrowsing.close();
    const tab = this.activeTab(state);
    const locked = state.accountSpaces.find((account) => account.id === tab.accountSpaceId)?.locked;
    if (!locked && !tab.isHome && !tab.restorePaused && !this.runtimeTabs.get(tab.id)?.problem
      && this.runtimeTabs.get(tab.id)?.pdf?.mode !== 'protected' && this.startupTabRecovery?.accountSpaceId !== tab.accountSpaceId && isAllowedRemoteUrl(tab.url)) {
      const view = this.ensureView(tab.id);
      const runtime = this.runtimeTabs.get(tab.id);
      if (runtime) runtime.memorySaver.lastVisibleAt = Date.now();
      view.setVisible(!this.overlayOpen && !this.pendingPermission);
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
    } else this.applyLayout();
    this.broadcast();
  }

  private async sleepInactiveTabs(): Promise<void> {
    const minutes = this.store.memorySaverMinutes();
    if (!minutes || this.sweepingMemory || this.sessionIsLocked || !this.window || this.window.isDestroyed()) return;
    const cutoff = Date.now() - minutes * 60_000;
    if (![...this.runtimeTabs.values()].some((tab) => tab.view && !tab.view.getVisible()
      && !tab.memorySaver.interacted && tab.memorySaver.lastVisibleAt <= cutoff)) return;
    this.sweepingMemory = true;
    try {
      const initial = this.store.get();
      const activeId = this.activeTab(initial).id;
      let checked = 0;
      for (const tab of initial.tabs) {
        if (tab.id === activeId || checked >= 4) continue;
        const runtime = this.runtimeTabs.get(tab.id);
        const view = runtime?.view;
        if (!runtime || !view || !this.canSleepTab(tab, initial, runtime, view)) continue;
        checked += 1;
        await this.checkAndSleepTab(tab.id, runtime, view);
      }
    } finally {
      this.sweepingMemory = false;
    }
  }

  private canSleepTab(tab: BrowserTab, state: RuntimeBrowserStateV2, runtime: RuntimeTab, view: WebContentsView): boolean {
    const contents = view.webContents;
    if (this.sessionIsLocked || this.store.isReadOnly() || tab.id === this.activeTab(state).id || tab.workspaceId === 'banking'
      || tab.isHome || tab.pinned || tab.restorePaused || view.getVisible() || runtime.sleepPending || runtime.problem || runtime.certificateError
      || contents.isDestroyed() || contents.isLoading() || contents.isDevToolsOpened() || contents.isCurrentlyAudible()
      || contents.navigationHistory.canGoBack() || contents.navigationHistory.canGoForward()
      || agentHost?.isLentContents(contents.id)) return false;
    const origin = memorySaverOrigin(tab.url);
    if (!origin || this.store.keepsSiteAwake(tab.accountSpaceId, origin)
      || state.accountSpaces.find((account) => account.id === tab.accountSpaceId)?.locked
      || state.recovery?.accountSpaceId === tab.accountSpaceId || this.startupTabRecovery?.accountSpaceId === tab.accountSpaceId) return false;
    if ([...this.downloadItems.keys()].some((id) => this.downloads.get(id)?.accountSpaceId === tab.accountSpaceId)) return false;
    return mayReloadInactivePage(runtime.memorySaver, contents.getURL(), this.store.memorySaverMinutes(), Date.now()) && contents.getURL() === tab.url;
  }

  private async checkAndSleepTab(tabId: string, runtime: RuntimeTab, view: WebContentsView): Promise<void> {
    const contents = view.webContents;
    const generation = runtime.navigationGeneration;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let safe: unknown;
    try {
      safe = await Promise.race([
        contents.executeJavaScriptInIsolatedWorld(1024, [{ code: MEMORY_SAVER_PAGE_CHECK }]),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 1000); }),
      ]);
    } catch {
      return;
    } finally {
      clearTimeout(timeout);
    }
    if (runtime.view !== view || runtime.navigationGeneration !== generation) return;
    if (safe !== true) {
      runtime.memorySaver.interacted = true;
      return;
    }
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab || !this.canSleepTab(tab, state, runtime, view)) return;
    runtime.sleepPending = true;
    const prevent = () => {
      runtime.sleepPending = false;
      runtime.memorySaver.interacted = true;
      contents.removeListener('destroyed', onClosed);
    };
    const onClosed = () => {
      if (this.runtimeTabs.get(tabId) !== runtime || runtime.view !== view || this.window.isDestroyed()) return;
      this.window.contentView.removeChildView(view);
      runtime.view = undefined;
      runtime.sleepPending = false;
      if (this.sessionIsLocked) return;
      runtime.sleeping = true;
      if (this.activeTab(this.store.get()).id === tabId) {
        void this.showActiveTab().catch(() => this.broadcast());
      } else {
        this.broadcast();
      }
    };
    contents.once('will-prevent-unload', prevent);
    contents.once('destroyed', onClosed);
    try {
      contents.close({ waitForBeforeUnload: true });
    } catch {
      contents.removeListener('will-prevent-unload', prevent);
      prevent();
    }
  }

  private isBlockedTrackerRequest(url: string): boolean {
    return this.store.trackerBlockingEnabled() && Boolean(trackerCategory(url));
  }

  private hideAllViews(): void {
    this.popupReview.cancel();
    this.downloadEnrollment?.abort();
    this.bookmarkSyncRequest?.abort();
    this.bookmarkSync.clearReview();
    this.notesDraft = undefined;
    this.protectedPdf.close();
    this.clearWordPressCaptures();
    this.fillPicker.close();
    for (const runtime of this.runtimeTabs.values()) {
      if (runtime.view?.getVisible()) runtime.memorySaver.lastVisibleAt = Date.now();
      runtime.view?.webContents.closeDevTools();
      runtime.view?.setVisible(false);
    }
    this.visibleSplitTabId = undefined;
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

  private currentContentBounds() {
    const [width, height] = this.window.getContentSize();
    // Full screen hides every piece of chrome, so the page owns the whole window.
    const insets = this.window.isFullScreen() ? ZERO_INSETS : this.layout;
    return contentBounds(insets, width, height);
  }

  private endSplitForTab(tabId: string, accountSpaceId: AccountSpaceId): void {
    const pair = this.splitPairs.get(accountSpaceId);
    if (pair?.leftTabId !== tabId && pair?.rightTabId !== tabId) return;
    this.splitPairs.delete(accountSpaceId);
    this.applyLayout();
  }

  private applyLayout(): void {
    if (!this.window || this.window.isDestroyed()) return;
    this.layoutSideApps();
    const state = this.store.get();
    const active = this.activeTab(state);
    const runtime = this.runtimeTabs.get(active.id);
    const bounds = this.currentContentBounds();
    const pair = this.splitPair(state, active);
    const panes = pair && runtime?.view?.getVisible() && !this.overlayOpen && !this.sessionIsLocked && !this.window.isFullScreen()
      ? splitBounds(bounds) : undefined;
    const otherId = panes && pair ? (pair.leftTabId === active.id ? pair.rightTabId : pair.leftTabId) : undefined;
    if (this.visibleSplitTabId !== otherId) {
      if (this.visibleSplitTabId && this.visibleSplitTabId !== active.id) {
        const prior = this.runtimeTabs.get(this.visibleSplitTabId);
        if (prior?.view?.getVisible()) {
          prior.memorySaver.lastVisibleAt = Date.now();
          prior.view.setVisible(false);
        }
      }
      this.visibleSplitTabId = otherId;
      this.settleBroadcast = true;
    }
    if (!runtime?.view || active.isHome) return;
    if (runtime.pdf?.mode === 'protected') { runtime.view.setVisible(false); return; }
    runtime.view.setBounds(panes && pair ? (pair.leftTabId === active.id ? panes.left : panes.right) : bounds);
    if (!otherId || !panes || !pair) return;
    const other = state.tabs.find((item) => item.id === otherId)!;
    const view = this.ensureView(otherId);
    view.setBounds(pair.leftTabId === otherId ? panes.left : panes.right);
    view.setVisible(true);
    const contents = view.webContents;
    if (!contents.getURL() && !contents.isLoading()) {
      void contents.loadURL(other.url).catch(() => {
        // The existing failed-load event records a recoverable tab problem.
      });
    }
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
    const runtime = this.runtimeTabs.get(tabId);
    const tab = this.store.getTab(tabId);
    if (!tab || tab.isHome || !runtime || !isAllowedRemoteUrl(url)) return;
    const generation = runtime.navigationGeneration;
    const cacheKey = `${tab.accountSpaceId}:${url}`;
    let dataUrl = this.faviconCache.get(cacheKey);
    if (!dataUrl) {
      let request = this.faviconRequests.get(cacheKey);
      if (!request) {
        if (this.faviconRequests.size >= 32) return;
        request = this.readFavicon(ses, url);
        this.faviconRequests.set(cacheKey, request);
      }
      dataUrl = await request;
      if (this.faviconRequests.get(cacheKey) === request) {
        this.faviconRequests.delete(cacheKey);
        if (dataUrl) {
          if (this.faviconCache.size >= 200) this.faviconCache.delete(this.faviconCache.keys().next().value!);
          this.faviconCache.set(cacheKey, dataUrl);
        }
      }
    }
    if (!dataUrl || runtime.navigationGeneration !== generation || this.runtimeTabs.get(tabId) !== runtime
      || runtime.favicon === dataUrl || this.sessionIsLocked || runtime.view?.webContents.isDestroyed() || this.store.getTab(tabId)?.isHome) return;
    this.rememberBookmarkIcon(tabId, dataUrl);
    this.updateRuntime(tabId, { favicon: dataUrl });
  }

  private async readFavicon(ses: Session, url: string): Promise<string | undefined> {
    try {
      const response = await ses.fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'follow' });
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!response.ok || !FAVICON_TYPES.has(type)) { await response.body?.cancel(); return; }
      // The page chooses this URL: the size limit is applied while reading, not
      // after the whole body is in memory (F-71).
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_FAVICON_BYTES) { await response.body?.cancel(); return; }
      const bytes = await readAtMost(response, MAX_FAVICON_BYTES);
      // The icon rides along in every state broadcast, so keep it small.
      if (!bytes?.byteLength) return;
      return `data:${type};base64,${bytes.toString('base64')}`;
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
      this.store.update((next) => { next.bookmarkIconsByAccountSpace[tab.accountSpaceId] = icons; }, 'routine');
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
    if (this.visibleSplitTabId) this.applyLayout();
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
    }, 'routine');
    if (this.visibleSplitTabId && isProtectedPage(sanitizedUrl)) {
      const tab = this.store.get().tabs.find((item) => item.id === tabId);
      if (tab) this.endSplitForTab(tabId, tab.accountSpaceId);
    }
    this.updateRuntime(tabId, {});
  }

  private addPrivacyEvent(kind: PrivacyEvent['kind'], title: string, detail: string, sourceAccountSpaceId?: AccountSpaceId): void {
    this.store.update((state) => {
      const accountSpaceId = sourceAccountSpaceId ?? state.activeAccountSpaceByWorkspace[state.activeWorkspaceId];
      if (sourceAccountSpaceId && !state.accountSpaces.some((account) => account.id === sourceAccountSpaceId)) return;
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
  if (!launchWindowReady || processingLaunchUrls || !controller || controller.sessionIsLocked) return;
  processingLaunchUrls = true;
  try {
    while (!controller.sessionIsLocked && pendingLaunchUrls.length) {
      const url = pendingLaunchUrls.shift()!;
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
    if (controller?.sessionIsLocked && channel !== 'browser:get-state' && channel !== 'app:quit') {
      throw new Error('Private Browser is locked. Unlock Windows to resume.');
    }
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
  const actionReceipts = new GoogleActionReceipts({
    read: (account) => accountStore.require(account).googleActionReceipts ?? [],
    write: (account, receipts) => { accountStore.update(account, (record) => { record.googleActionReceipts = receipts; }); },
  });
  const googleServices = new GoogleServices(googleTokens, actionReceipts);
  const backups = new AccountBackupManager(accountStore, safeStorage, new GoogleDriveAppDataTransport(googleTokens));
  const bookmarkSync = new BookmarkSyncManager(join(userDataPath, 'bookmark-sync'),
    { isEncryptionAvailable: agentStorageAvailable, encryptString: (value) => safeStorage.encryptString(value), decryptString: (value) => safeStorage.decryptString(value) },
    new GoogleDriveBookmarkTransport(googleTokens));
  const persistedState = new AccountSpaceStateStore({
    paths: {
      legacyFilePath: join(userDataPath, 'browser-state.json'),
      manifestFilePath: join(userDataPath, 'browser-state-v2.json'),
      accountStateDirectory: join(userDataPath, 'account-browsing'),
      migrationJournalPath: join(userDataPath, 'browser-state-v2.migration.json'),
    },
    accountStore,
    browsingEncryption: { isEncryptionAvailable: agentStorageAvailable, encryptString: (value) => safeStorage.encryptString(value), decryptString: (value) => safeStorage.decryptString(value) },
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
  controller = new BrowserController(store, persistedState, accountStore, googleConfiguration, externalBrowsers, googleOAuth, googleServices, backups, bookmarkSync, vault, migration, aiProvider, updates, vscodeBridge, controlCenter, fillPreferences);
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
  handle('agents:set-session-cap', (_event, sessionCapMs: number) => agentHost!.setSessionCap(sessionCapMs));
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
  handle('browser:open-temporary-browsing', (_event, id: AccountSpaceId) => controller!.openTemporaryBrowsing(id));
  handle('browser:close-tab', (_event, id: string) => controller!.closeTab(id));
  handle('browser:activate-tab', (_event, id: string) => controller!.activateTab(id));
  handle('browser:set-split-view', (_event, id?: string) => controller!.setSplitView(id));
  handle('browser:switch-workspace', (_event, id: WorkspaceId) => controller!.switchWorkspace(id));
  handle('browser:switch-account-space', (_event, id: AccountSpaceId) => controller!.switchAccountSpace(id));
  handle('browser:address-matches', (_event, account: AccountSpaceId, text: string) => controller!.addressMatches(account, text));
  handle('browser:query-history', (_event, account: AccountSpaceId, input: HistoryQuery) => controller!.retainedHistory(account, input));
  handle('browser:review-browsing-data', (_event, input: BrowsingDataInput) => controller!.reviewBrowsingData(input));
  handle('browser:delete-reviewed-data', (_event, id: string) => controller!.deleteReviewedBrowsingData(id));
  handle('browser:delete-history-visit', (_event, account: AccountSpaceId, id: string) => controller!.deleteHistoryVisit(account, id));
  handle('browser:open-address-match', (_event, account: AccountSpaceId, source: AddressMatch['source'], id: string) => controller!.openAddressMatch(account, source, id));
  handle('accounts:add-local', (_event, workspaceId: WorkspaceId, label: string, color: AccountSpaceColor, googleSetupPending?: boolean) => controller!.addLocalAccountSpace(workspaceId, label, color, googleSetupPending));
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
  handle('google:gmail-reply-draft', (_event, id: AccountSpaceId, operationId: string, messageId: string) => controller!.readGmailReplyDraft(id, operationId, messageId));
  handle('google:overview-page', (_event, id: AccountSpaceId, operationId: string, service: GoogleOverviewService, cursor?: string) => controller!.googleOverviewPage(id, operationId, service, cursor));
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
  handle('backup:preview-upload', (_event, id: AccountSpaceId, operationId: string) => controller!.previewBackupUpload(id, operationId));
  handle('backup:apply-upload', (_event, id: string, operationId: string, resolution: 'merge' | 'overwrite') => controller!.applyBackupUpload(id, operationId, resolution));
  handle('backup:cancel-upload', (_event, id: string) => controller!.cancelBackupUpload(id));
  handle('backup:set-reminder', (_event, id: AccountSpaceId, days: BackupReminderDays) => controller!.setBackupReminder(id, days));
  handle('backup:preview-restore', (_event, id: AccountSpaceId, operationId: string, recoveryCode?: string, generation?: string) => controller!.previewBackupRestore(id, operationId, recoveryCode, generation));
  handle('backup:apply-restore', (_event, id: string) => controller!.applyBackupRestore(id));
  handle('backup:cancel-restore', (_event, id: string) => controller!.cancelBackupRestore(id));
  handle('backup:disable', (_event, id: AccountSpaceId) => controller!.disableBackup(id));
  handle('operations:cancel', (_event, operationId: string) => controller!.cancelOperation(operationId));
  handle('recovery:act', (_event, action: StateRecoveryAction, confirmation?: string) => controller!.recoveryAction(action, confirmation));
  handle('browser:set-layout', (_event, layout: Layout) => controller!.setLayout(layout));
  handle('browser:set-overlay-open', (_event, open: boolean) => controller!.setOverlayOpen(open));
  handle('side-app:set-bounds', (_event, id: SideAppId, rect: SideAppRect | null) => controller!.setSideAppBounds(id, rect));
  handle('side-app:command', (_event, id: SideAppId, command: SideAppCommand) => controller!.sideAppCommand(id, command));
  handle('notes:command', (_event, kind: NotesPanelCommand) => controller!.runNotesPanelCommand(kind));
  handle('notes:cancel-draft', (_event, id: string) => controller!.cancelNotesDraft(id));
  handle('notes:deliver-draft', (_event, choice: NotesDraftChoice, copyOnly: boolean) => controller!.deliverNotesDraft(choice, copyOnly));
  handle('side-app:clear-data', (_event, id: SideAppId) => controller!.clearSideAppData(id));
  handle('browser:toggle-bookmark', () => controller!.toggleBookmark());
  handle('browser:open-bookmark', (_event, id: string) => controller!.openBookmark(id));
  handle('browser:open-bookmarks-in-background', (_event, account: AccountSpaceId, ids: string[]) => controller!.openBookmarksInBackground(account, ids));
  handle('browser:toggle-bookmark-bar', () => controller!.toggleBookmarkBar());
  handle('ui:set-preferences', (_event, patch: UiPreferencesPatch, id?: AccountSpaceId) => controller!.setUiPreferences(patch, id));
  handle('bookmarks:sync', (_event, id: AccountSpaceId, action: BookmarkSyncAction, review?: string, choice?: 'local' | 'remote') => controller!.changeBookmarkSync(id, action, review, choice));
  handle('privacy:browsing', (_event, id: AccountSpaceId, action: BrowsingPrivacyAction, value?: number | boolean) => controller!.changeBrowsingPrivacy(id, action, value));
  handle('ui:set-panel-pin', (_event, id: AccountSpaceId, tool: PinnablePanelTool, enabled: boolean) => controller!.setSidePanelPin(id, tool, enabled));
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
  handle('pdf:open', () => controller!.openPdfInTab());
  handle('pdf:save', () => controller!.savePdf());
  handle('browser:find', (_event, text: string, forward: boolean, findNext: boolean) => controller!.findInPage(text, forward, findNext));
  handle('browser:stop-find', () => controller!.stopFindInPage());
  handle('browser:set-tab-muted', (_event, tabId: string, muted: boolean) => controller!.setTabMuted(tabId, muted));
  handle('browser:hard-reload', () => controller!.hardReload());
  handle('browser:toggle-fullscreen', () => controller!.toggleFullscreen());
  handle('bookmarks:move', (_event, level: BookmarkLevelInput, key: BookmarkEntryKeyInput, toIndex: number) => controller!.moveBookmark(level, key, toIndex));
  handle('bookmarks:add-folder', (_event, id: AccountSpaceId, parent: BookmarkLevelInput, name: string) => controller!.addBookmarkFolder(id, parent, name));
  handle('bookmarks:move-folder', (_event, id: AccountSpaceId, source: BookmarkLevelInput, parent: BookmarkLevelInput) => controller!.moveBookmarkFolder(id, source, parent));
  handle('bookmarks:save-to-folder', (_event, id: AccountSpaceId, tabId: string, url: string, folder: BookmarkLevelInput) => controller!.saveBookmarkToFolder(id, tabId, url, folder));
  handle('bookmarks:rename', (_event, id: string, title: string) => controller!.renameBookmark(id, title));
  handle('bookmarks:remove', (_event, id: string) => controller!.removeBookmark(id));
  handle('bookmarks:edit-address', (_event, id: string, url: string) => controller!.updateBookmarkAddress(id, url));
  handle('bookmarks:change-many', (_event, id: AccountSpaceId, ids: string[], destination?: BookmarkLevelInput) => controller!.changeBookmarks(id, ids, destination));
  handle('bookmarks:undo-many', (_event, id: AccountSpaceId) => controller!.undoBookmarks(id));
  handle('bookmarks:rename-folder', (_event, level: BookmarkLevelInput, name: string, nextName: string, id?: AccountSpaceId) => controller!.renameBookmarkFolder(level, name, nextName, id));
  handle('bookmarks:remove-folder', (_event, level: BookmarkLevelInput, name: string, id?: AccountSpaceId) => controller!.removeBookmarkFolder(level, name, id));
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
  handle('browser:set-tracker-compatibility', (_event, tabId: string, origin: string, paused: boolean) => controller!.setTrackerCompatibility(tabId, origin, paused));
  handle('browser:set-memory-saver-site', (_event, tabId: string, origin: string, keepAwake: boolean) => controller!.setMemorySaverSite(tabId, origin, keepAwake));
  handle('browser:open-download', (_event, id: string) => controller!.openDownload(id));
  handle('browser:control-download', (_event, id: string, action: DownloadAction) => controller!.controlDownload(id, action));
  handle('browser:show-download', (_event, id: string) => controller!.showDownload(id));
  handle('browser:set-download-history', (_event, accountId: AccountSpaceId, enabled: boolean) => controller!.setDownloadHistory(accountId, enabled));
  handle('browser:choose-download-folder', (_event, accountId: AccountSpaceId) => controller!.chooseDownloadFolder(accountId));
  handle('browser:set-download-folder-mode', (_event, accountId: AccountSpaceId, mode: DownloadFolderMode) => controller!.setDownloadFolderMode(accountId, mode));
  handle('browser:remove-download-entry', (_event, accountId: AccountSpaceId, id: string) => controller!.removeDownloadEntry(accountId, id));
  handle('developer:toggle-tools', (_event, mode: DevToolsMode) => controller!.toggleDeveloperTools(mode));
  handle('developer:capture-diagnostics', () => controller!.captureDeveloperDiagnostics());
  handle('developer:clear-diagnostics', () => controller!.clearDeveloperDiagnostics());
  handle('developer:bridge-status', () => controller!.getBridgeStatus());
  handle('developer:bridge-pair', () => controller!.beginBridgePairing());
  handle('developer:bridge-cancel-pairing', () => controller!.cancelBridgePairing());
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
  handle('side-app:prepare-claude-excerpt', () => controller!.prepareClaudeExcerpt());
  handle('side-app:cancel-claude-excerpt', (_event, id: string) => controller!.cancelClaudeExcerpt(id));
  handle('side-app:copy-claude-excerpt', (_event, id: string) => controller!.copyClaudeExcerpt(id));
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
  handle('vault:resolve-conflict', (_event, choice: 'cloud' | 'local', reviewId: string) => controller!.resolveVaultConflict(choice, reviewId));
  handle('vault:resolve-entry-conflict', (_event, reviewId: string, entries: VaultEntryDecision[]) => controller!.resolveVaultConflict({ entries }, reviewId));
  handle('vault:show-conflict-recovery', () => controller!.showVaultConflictRecovery());
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
  handle('vault:wordpress-save-setting', (_event, tabId: string, origin: string, enabled: boolean) => controller!.setWordPressSaveSite(tabId, origin, enabled));
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
  handle('updates:enroll-device', () => controller!.requestDownloadEnrollment());
  handle('updates:clear', () => controller!.clearUpdateService());
  handle('updates:check', () => controller!.checkForUpdates());
  handle('updates:open-page', () => controller!.openUpdatePage());
  handle('updates:download-installer', (_event, version: string, sha256: string) => controller!.downloadManagedUpdate(version, sha256));
  handle('updates:cancel-installer', () => controller!.cancelManagedUpdate());
  handle('updates:install-verified', () => controller!.installManagedUpdate());
  handle('updates:open-history', () => controller!.openReleaseHistory());

  controller.startSessionLockMonitoring();
  // The first window can accept input while its page and local bridge finish
  // starting. Startup settings edited in that window apply on the next launch.
  const atLaunch = store.get();
  await controller.createWindow();
  if (controller.sessionIsLocked) agentHost.stop();
  else await agentHost.start();
  setTimeout(() => void controller?.checkForUpdatesInBackground(), 10_000).unref();
  setInterval(() => void controller?.checkForUpdatesInBackground(), 24 * 60 * 60_000).unref();
  if (!controller.sessionIsLocked && !pendingLaunchUrls.length) await controller.openStartupHome(atLaunch);
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
