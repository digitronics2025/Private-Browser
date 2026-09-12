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

export interface AccountSpaceSummary {
  id: AccountSpaceId;
  workspaceId: WorkspaceId;
  label: string;
  color: AccountSpaceColor;
  order: number;
  kind: AccountSpaceKind;
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

export type PermissionCapability =
  | 'notifications'
  | 'microphone'
  | 'camera'
  | 'display-capture'
  | 'geolocation'
  | 'clipboard-read'
  | 'clipboard-write'
  | 'file-system'
  | 'download';

export type PermissionDecision = 'allow-once' | 'allow-session' | 'allow-always' | 'deny';

export interface PermissionPrompt {
  id: string;
  accountSpaceId: AccountSpaceId;
  workspaceId: WorkspaceId;
  origin: string;
  capability: PermissionCapability;
  createdAt: string;
  expiresAt: string;
}

export interface PermissionPromptResponse {
  promptId: string;
  decision: PermissionDecision;
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
  tabs: Array<Pick<AccountSpaceBrowserTab, 'id' | 'workspaceId' | 'accountSpaceId' | 'title' | 'url' | 'isHome'>>;
  activeTabId: string;
  bookmarks: AccountSpaceBookmark[];
  history: AccountSpaceHistoryEntry[];
}

export interface BrowserStateManifestV2 {
  version: 2;
  activeWorkspaceId: WorkspaceId;
  accountSpaceIds: AccountSpaceId[];
  activeAccountSpaceByWorkspace: Partial<Record<WorkspaceId, AccountSpaceId>>;
  trackerBlocking: boolean;
  privacyLog: PrivacyEvent[];
}

export interface BrowserTab {
  id: string;
  workspaceId: WorkspaceId;
  title: string;
  url: string;
  favicon?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isHome: boolean;
  developerToolsAllowed: boolean;
  developerToolsOpen: boolean;
  securityWarning?: 'insecure' | 'idn';
}

export interface Bookmark {
  id: string;
  title: string;
  url: string;
  workspaceId: WorkspaceId;
  createdAt: string;
}

export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  workspaceId: WorkspaceId;
  visitedAt: string;
}

export interface DownloadEntry {
  id: string;
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  savePath?: string;
  /** Set once a completed download has been compared against the release manifest. */
  checksum?: 'verified' | 'mismatch' | 'unchecked';
  risk: 'ordinary' | 'dangerous' | 'deceptive';
}

export interface PrivacyEvent {
  id: string;
  at: string;
  kind: 'local-read' | 'cloud-approved' | 'blocked' | 'vault';
  title: string;
  detail: string;
}

export interface BrowserSnapshot {
  workspaces: Workspace[];
  activeWorkspaceId: WorkspaceId;
  activeTabId: string;
  tabs: BrowserTab[];
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  downloads: DownloadEntry[];
  privacyLog: PrivacyEvent[];
  trackerBlocking: boolean;
  /** Present after Account Spaces initialization; contains renderer-safe data only. */
  activeAccountSpaceId?: AccountSpaceId;
  accountSpaces?: AccountSpaceSummary[];
  accountHealth?: AccountSpaceHealth[];
  recovery?: StateRecoveryStatus;
  pendingPermission?: PermissionPrompt;
}

export interface PersistedState {
  version: 1;
  activeWorkspaceId: WorkspaceId;
  tabs: Array<Pick<BrowserTab, 'id' | 'workspaceId' | 'title' | 'url' | 'isHome'>>;
  activeTabByWorkspace: Partial<Record<WorkspaceId, string>>;
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  privacyLog: PrivacyEvent[];
  trackerBlocking: boolean;
}

export interface AiPagePreview {
  id: string;
  title: string;
  url: string;
  text: string;
  redactions: number;
  protectedPage: boolean;
}

export interface AiApproval {
  token: string;
  preview: AiPagePreview;
}

export interface AiProviderStatus {
  configured: boolean;
  endpoint?: string;
  model?: string;
  error?: 'provider-corrupt' | 'os-encryption-unavailable';
}

export interface AiProviderInput {
  endpoint: string;
  model: string;
  apiKey: string;
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
  reason?: 'os-encryption-unavailable' | 'vault-corrupt';
  items: VaultItemMeta[];
}

export interface UpdateServiceInput {
  endpoint: string;
  accessToken: string;
}

export interface UpdateServiceStatus {
  configured: boolean;
  currentVersion: string;
  endpoint?: string;
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
