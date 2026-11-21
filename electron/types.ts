import type { BrowserSettings, SpellcheckLanguage } from './browser-settings.js';
import type { AccountPanelPreferences, PinnablePanelTool, UiPreferences } from './ui-preferences.js';

export type { SideAppCommand, SideAppId, SideAppRect, SideAppSnapshot, SideAppStatus } from './side-app-registry.js';
import type { SideAppSnapshot } from './side-app-registry.js';
export type { UiPreferences, UiPreferencesPatch, ThemePreference, SidePanelTool, PinnablePanelTool, NewTabBackground } from './ui-preferences.js';
export type { BrowserSettings, BrowserSettingsPatch, HomePageMode, SearchEngineId, StartupMode } from './browser-settings.js';
export type { BookmarkBarMode } from './chrome-layout.js';
export type { Shortcut, ShortcutCommand } from './shortcuts.js';

export type WorkspaceId = 'digitronics' | 'tenten' | 'development' | 'personal' | 'banking';

export interface Workspace {
  id: WorkspaceId;
  name: string;
  color: string;
  icon: string;
  protected: boolean;
}

/** Opaque application identifier. It must never be derived from Google identity data. */
export type AccountSpaceId = string & { readonly __accountSpaceId: unique symbol };

export type AccountSpaceKind = 'local' | 'google';
export type AccountSpaceColor = 'indigo' | 'sky' | 'emerald' | 'amber' | 'rose' | 'violet' | 'slate';

export type GoogleModule =
  | 'identity'
  | 'gmail-metadata'
  | 'gmail-read'
  | 'gmail-send'
  | 'drive-files'
  | 'drive-metadata'
  | 'drive-read'
  | 'calendar-read'
  | 'calendar-write'
  | 'contacts-read'
  | 'encrypted-backup';

export type GoogleConnectionStatus =
  | 'not-configured'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'partial-scopes'
  | 'offline'
  | 'quota-limited'
  | 'revocation-pending'
  | 'reconnect-required'
  | 'locked'
  | 'account-corrupt';

export type GoogleWebsiteStatus =
  | 'not-visited'
  | 'session-data-present'
  | 'sign-in-blocked'
  | 'unknown';

export type ExternalBrowserId = 'edge' | 'chrome' | 'firefox';

export interface ExternalBrowserSummary {
  id: ExternalBrowserId;
  name: string;
}

export interface GoogleConfigurationStatus {
  configured: boolean;
  source?: 'environment' | 'encrypted-settings';
  error?: 'os-encryption-unavailable' | 'configuration-corrupt';
}

export interface AccountSpaceSummary {
  id: AccountSpaceId;
  workspaceId: WorkspaceId;
  label: string;
  color: AccountSpaceColor;
  order: number;
  kind: AccountSpaceKind;
  googleSetupPending?: boolean;
  email?: string;
  displayName?: string;
  avatarDataUrl?: string;
  createdAt: string;
  lastUsedAt: string;
  locked: boolean;
  googleConnection: GoogleConnectionStatus;
  websiteStatus: GoogleWebsiteStatus;
  enabledModules: GoogleModule[];
  grantedScopes: string[];
  backupEnabled: boolean;
  backupIncludesOpenTabs: boolean;
  backupIncludesHistory: boolean;
}

export interface CreateAccountSpaceRequest {
  workspaceId: WorkspaceId;
  label: string;
  color: AccountSpaceColor;
}

export interface UpdateAccountSpaceRequest {
  accountSpaceId: AccountSpaceId;
  label?: string;
  color?: AccountSpaceColor;
}

export interface ReorderAccountSpacesRequest {
  workspaceId: WorkspaceId;
  accountSpaceIds: AccountSpaceId[];
}

export interface OpenInAccountSpaceRequest {
  accountSpaceId: AccountSpaceId;
  url: string;
}

export interface DeleteAccountSpaceRequest {
  accountSpaceId: AccountSpaceId;
  confirmation: 'DELETE_ACCOUNT_SPACE';
}

export interface AccountSpaceHealth {
  accountSpaceId: AccountSpaceId;
  status: GoogleConnectionStatus;
  checkedAt: string;
  retryAfter?: string;
  detailCode?:
    | 'configuration-required'
    | 'testing-token-expired'
    | 'permission-revoked'
    | 'quota-exhausted'
    | 'network-unavailable'
    | 'record-unreadable';
}

export type GoogleHealthState = 'unavailable' | 'disconnected' | 'ready' | 'reconnect' | 'permission' | 'offline' | 'quota';
export interface GoogleConnectionHealth {
  state: GoogleHealthState;
  lastSuccessAt?: string;
  retryAt?: string;
}

export type PermissionCapability =
  | 'notifications'
  | 'microphone'
  | 'camera'
  | 'camera-and-microphone'
  | 'display-capture'
  | 'geolocation'
  | 'clipboard-read'
  | 'clipboard-write'
  | 'file-system'
  | 'download';

export type PermissionDecision = 'allow-once' | 'allow-session' | 'allow-always' | 'deny';

export type PermissionGrantDuration = 'once' | 'session' | 'until-revoked';
export interface PermissionGrantSummary {
  origin: string;
  capability: PermissionCapability;
  duration: PermissionGrantDuration;
}
export type SitePermissionStatus =
  | { capability: PermissionCapability; decision: 'allowed'; duration: PermissionGrantDuration }
  | { capability: PermissionCapability; decision: 'ask' | 'blocked' };

export interface PermissionPrompt {
  id: string;
  accountSpaceId: AccountSpaceId;
  workspaceId: WorkspaceId;
  origin: string;
  capability: PermissionCapability;
  createdAt: string;
  expiresAt: string;
  displaySources?: Array<{ id: string; name: string }>;
}

export interface PermissionPromptResponse {
  promptId: string;
  decision: PermissionDecision;
  displaySourceId?: string;
}

export interface GoogleOperationResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code:
      | 'GOOGLE_CONFIGURATION_REQUIRED'
      | 'GOOGLE_CANCELLED'
      | 'GOOGLE_OFFLINE'
      | 'GOOGLE_QUOTA'
      | 'GOOGLE_REVOKED'
      | 'GOOGLE_RECONNECT_REQUIRED'
      | 'GOOGLE_SCOPE_MISSING'
      | 'GOOGLE_POLICY_DENIED'
      | 'GOOGLE_CONFIRMATION_REQUIRED'
      | 'GOOGLE_INVALID_RESPONSE'
      | 'GOOGLE_INTERNAL';
    message: string;
    requestId: string;
    retryAfterSeconds?: number;
  };
}

interface BackupRestoreCount { added: number; duplicates: number; capacityExceeded: number }

export interface BackupRestorePreview {
  id: string;
  accountSpaceId: AccountSpaceId;
  accountLabel: string;
  workspaceId: WorkspaceId;
  createdAt: string;
  counts: { bookmarks: BackupRestoreCount; history: BackupRestoreCount; tabs: BackupRestoreCount };
}

export type GoogleService = 'gmail' | 'drive' | 'calendar' | 'contacts' | 'backup';

export interface GoogleOperationProgress {
  operationId: string;
  accountSpaceId: AccountSpaceId;
  service: GoogleService;
  phase: 'started' | 'completed' | 'cancelled' | 'failed';
}

export interface GoogleMutationConfirmation {
  token: string;
  accountSpaceId: AccountSpaceId;
  service: GoogleService;
  action: string;
  target: string;
  sourceRevision?: string;
  expiresAt: string;
}

export interface GmailMessageHeader {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  date: string;
}

export interface GmailOverview {
  unreadCount: number;
  recent: GmailMessageHeader[];
}

export interface DriveFileSummary {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
}

export interface CalendarEventSummary {
  id: string;
  summary: string;
  start: string;
  end?: string;
  htmlLink?: string;
  meetLink?: string;
}

export interface ContactSummary {
  resourceName: string;
  displayName: string;
  email: string;
}

export type StateRecoveryScope = 'browser-state' | 'account-space';
export type StateRecoveryReason =
  | 'unsupported-version'
  | 'invalid-state'
  | 'migration-interrupted'
  | 'account-corrupt';

export interface StateRecoveryStatus {
  readOnly: boolean;
  scope: StateRecoveryScope;
  reason: StateRecoveryReason;
  accountSpaceId?: AccountSpaceId;
  backupAvailable: boolean;
  actions: Array<'retry' | 'open-backup-location' | 'restore-v1' | 'fresh-start'>;
}

export type StateRecoveryAction = 'retry' | 'open-backup-location' | 'restore-v1' | 'fresh-start';

export interface AccountSpaceBrowserTab extends BrowserTab {
  accountSpaceId: AccountSpaceId;
}

export interface AccountSpaceBookmark extends Bookmark {
  accountSpaceId: AccountSpaceId;
}

export interface AccountSpaceHistoryEntry extends HistoryEntry {
  accountSpaceId: AccountSpaceId;
}

export interface AccountBrowsingStateV2 {
  version: 2;
  accountSpaceId: AccountSpaceId;
  workspaceId: WorkspaceId;
  tabs: Array<Pick<AccountSpaceBrowserTab, 'id' | 'workspaceId' | 'accountSpaceId' | 'title' | 'url' | 'isHome' | 'restorePaused' | 'pinned' | 'groupId'>>;
  activeTabId: string;
  bookmarks: AccountSpaceBookmark[];
  history: AccountSpaceHistoryEntry[];
  historyTrimmed?: boolean;
  tabGroups?: TabGroup[];
  /** Absent until the user customises the New Tab shortcuts for this Account Space. */
  shortcuts?: ShortcutTile[];
  /** Remembered icons of bookmarked hosts, host → `data:` URL. See `bookmark-icons.ts`. */
  bookmarkIcons?: Record<string, string>;
  sidePanel?: AccountPanelPreferences;
}

export interface ShortcutTile {
  id: string;
  title: string;
  url: string;
}

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
  darkMode: boolean;
}

export interface FindResult {
  tabId: string;
  matches: number;
  activeMatchOrdinal: number;
  finalUpdate: boolean;
}

export interface BookmarkLevelInput {
  location: 'bar' | 'other';
  path: string[];
}

export type BookmarkEntryKeyInput = { kind: 'bookmark'; id: string } | { kind: 'folder'; name: string };

export interface BrowserStateManifestV2 {
  version: 2;
  activeWorkspaceId: WorkspaceId;
  lastExternalLinkAccountSpaceId?: AccountSpaceId;
  accountSpaceIds: AccountSpaceId[];
  activeAccountSpaceByWorkspace: Partial<Record<WorkspaceId, AccountSpaceId>>;
  trackerBlocking: boolean;
  bookmarkBarVisible: boolean;
  privacyLog: PrivacyEvent[];
  ui?: UiPreferences;
  /** Optional: builds before 0.7.0 ignore it and fall back to defaults. */
  settings?: BrowserSettings;
  workspaceSettings?: Partial<Record<WorkspaceId, BrowserSettings>>;
  routines?: BrowserRoutine[];
}

export interface RoutineLink { accountSpaceId: AccountSpaceId; url: string }
export interface BrowserRoutine {
  id: string;
  name: string;
  links: RoutineLink[];
  focusIndex: number;
  checklist: Array<{ label: string; done?: boolean; completedAt?: string }>;
}
export interface RoutineRunResult {
  reused: number;
  opened: number;
  skipped: number[];
  focusUnavailable: boolean;
}

export interface TabSetInput {
  accountSpaceId: AccountSpaceId;
  kind: 'routine' | 'bookmarks';
  name: string;
  tabs: Array<{ id: string; url: string }>;
}

export interface ReferenceSearchInput {
  accountSpaceId: AccountSpaceId;
  keyword: string;
  reference: string;
  reviewedUrl: string;
}

export type TabProblem = 'crashed' | 'certificate' | 'offline' | 'network';

export interface TabGroup {
  id: string;
  name: string;
  collapsed: boolean;
}

export type TabOrganizationAction =
  | { kind: 'pin'; tabId: string; pinned: boolean }
  | { kind: 'create-group'; tabId: string; name: string }
  | { kind: 'move-to-group'; tabId: string; groupId: string | null }
  | { kind: 'collapse-group'; groupId: string; collapsed: boolean };
export type TabBatchScope = 'other' | 'right' | 'group';

export interface ClosedTabBatchSummary {
  count: number;
  groupName?: string;
}

export interface StartupTabRecovery {
  accountSpaceId: AccountSpaceId;
  failedTabId: string;
}

export interface BrowserTab {
  id: string;
  workspaceId: WorkspaceId;
  accountSpaceId: AccountSpaceId;
  title: string;
  url: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isHome: boolean;
  restorePaused?: boolean;
  pinned?: boolean;
  groupId?: string;
  problem?: TabProblem;
  developerToolsAllowed: boolean;
  developerToolsOpen: boolean;
  securityWarning?: 'insecure' | 'idn';
  audible?: boolean;
  muted?: boolean;
  zoomPercent?: number;
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  workspaceId: WorkspaceId;
  accountSpaceId: AccountSpaceId;
  createdAt: string;
  location: 'bar' | 'other';
  folderPath: string[];
  order: number;
  orderPath: number[];
}

export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  workspaceId: WorkspaceId;
  accountSpaceId: AccountSpaceId;
  visitedAt: string;
}

export interface HistoryQuery {
  text: string;
  site: string;
  from: number | null;
  until: number | null;
  page: number;
}

export interface HistoryPage {
  entries: Array<Pick<HistoryEntry, 'id' | 'title' | 'url' | 'visitedAt'> & { visits: number }>;
  page: number;
  pages: number;
  total: number;
  trimmed: boolean;
}

export type BrowsingDataRange = 'hour' | 'day' | 'week' | 'all';
export interface BrowsingDataInput {
  accountSpaceId: AccountSpaceId;
  range: BrowsingDataRange;
  site: string;
  history: boolean;
  websiteData: boolean;
  cache: boolean;
}
export interface BrowsingDataReview {
  id: string;
  accountSpaceId: AccountSpaceId;
  siteOrigin?: string;
  range: BrowsingDataRange;
  historyCount: number;
  websiteData: boolean;
  cache: boolean;
}

export interface AddressMatch {
  source: 'tab' | 'bookmark' | 'history';
  id: string;
  title: string;
  url: string;
}

export interface RecentlyClosedTab {
  id: string;
  title: string;
  url: string;
  closedAt: string;
}

export interface DownloadEntry {
  id: string;
  accountSpaceId: AccountSpaceId;
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  paused?: boolean;
  canPause?: boolean;
  canResume?: boolean;
  canCancel?: boolean;
  /** Set once a completed download has been compared against the release manifest. */
  checksum?: 'checking' | 'verified' | 'mismatch' | 'unchecked';
  extension?: string;
  publisher?: { state: 'unsigned' | 'valid' | 'untrusted' | 'unavailable'; name?: string };
  risk: 'ordinary' | 'dangerous' | 'deceptive';
  origin?: string;
  finishedAt?: string;
  retained?: boolean;
  destinationNote?: 'folder-unavailable' | 'saved-in-temporary-folder';
}

export type DownloadHistoryStatus = 'off' | 'on' | 'unavailable';
export type DownloadFolderMode = 'ask' | 'automatic' | 'default';
export interface DownloadFolderStatus { ask: boolean; available: boolean; name?: string }
export interface DownloadBatchStatus { active: number; completed: number; stopped: number }

export type DownloadAction = 'pause' | 'resume' | 'retry' | 'cancel';

export interface PrivacyEvent {
  id: string;
  at: string;
  kind: 'local-read' | 'cloud-approved' | 'blocked' | 'vault';
  title: string;
  detail: string;
  accountSpaceId?: AccountSpaceId;
  service?: 'browser' | 'gmail' | 'drive' | 'calendar' | 'contacts' | 'ai' | 'vault';
}

export interface BrowserSnapshot {
  sessionLock?: 'windows' | 'idle';
  workspaces: Workspace[];
  activeWorkspaceId: WorkspaceId;
  activeTabId: string;
  tabs: BrowserTab[];
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  downloads: DownloadEntry[];
  downloadHistory?: DownloadHistoryStatus;
  downloadFolder?: DownloadFolderStatus;
  downloadBatch?: DownloadBatchStatus;
  sidePanelPins?: PinnablePanelTool[];
  managedUpdate?: ManagedUpdateStatus;
  privacyLog: PrivacyEvent[];
  trackerBlocking: boolean;
  trackerSite?: TrackerSiteStatus;
  /** Present after Account Spaces initialization; contains renderer-safe data only. */
  activeAccountSpaceId: AccountSpaceId;
  accountSpaces: AccountSpaceSummary[];
  accountHealth: AccountSpaceHealth[];
  googleConfiguration: GoogleConfigurationStatus;
  externalBrowsers: ExternalBrowserSummary[];
  recovery?: StateRecoveryStatus;
  pendingPermission?: PermissionPrompt;
  setupVaultStatus?: VaultStatus['lifecycle'];
  bookmarkBarVisible: boolean;
  ui: UiPreferences;
  settings: BrowserSettings;
  availableSpellcheckLanguages: SpellcheckLanguage[];
  assistantPolicy: AssistantSpacePolicy;
  windowState: WindowState;
  /** Customised New Tab shortcuts keyed by Account Space; a missing key means the defaults. */
  shortcutsByAccountSpace: Record<string, ShortcutTile[]>;
  /** Remembered bookmark icons of the active Account Space only, host → `data:` URL. */
  bookmarkIcons: Record<string, string>;
  canReopenClosedTab: boolean;
  bookmarkUndo?: { kind: 'deleted' | 'moved'; count: number };
  recentlyClosedTabs?: RecentlyClosedTab[];
  routines?: BrowserRoutine[];
  startupTabRecovery?: StartupTabRecovery;
  tabGroups?: TabGroup[];
  closedTabBatch?: ClosedTabBatchSummary;
  /** Web apps docked in the side panel, such as Claude. */
  sideApps: SideAppSnapshot[];
}

export type TrackerCategory = 'advertising' | 'analytics' | 'social' | 'telemetry';
export interface TrackerSiteStatus {
  origin: string;
  counts: Partial<Record<TrackerCategory, number>>;
  blocking: boolean;
  canPause: boolean;
  pausedUntil?: number;
}

export interface PersistedState {
  version: 1;
  activeWorkspaceId: WorkspaceId;
  tabs: Array<Pick<BrowserTab, 'id' | 'workspaceId' | 'title' | 'url' | 'isHome'>>;
  activeTabByWorkspace: Partial<Record<WorkspaceId, string>>;
  bookmarks: Array<Omit<Bookmark, 'accountSpaceId'>>;
  history: Array<Omit<HistoryEntry, 'accountSpaceId'>>;
  privacyLog: PrivacyEvent[];
  trackerBlocking: boolean;
  bookmarkBarVisible: boolean;
}

export interface ChromeProfileSource {
  id: string;
  name: string;
  isDefault: boolean;
  hasBookmarks: boolean;
  hasHistory: boolean;
}

export interface ChromeImportOptions {
  profileId: string;
  workspaceId: WorkspaceId;
  accountSpaceId: AccountSpaceId;
  bookmarks: boolean;
  history: boolean;
}

export interface ChromeImportResult {
  imported: { bookmarks: number; history: number; passwords: number };
  skipped: { bookmarks: number; history: number; passwords: number };
  warnings: string[];
}

export interface ChromeImportReview {
  id: string;
  accountSpaceId: AccountSpaceId;
  result: ChromeImportResult;
  duplicates: number;
  unsupported: number;
  overLimit: number;
  folders: Array<{ location: Bookmark['location']; path: string[]; count: number }>;
  moreFolders: number;
  historyRange?: { from: string; through: string };
}

export interface RuntimeBrowserStateV2 {
  version: 2;
  activeWorkspaceId: WorkspaceId;
  lastExternalLinkAccountSpaceId?: AccountSpaceId;
  activeAccountSpaceByWorkspace: Partial<Record<WorkspaceId, AccountSpaceId>>;
  tabs: AccountSpaceBrowserTab[];
  activeTabByAccountSpace: Record<string, string>;
  bookmarks: AccountSpaceBookmark[];
  history: AccountSpaceHistoryEntry[];
  historyTrimmedByAccountSpace?: Record<string, true>;
  tabGroupsByAccountSpace?: Record<string, TabGroup[]>;
  privacyLog: PrivacyEvent[];
  trackerBlocking: boolean;
  bookmarkBarVisible: boolean;
  ui: UiPreferences;
  settings: BrowserSettings;
  workspaceSettings?: Partial<Record<WorkspaceId, BrowserSettings>>;
  routines?: BrowserRoutine[];
  shortcutsByAccountSpace: Record<string, ShortcutTile[]>;
  bookmarkIconsByAccountSpace: Record<string, Record<string, string>>;
  sidePanelsByAccountSpace?: Record<string, AccountPanelPreferences>;
  accountSpaces: AccountSpaceSummary[];
  accountHealth: AccountSpaceHealth[];
  recovery?: StateRecoveryStatus;
}

export interface AiPagePreview {
  id: string;
  accountSpaceId: AccountSpaceId;
  tabId: string;
  service: 'browser' | 'gmail' | 'drive' | 'calendar' | 'contacts';
  sourceRevision: string;
  sourceUrl: string;
  title: string;
  url: string;
  text: string;
  redactions: number;
  protectedPage: boolean;
  dom?: string;
  screenshotDataUrl?: string;
}

export interface DeveloperAiPreviewOptions {
  includeDom: boolean;
  includeScreenshot: boolean;
}

export interface AiApproval {
  token: string;
  preview: AiPagePreview;
}

export type AiPreviewScope = 'page' | 'selection';

export interface AssistantSelectionEdit { id: string; text: string }
export interface AssistantSelectionSource extends AssistantSelectionEdit {
  tabId: string;
  title: string;
  url: string;
  redactions: number;
}

export type PageExcerptReview = Pick<AiPagePreview, 'id' | 'url' | 'text' | 'redactions'>;

export interface AssistantReceipt {
  at: string;
  mode: 'local' | 'cloud';
  destination: string;
  purpose: 'page-request' | 'connection-test' | 'developer-request';
}

export interface AssistantSpacePolicy {
  cloud: 'allowed' | 'disabled' | 'unavailable';
  receipts: AssistantReceipt[];
}

export interface AiRequestReview {
  id: string;
  mode: 'cloud' | 'local';
  destination: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  redactions: number;
}

export type AssistantAnswer =
  | { kind: 'answer'; text: string }
  | { kind: 'sources'; items: { claim: string; quote: string }[] }
  | { kind: 'insufficient' | 'cancelled' | 'timeout' };

export interface AiProviderStatus {
  configured: boolean;
  mode?: 'cloud' | 'local';
  endpoint?: string;
  model?: string;
  error?: 'provider-corrupt' | 'os-encryption-unavailable';
}

export type AiProviderCheckState = 'ready' | 'not-configured' | 'authentication' | 'model' | 'rate-limit' | 'invalid-response' | 'unavailable' | 'local-setup';
export interface AiProviderCheckResult {
  state: AiProviderCheckState;
}

export interface CloudAiProviderInput {
  endpoint: string;
  model: string;
  apiKey: string;
}

export type AiProviderInput = CloudAiProviderInput | { mode: 'local'; model: string };

export interface LocalAiModels {
  state: 'ready' | 'unavailable' | 'cloud-enabled';
  models: string[];
}

export type DevToolsMode = 'right' | 'bottom' | 'detach';

export interface DeveloperConsoleEntry {
  at: string;
  level: 'warning' | 'error';
  message: string;
  source: string;
  line: number;
}

export interface DeveloperNetworkIssue {
  at: string;
  method: string;
  resourceType: string;
  url: string;
  status?: number;
  error?: string;
}

export interface DeveloperDiagnosticReport {
  schemaVersion: 1;
  capturedAt: string;
  appVersion: string;
  page: {
    title: string;
    url: string;
    readyState: string;
    language: string;
    scripts: number;
    stylesheets: number;
    images: number;
    links: number;
    forms: number;
    iframes: number;
  };
  console: DeveloperConsoleEntry[];
  network: DeveloperNetworkIssue[];
  redactions: number;
  formatted: string;
}

export type DeveloperBridgeAction =
  | 'project.open' | 'project.revision' | 'source.open'
  | 'server.discover' | 'server.status' | 'server.start' | 'server.stop' | 'server.restart'
  | 'inspect.page' | 'inspect.open-source'
  | 'test.run' | 'test.cancel' | 'test.rerun' | 'test.save-artifact'
  | 'ai.handoff' | 'ai.apply-edits'
  | 'reports.list' | 'reports.search' | 'reports.get' | 'reports.delete' | 'reports.clear' | 'reports.open' | 'reports.retention';

export interface DeveloperPageInfo {
  route: string;
  framework: string;
  viewport: string;
  selector?: string;
  element?: string;
  sourcePath?: string;
  confidence?: 'exact' | 'source-map' | 'nearest';
}

export interface VaultItemInput {
  label: string;
  url: string;
  username: string;
  password: string;
  totpSecret?: string;
}

export interface VaultItemMeta {
  id: string;
  label: string;
  url: string;
  username: string;
  hasTotp: boolean;
  updatedAt: string;
}

export interface VaultStatus {
  available: boolean;
  reason?: 'os-encryption-unavailable' | 'vault-corrupt' | 'vault-unsupported';
  items: VaultItemMeta[];
  lifecycle?: 'unconfigured' | 'locked' | 'unlocked' | 'conflict' | 'recovery-required';
  sync?: 'disabled' | 'idle' | 'dirty' | 'syncing' | 'synced' | 'conflict' | 'error';
  dirty?: boolean;
  /** 'enrolled' offers Windows Hello unlock; 'available' offers turning it on. */
  platformUnlock?: 'unavailable' | 'available' | 'enrolled';
  generation?: number;
}

export type VaultFillReadiness = 'ready' | 'locked' | 'connect' | 'no-match' | 'unsupported' | 'manual' | 'choose-login' | 'unavailable';
export type ChromePasswordSkipReason = 'unsupported-site' | 'missing-password' | 'field-limit' | 'row-limit' | 'already-saved' | 'duplicate-in-file';
export interface ChromePasswordIssue { entry: number; reason: ChromePasswordSkipReason; origin?: string; username?: string }
export interface ChromePasswordImportReview {
  id: string;
  sourceCount: number;
  toImport: number;
  skipped: Partial<Record<ChromePasswordSkipReason, number>>;
  issues: ChromePasswordIssue[];
}
export interface ChromePasswordImportResult {
  imported: number;
  skipped: Partial<Record<ChromePasswordSkipReason, number>>;
}
export type VaultHealthIssue = 'duplicate-login' | 'missing-origin' | 'reused-password' | 'weak-password';
export interface VaultHealthFinding { id: string; issues: VaultHealthIssue[] }
export interface VaultHealthReport { checked: number; findings: VaultHealthFinding[] }

export interface UpdateServiceInput {
  endpoint: string;
  accessToken: string;
}

export interface UpdateServiceStatus {
  configured: boolean;
  currentVersion: string;
  source: 'public' | 'private';
  endpoint: string;
  error?: 'configuration-corrupt' | 'os-encryption-unavailable';
}

export interface ReleaseManifest {
  schemaVersion: 1;
  appId: 'private-browser';
  version: string;
  buildNumber: number;
  channel: 'stable' | 'beta';
  publishedAt: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  commitSha: string;
  releaseNotes: string;
  downloadUrl: string;
  downloadPageUrl: string;
  expiresAt: string;
}

export interface UpdateCheckResult {
  state: 'available' | 'up-to-date';
  currentVersion: string;
  latest: ReleaseManifest;
  checkedAt: string;
}

export interface ManagedUpdateStatus {
  phase: 'idle' | 'preparing' | 'downloading' | 'verifying' | 'ready' | 'launched' | 'installed' | 'failed';
  version?: string;
  receivedBytes?: number;
  totalBytes?: number;
  publisher?: DownloadEntry['publisher'];
  message?: string;
  failure?: 'release' | 'verification' | 'storage' | 'launch' | 'cancelled';
}
export type { BridgeStatus, GitRevision, ProjectInfo, ProjectSummary, TestKind, TestReport } from '@private-browser/bridge-protocol';

/** The AI Development Control Center link (docs/systems/control-center-link.md). */
export type ControlCenterState = 'not-paired' | 'connected' | 'unreachable' | 'identity-changed' | 'unavailable';

export interface ControlCenterStatus {
  state: ControlCenterState;
  /** The address the Control Center answers at (loopback only). */
  url: string;
  /** The pinned key's fingerprint, to compare with the Control Center's pairing dialog. */
  fingerprint?: string;
  /** Plain reason for any state other than connected. */
  detail?: string;
}

export interface ControlCenterRepository {
  id: string;
  name: string;
  devOrigin: string | null;
}

export interface ControlCenterTask {
  id: string;
  title: string;
  repositoryName: string;
  status: string;
  currentStageName: string | null;
  blocker: string | null;
  finalStatus: string | null;
  createdAt: string;
  updatedAt: string;
  /** Where the task opens in the Control Center dashboard. */
  dashboardUrl: string;
}

export interface ControlCenterSendInput {
  approvalToken: string;
  repositoryId: string;
  /** The operator's own words: what should be fixed. */
  note: string;
}

export interface ControlCenterRecheckInput {
  approvalToken: string;
  taskId: string;
}
