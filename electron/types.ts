export type WorkspaceId = 'digitronics' | 'tenten' | 'development' | 'personal' | 'banking';

export interface Workspace {
  id: WorkspaceId;
  name: string;
  color: string;
  icon: string;
  protected: boolean;
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
  /** Workspace-relative source path inferred only from a loopback development URL. */
  sourcePath?: string;
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

export type AgentTaskMode = 'diagnose' | 'build' | 'autopilot';

export interface AgentCapability {
  id: string;
  label: string;
}

export interface AgentBridgeStatus {
  state: 'starting' | 'ready' | 'pairing' | 'connected' | 'error';
  paired: boolean;
  connected: boolean;
  endpoint: 'local-os-pipe';
  client?: {
    name: string;
    version: string;
    connectedAt: string;
  };
  capabilities: AgentCapability[];
  error?: string;
}

export interface AgentPairingSession {
  code: string;
  expiresAt: string;
}

export interface AgentEditorDiagnostic {
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  file: string;
  line: number;
  source?: string;
}

export interface AgentEditorContext {
  workspaceTrusted: boolean;
  workspaceName?: string;
  rootName?: string;
  activeFile?: {
    path: string;
    language: string;
    selection?: string;
    line: number;
  };
  diagnostics: AgentEditorDiagnostic[];
  git?: {
    branch?: string;
    dirty: boolean;
    changedFiles: number;
  };
  tasks: string[];
  capturedAt: string;
}

export interface AgentTaskRequest {
  objective: string;
  mode: AgentTaskMode;
  includeDiagnostics: boolean;
}

export interface AgentTaskPlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed';
}

export interface AgentTaskEvent {
  at: string;
  kind: 'status' | 'message' | 'command' | 'file' | 'error';
  text: string;
}

export interface AgentTaskSnapshot {
  id: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted';
  mode: AgentTaskMode;
  objective: string;
  startedAt: string;
  completedAt?: string;
  threadId?: string;
  turnId?: string;
  plan: AgentTaskPlanStep[];
  events: AgentTaskEvent[];
  answer: string;
  diff: string;
  error?: string;
}

export interface AgentRuntimeStatus {
  available: boolean;
  command: 'codex';
  version?: string;
  activeTask?: AgentTaskSnapshot;
  error?: string;
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
