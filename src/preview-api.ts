import type { PrivateBrowserApi } from '../electron/preload.cjs';
import { chromeCollections } from '../electron/chrome-collections';
import type { ChromeImportOptions, ChromePasswordImportReview, GoogleActionReceipt, GoogleMutationConfirmation } from '../electron/types';
import type { VaultHealthReport } from '../electron/types';
import type { PermissionGrantSummary, SitePermissionStatus } from '../electron/types';
import type { AiPagePreview, AiRequestReview, AssistantAnswer, AssistantReceipt, AssistantSelectionEdit, AssistantSelectionSource, PageExcerptReview } from '../electron/types';
import type { AccountSpaceId, AiProviderInput, AiProviderStatus, BackupRestorePreview, BackupUploadPreview, Bookmark, BookmarkLevelInput, BrowserSnapshot, BrowserTab, GoogleModule, RecentlyClosedTab, ShortcutTile, TabBatchScope, TabGroup, TabOrganizationAction, UiPreferencesPatch, Workspace, WorkspaceId } from '../electron/types';
import { isPinnablePanelTool, mergeUiPreferences, DEFAULT_UI_PREFERENCES } from '../electron/ui-preferences';
import { DEFAULT_BROWSER_SETTINGS, mergeBrowserSettings, nextZoomPercent, referenceSearchUrl, requireBrowserSettingsPatch, resolveHomeUrl, resolveWorkspaceNavigation, settingsForWorkspace } from '../electron/browser-settings';
import type { BrowserSettings, BrowserSettingsPatch, ManagedUpdateStatus, PinnablePanelTool, SidePanelTool } from '../electron/types';
import { parseWebAddress, redactSensitiveText } from '../electron/security';
import { canPauseTrackersAt, TrackerProtection } from '../electron/tracker-protection';
import { memorySaverOrigin } from '../electron/memory-saver';
import { MIN_SPLIT_WIDTH, splitPageAllowed } from '../electron/split-view';
import { AI_SYSTEM_PROMPT, MAX_ASSISTANT_CONTEXT, assistantQuestion, aiUserPrompt, formatAssistantExcerpts, readAssistantAnswer } from '../electron/ai-prompt';
import { findAddressMatches } from '../electron/address-matches';
import { queryHistory } from '../electron/history-query';
import { browsingDataVisitIds, requireBrowsingDataInput } from '../electron/browsing-data';
import type { BrowsingDataReview } from '../electron/types';
import { planBookmarkBatch } from '../electron/bookmark-batch';
import { changeBookmarkBatch, editBookmarkAddress, restoreBookmarkBatch, type BookmarkUndo } from '../electron/bookmark-maintenance';
import { canonicalRoutineUrl, defaultBrowserRoutines, requireBrowserRoutine } from '../electron/browser-routines';
import { appendTabSetBookmarks, resolveTabSet } from '../electron/tab-sets';
import type { ReferenceSearchInput, TabSetInput } from '../electron/types';
import { keepTabBlockIndex, orderAccountTabs, organizeTabs, replaceAccountTabOrder, tabBatchTargets } from '../electron/tab-organization';
import { canUseDeveloperTools } from '../electron/developer-tools';
import { createBookmarkFolder, editBookmarkFolder, moveTabWithinAccountSpace, nextBookmarkOrder, rememberBookmarkFolders, removeBookmark, renameBookmark, reorderBookmarkLevel } from '../electron/bookmark-tree';
import type { AgentUiStatus } from '../electron/agent-types';

const WORKSPACES: Workspace[] = [
  { id: 'digitronics', name: 'Digitronics', color: '#6a92ff', icon: 'D', protected: false },
  { id: 'tenten', name: 'TenTen', color: '#ffbd59', icon: 'T', protected: false },
  { id: 'development', name: 'Development', color: '#a78bfa', icon: '</>', protected: false },
  { id: 'personal', name: 'Personal', color: '#4fd1a5', icon: 'P', protected: false },
  { id: 'banking', name: 'Banking', color: '#ff6b7a', icon: 'B', protected: true },
];

const ids = {
  digitronics: '11f6ab55-582f-4b7d-bcb3-b1f0da787fba', tenten: '28b49df5-9286-40b4-84e5-c7cf20423725', development: '3bb91e1b-802d-4ca9-b359-e10f2d5f80ea',
  personal: '488b65fc-5f95-4d2b-af17-2cfd11b999f0', banking: '50c9995c-d128-4a9e-a636-7e3988086987', google: '6be141ef-05f1-46d6-bd35-d743c85faf03',
} as const satisfies Record<string, string>;

function account(id: string, workspaceId: WorkspaceId, label: string, color: 'indigo' | 'sky' | 'emerald' | 'amber' | 'rose' | 'violet' | 'slate', order = 0) {
  return { id: id as AccountSpaceId, workspaceId, label, color, order, kind: 'local' as const, createdAt: '2026-09-12T10:00:00Z', lastUsedAt: '2026-09-12T12:00:00Z', locked: false, googleConnection: 'disconnected' as const, websiteStatus: 'not-visited' as const, enabledModules: [], grantedScopes: [], backupEnabled: false, backupIncludesOpenTabs: false, backupIncludesHistory: false };
}

function homeTab(id: string, workspaceId: WorkspaceId, accountSpaceId: AccountSpaceId): BrowserTab {
  return { id, workspaceId, accountSpaceId, title: 'New tab', url: 'private://home', loading: false, canGoBack: false, canGoForward: false, isHome: true, developerToolsAllowed: false, developerToolsOpen: false };
}

function pageTab(id: string, accountSpaceId: AccountSpaceId, title: string, url: string, extra: Partial<BrowserTab> = {}): BrowserTab {
  return { ...homeTab(id, 'personal', accountSpaceId), title, url, isHome: false, canGoBack: true, zoomPercent: 100, securityWarning: url.startsWith('http:') ? 'insecure' : undefined, ...extra };
}

function bookmark(id: string, title: string, url: string, folderPath: string[], orderPath: number[], location: Bookmark['location'] = 'bar'): Bookmark {
  return { id, workspaceId: 'personal', accountSpaceId: ids.google as AccountSpaceId, title, url, createdAt: '2026-09-12T11:00:00Z', location, folderPath, order: orderPath[0], orderPath };
}

/** Credential-free data so the chrome can be reviewed in a normal browser during development. */
export function installPreviewApi(): void {
  if (!import.meta.env.DEV || 'privateBrowser' in window || new URLSearchParams(location.search).get('preview') === 'bridge') return;
  const params = new URLSearchParams(location.search);
  const overviewFixture = params.get('googleOverview') === 'sample';
  const googleActionFixture = params.get('googleActions');
  const googleModules: GoogleModule[] = googleActionFixture ? ['identity', 'gmail-metadata', 'gmail-send', 'drive-files', 'calendar-write'] : overviewFixture
    ? ['identity', 'gmail-metadata', 'drive-files'] : ['identity', 'gmail-metadata', 'drive-files', 'calendar-read'];
  const accounts = [
    account(ids.digitronics, 'digitronics', 'Digitronics', 'indigo'), account(ids.tenten, 'tenten', 'TenTen', 'amber'), account(ids.development, 'development', 'Development', 'violet'),
    account(ids.personal, 'personal', 'Personal', 'emerald'),
    { ...account(ids.google, 'personal', 'Operations', 'sky', 1), kind: 'google' as const, email: 'operations@example.com', displayName: 'Operations Team', googleConnection: 'connected' as const, websiteStatus: 'session-data-present' as const, enabledModules: googleModules, grantedScopes: ['openid', 'email', 'profile'] },
    account(ids.banking, 'banking', 'Banking', 'rose'),
  ];
  const google = ids.google as AccountSpaceId;
  const overviewCursor = overviewFixture || googleActionFixture ? crypto.randomUUID() : undefined;
  const fixtureReply = crypto.randomUUID();
  const vaultHealthFixture = { id: 'preview-vault-health', label: 'Sample login', username: 'sample@example.test',
    url: 'https://shop.example.test', hasTotp: false, updatedAt: '2026-11-21T10:00:00Z' };
  const state: BrowserSnapshot = {
    settings: { ...DEFAULT_BROWSER_SETTINGS },
    availableSpellcheckLanguages: ['en', 'fr'],
    assistantPolicy: { cloud: 'allowed', receipts: [] },
    workspaces: WORKSPACES,
    activeWorkspaceId: 'personal',
    activeAccountSpaceId: google,
    activeTabId: `preview-${ids.google}`,
    tabs: [
      ...accounts.map((item) => homeTab(`preview-${item.id}`, item.workspaceId, item.id)),
      pageTab('preview-docs', google, 'Quarterly operations review — shared planning document with a very long title', 'https://docs.google.com/document/d/preview'),
      pageTab('preview-media', google, 'Team update video', 'https://media.example.com/watch', { audible: true }),
      pageTab('preview-intranet', google, 'Legacy intranet dashboard', 'http://intranet.example.test/'),
      // Loopback development servers carry no warning chip but are still unencrypted.
      pageTab('preview-localdev', google, 'Local dev server', 'http://localhost:4173/', { securityWarning: undefined }),
    ],
    bookmarks: [
      bookmark('preview-bookmark', 'Google Drive', 'https://drive.google.com/', [], [0]),
      bookmark('preview-calendar', 'Calendar', 'https://calendar.google.com/', [], [1]),
      bookmark('preview-finance-1', 'Invoices', 'https://billing.example.com/invoices', ['Finance'], [2, 0]),
      bookmark('preview-finance-2', 'Supplier payments', 'https://billing.example.com/payments', ['Finance'], [2, 1]),
      bookmark('preview-finance-3', 'Annual reports', 'https://reports.example.com/', ['Finance', 'Reports'], [2, 2, 0]),
      bookmark('preview-marketing', 'Campaign planner', 'https://planner.example.com/', ['Marketing'], [3, 0]),
      ...Array.from({ length: 14 }, (_, index) => bookmark(`preview-extra-${index}`, `Supplier portal ${index + 1}`, `https://supplier${index + 1}.example.com/`, [], [4 + index])),
      bookmark('preview-other', 'Reading list article', 'https://news.example.com/article', [], [0], 'other'),
      ...(params.get('bookmarks') === 'duplicates' ? [bookmark('preview-duplicate', 'Invoice reference', 'https://billing.example.com/invoices', ['Archive'], [1, 0], 'other')] : []),
      ...(params.get('bookmarks') === 'large' ? Array.from({ length: 24_900 }, (_, index) => bookmark(
        'preview-large-' + index, 'Sample bookmark ' + index, 'https://bookmarks.example.test/' + index,
        ['Import folder ' + Math.floor(index / 100)], [100 + Math.floor(index / 100), index % 100], 'other',
      )) : []),
    ],
    history: [
      { id: 'preview-history', workspaceId: 'personal', accountSpaceId: google, title: 'Calendar', url: 'https://calendar.google.com/', visitedAt: new Date().toISOString() },
      ...(params.get('history') === 'large' ? [
        ...Array.from({ length: 105 }, (_, index) => ({
          id: 'sample-visit-' + index, workspaceId: 'personal' as const, accountSpaceId: google,
          title: 'Sample visit ' + index, url: 'https://log.example.test/' + index, visitedAt: '2026-10-09T12:00:00.000Z',
        })),
        ...['01', '02'].map((day) => ({
          id: 'sample-older-' + day, workspaceId: 'personal' as const, accountSpaceId: google,
          title: 'Older sample visit', url: 'https://archive.example.test/older', visitedAt: '2026-10-' + day + 'T12:00:00.000Z',
        })),
      ] : []),
    ],
    downloads: params.get('downloads') === 'sample' ? [
      { id: 'preview-progress', accountSpaceId: google, filename: 'sample.pdf', receivedBytes: 12, totalBytes: 200, state: 'progressing',
        risk: 'ordinary', extension: 'PDF', canPause: true, canCancel: true },
      { id: 'preview-installer', accountSpaceId: google, filename: 'installer-sample.exe', receivedBytes: 200, totalBytes: 200, state: 'completed', risk: 'dangerous', extension: 'EXE',
        checksum: 'verified', publisher: { state: 'unsigned' } },
      { id: 'preview-mismatch', accountSpaceId: google, filename: 'invalid-installer.exe', receivedBytes: 200, totalBytes: 200, state: 'completed', risk: 'dangerous',
        extension: 'EXE', checksum: 'mismatch' },
      { id: 'preview-checking', accountSpaceId: google, filename: 'checking.exe', receivedBytes: 200, totalBytes: 200,
        state: 'completed', risk: 'dangerous', extension: 'EXE', checksum: 'checking' },
      { id: 'preview-interrupted', accountSpaceId: google, filename: 'interrupted.pdf', receivedBytes: 12, totalBytes: 200,
        state: 'interrupted', risk: 'ordinary', extension: 'PDF', canResume: true, canCancel: true },
    ] : [], privacyLog: [], trackerBlocking: true, bookmarkBarVisible: true,
    accountSpaces: accounts.map((item) => ({ ...item, enabledModules: [...item.enabledModules], grantedScopes: [...item.grantedScopes] })),
    accountHealth: accounts.map((item) => ({ accountSpaceId: item.id, status: item.googleConnection, checkedAt: '2026-09-12T12:00:00Z' })),
    googleConfiguration: { configured: true, source: 'encrypted-settings' },
    externalBrowsers: [{ id: 'edge', name: 'Microsoft Edge' }, { id: 'chrome', name: 'Google Chrome' }],
    ui: { ...DEFAULT_UI_PREFERENCES, offerSetupGuide: params.get('setup') === 'new', sidePanelOpen: params.get('panel') === 'open',
      theme: params.get('theme') === 'light' ? 'light' : params.get('theme') === 'dark' ? 'dark' : 'system' },
    setupVaultStatus: 'unconfigured',
    windowState: { maximized: false, fullscreen: false, darkMode: true },
    shortcutsByAccountSpace: {},
    bookmarkIcons: {},
    canReopenClosedTab: false,
    sideApps: [
      { id: 'claude', name: 'Claude', status: 'ready', canGoBack: false, canGoForward: false },
      { id: 'easynote', name: 'Notes', status: params.get('notes') === 'offline' ? 'offline' : 'ready', canGoBack: false, canGoForward: false },
    ],
    // ?permission=prompt shows a pending site-permission prompt for the e2e suite.
    ...(params.get('permission') === 'prompt' ? { pendingPermission: { id: 'preview-permission', accountSpaceId: ids.personal as AccountSpaceId, workspaceId: 'personal' as const, origin: 'https://meet.google.com', capability: 'notifications' as const, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } } : {}),
  };
  const media = matchMedia('(prefers-color-scheme: dark)');
  if (params.get('recovery') === 'crashed') {
    state.activeTabId = 'preview-docs';
    state.tabs.find((tab) => tab.id === state.activeTabId)!.problem = 'crashed';
  }
  if (params.get('recovery') === 'startup') {
    state.startupTabRecovery = { accountSpaceId: google, failedTabId: 'preview-docs' };
  }
  const syncDarkMode = () => { state.windowState.darkMode = state.ui.theme === 'system' ? media.matches : state.ui.theme === 'dark'; };
  syncDarkMode();
  const listeners = new Set<(snapshot: BrowserSnapshot) => void>();
  const chromeSnapshot = (): BrowserSnapshot => structuredClone({ ...state, ...chromeCollections(state, state.activeAccountSpaceId, state.activeWorkspaceId) });
  let backupRestoreReview: BackupRestorePreview | undefined;
  let backupUploadReview: BackupUploadPreview | undefined;
  const backupGenerationFixture = params.get('backupGenerations') === 'sample';
  const previousBackups = [
    { createdAt: '2026-11-20T12:00:00.000Z', bookmarks: 5, folders: 2, tabs: 2, history: 0 },
    { createdAt: '2026-11-09T12:00:00.000Z', bookmarks: 2, folders: 1, tabs: 0, history: 0 },
  ];
  if (params.get('backupRestore') === 'sample' || backupGenerationFixture) {
    const account = state.accountSpaces.find(({ id }) => id === google)!;
    account.enabledModules.push('encrypted-backup');
    if (backupGenerationFixture) Object.assign(account, {
      backupEnabled: true, backupReminderDays: 14, backupReminderAt: new Date(Date.now() + 60_000).toISOString(),
      backupLastUploadedAt: previousBackups[0].createdAt,
    });
  }
  const closedByAccount = new Map<AccountSpaceId, RecentlyClosedTab[]>();
  let routines = defaultBrowserRoutines(Object.fromEntries(accounts.filter((account) => account.id !== google).map((account) => [account.workspaceId, account.id])));
  state.routines = routines;
  const groupsByAccount = new Map<AccountSpaceId, TabGroup[]>();
  const batchesByAccount = new Map<AccountSpaceId, { entries: BrowserTab[]; groups: TabGroup[]; groupName?: string }>();
  const sampleDownloads = state.downloads;
  const fixtureGoogleReviews = new Map<string, string>();
  const fixtureGoogleReceipts = new Map<string, GoogleActionReceipt>();
  const fixtureGoogleAccount = (id: AccountSpaceId) => {
    if (!googleActionFixture || id !== google || state.activeAccountSpaceId !== id) throw new Error('Open the original Account Space.');
  };
  const prepareFixtureAction = (id: AccountSpaceId, service: 'gmail' | 'drive' | 'calendar', payload: unknown): GoogleMutationConfirmation => {
    fixtureGoogleAccount(id);
    const token = crypto.randomUUID();
    fixtureGoogleReviews.set(token, JSON.stringify({ service, payload }));
    return { accountSpaceId: id, service, token, action: 'Google action', target: 'Fixture', expiresAt: new Date(Date.now() + 300_000).toISOString() };
  };
  const applyFixtureAction = (id: AccountSpaceId, service: 'gmail' | 'drive' | 'calendar', payload: unknown, token: string) => {
    fixtureGoogleAccount(id);
    const reviewed = fixtureGoogleReviews.get(token);
    fixtureGoogleReviews.delete(token);
    if (reviewed !== JSON.stringify({ service, payload })) throw new Error('Review this Google action again.');
    const prior = fixtureGoogleReceipts.get(reviewed);
    if (prior) return { ok: false, receipt: prior };
    const confirmed = googleActionFixture !== 'uncertain';
    const receipt: GoogleActionReceipt = { id: crypto.randomUUID(), state: confirmed ? 'confirmed' : 'unconfirmed', at: new Date().toISOString(), providerId: confirmed ? 'fixture-google-reference' : undefined };
    fixtureGoogleReceipts.set(reviewed, receipt);
    return { ok: receipt.state === 'confirmed', receipt };
  };
  const savedDownloadHistory = new Set<AccountSpaceId>();
  const memorySites = new Map<AccountSpaceId, Set<string>>();
  if (params.get('memorySaver') === 'sample') {
    state.tabs.push(pageTab('preview-sleeping-tab', google, 'Reading list', 'https://reading.example.test/', { sleeping: true }));
  }
  let trackerBlocking = state.trackerBlocking;
  const trackers = new TrackerProtection();
  if (params.get('trackers') === 'sample') {
    const fixture = { origin: 'https://reference.example.test', enabled: true, strict: false };
    trackers.shouldBlock(state.activeAccountSpaceId, 'advertising', fixture);
    trackers.shouldBlock(state.activeAccountSpaceId, 'analytics', fixture);
  }
  const previewDownloadFolders = new Map<AccountSpaceId, { name: string; ask: boolean }>();
  const previewPanelTools = new Map<AccountSpaceId, SidePanelTool>();
  const previewPanelPins = new Map<AccountSpaceId, Set<PinnablePanelTool>>();
  const regularPanelAccount = () => state.activeWorkspaceId !== 'banking'
    && state.accountSpaces.some(({ id, locked }) => id === state.activeAccountSpaceId && !locked);
  let commonPanelTool = state.ui.sidePanelTool;
  state.sidePanelPins = regularPanelAccount() ? [] : undefined;
  if (params.get('downloadHistory') === 'sample') {
    savedDownloadHistory.add(google);
    sampleDownloads.push({ id: 'preview-download-history', accountSpaceId: google, filename: 'Statement.pdf',
      origin: 'https://billing.example.test', finishedAt: '2026-11-20T16:00:00Z', state: 'completed',
      receivedBytes: 1920, totalBytes: 1920, extension: 'PDF', risk: 'ordinary', retained: true });
  }
  state.downloadHistory = savedDownloadHistory.has(state.activeAccountSpaceId) ? 'on' : 'off';
  state.downloadFolder = { ask: true, available: true };
  let managedUpdate: ManagedUpdateStatus | undefined = params.get('managedUpdate') === 'installed'
    ? { phase: 'installed', version: '0.5.7' }
    : params.get('managedUpdate') === 'sample' ? { phase: 'idle' } : undefined;
  state.managedUpdate = managedUpdate;
  const workspaceSettings: Partial<Record<WorkspaceId, BrowserSettings>> = {};
  const siteZoom = new Map<string, number>();
  const siteZoomKey = (account: string, url: string) => JSON.stringify([account, new URL(url).origin]);
  let pendingChromeImport: { id: string; options: ChromeImportOptions; owner: AccountSpaceId } | undefined;
  let clearDataReview: { review: BrowsingDataReview; initiator: AccountSpaceId; visits: Set<string> } | undefined;
  let passwordReview: { review: ChromePasswordImportReview; accountId: AccountSpaceId } | undefined;
  const chromeUndo = new Map<AccountSpaceId, { profileId: string; bookmark: boolean; history: boolean; settings?: BrowserSettings }>();
  const importedChromeProfiles = new Map<string, AccountSpaceId>();
  const chromeSettingsFixture = (options: ChromeImportOptions) => {
    const selected = options.settings ?? {};
    const patch: BrowserSettingsPatch = {
      ...(selected.search ? { searchEngine: 'google' } : {}), ...(selected.home ? { homePage: 'url', homePageUrl: 'https://reference.example.test/' } : {}),
      ...(selected.startup ? { startup: 'new-tab' } : {}),
    };
    const appliedSettings = (['search', 'home', 'startup'] as const).filter((key) => selected[key]);
    return { patch: appliedSettings.length ? patch : undefined, appliedSettings };
  };
  let sampleGrants: PermissionGrantSummary[] = params.get('permissions') === 'sample' ? [
    { origin: 'https://example.test', capability: 'download', duration: 'until-revoked' },
    { origin: 'https://mail.google.com', capability: 'notifications', duration: 'session' },
  ] : [];
  let previewProvider: AiProviderStatus = { configured: false };
  let assistantPage: AiPagePreview | undefined;
  let claudeExcerpt: PageExcerptReview | undefined;
  let assistantReview: { data: AiRequestReview; context: string[]; withEvidence: boolean } | undefined;
  const assistantExtraSources = new Map<string, AssistantSelectionSource>();
  let timeoutFixtureUsed = false;
  let previewRequest: { id: string; finish: (answer: AssistantAnswer) => void } | undefined;
  const disabledCloudAccounts = new Set<AccountSpaceId>();
  const assistantReceipts = new Map<AccountSpaceId, AssistantReceipt[]>();
  let vaultClipboardUntil: number | undefined;
  const bookmarkUndos = new Map<AccountSpaceId, BookmarkUndo>();
  const savedBookmarkFolders = new Map([[google, rememberBookmarkFolders(state.bookmarks.filter((item) => item.accountSpaceId === google), [])]]);
  const getPreviewFolders = (id: AccountSpaceId) => savedBookmarkFolders.get(id) ?? [];
  const updatePreviewFolder = (id: AccountSpaceId, source: BookmarkLevelInput, destination?: BookmarkLevelInput) => {
    if (id !== state.activeAccountSpaceId) throw new Error('The Account Space changed');
    const result = editBookmarkFolder(state.bookmarks, getPreviewFolders(id), id, source, destination);
    state.bookmarks = result.bookmarks;
    savedBookmarkFolders.set(id, result.folders);
    publish();
  };
  const splitPairs = new Map<AccountSpaceId, Pick<NonNullable<BrowserSnapshot['splitView']>, 'leftTabId' | 'rightTabId'>>();
  let splitInsets = 0;
  const splitSuspended = () => state.windowState.fullscreen || window.innerWidth - splitInsets < MIN_SPLIT_WIDTH;
  const publish = () => {
    state.bookmarkFolders = getPreviewFolders(state.activeAccountSpaceId);
    state.settings = settingsForWorkspace({ settings: DEFAULT_BROWSER_SETTINGS, workspaceSettings }, state.activeWorkspaceId);
    const assistantUnavailable = state.activeWorkspaceId === 'banking' || state.accountSpaces.some((account) => account.id === state.activeAccountSpaceId && account.locked);
    state.assistantPolicy = assistantUnavailable ? { cloud: 'unavailable', receipts: [] } : {
      cloud: disabledCloudAccounts.has(state.activeAccountSpaceId) ? 'disabled' : 'allowed',
      receipts: assistantReceipts.get(state.activeAccountSpaceId) ?? [],
    };
    state.bookmarkBarVisible = state.ui.bookmarkBarMode !== 'hidden';
    const privateWorkspace = state.activeWorkspaceId === 'banking';
    state.trackerBlocking = privateWorkspace || trackerBlocking;
    const activeTrackingTab = state.tabs.find(({ id }) => id === state.activeTabId);
    const pair = splitPairs.get(state.activeAccountSpaceId);
    state.splitView = undefined;
    if (pair) {
      const left = state.tabs.find((tab) => tab.id === pair.leftTabId);
      const right = state.tabs.find((tab) => tab.id === pair.rightTabId);
      if (!left || !right || !splitPageAllowed(left) || !splitPageAllowed(right)) splitPairs.delete(state.activeAccountSpaceId);
      else if (!assistantUnavailable && (activeTrackingTab === left || activeTrackingTab === right)) {
        state.splitView = { ...pair, suspended: splitSuspended() };
      }
    }
    state.trackerSite = activeTrackingTab && !activeTrackingTab.isHome ? trackers.status(state.activeAccountSpaceId,
      new URL(activeTrackingTab.url).origin, { enabled: trackerBlocking, strict: privateWorkspace,
        canPause: !privateWorkspace && trackerBlocking && canPauseTrackersAt(activeTrackingTab.url) }) : undefined;
    const memorySite = !privateWorkspace && activeTrackingTab && !activeTrackingTab.isHome ? memorySaverOrigin(activeTrackingTab.url) : undefined;
    state.memorySaverSite = memorySite ? { origin: memorySite, keptAwake: memorySites.get(state.activeAccountSpaceId)?.has(memorySite) === true } : undefined;
    state.downloads = sampleDownloads.filter((item) => item.accountSpaceId === state.activeAccountSpaceId);
    state.downloadHistory = state.activeWorkspaceId === 'banking' ? undefined : savedDownloadHistory.has(state.activeAccountSpaceId) ? 'on' : 'off';
    state.downloadFolder = state.activeWorkspaceId === 'banking' ? undefined : {
      ask: true, available: true, ...previewDownloadFolders.get(state.activeAccountSpaceId),
    };
    state.downloadBatch = state.activeWorkspaceId === 'banking' ? undefined
      : state.downloads.filter((download) => download.id !== 'preview-download-history').reduce((status, download) => {
        if (download.state === 'progressing' || download.canCancel) status.active++;
        else if (download.state === 'completed') status.completed++;
        else status.stopped++;
        return status;
      }, { active: 0, completed: 0, stopped: 0 });
    const regularPanel = regularPanelAccount();
    state.ui.sidePanelTool = isPinnablePanelTool(commonPanelTool)
      ? previewPanelTools.get(state.activeAccountSpaceId) ?? (regularPanel ? commonPanelTool : 'privacy')
      : commonPanelTool;
    state.sidePanelPins = regularPanel ? [...(previewPanelPins.get(state.activeAccountSpaceId) ?? [])] : undefined;
    state.managedUpdate = state.activeWorkspaceId === 'banking' ? undefined : managedUpdate;
    const undo = bookmarkUndos.get(state.activeAccountSpaceId);
    state.bookmarkUndo = undo ? { kind: undo.kind, count: undo.before.length } : undefined;
    state.recentlyClosedTabs = closedByAccount.get(state.activeAccountSpaceId) ?? [];
    state.canReopenClosedTab = state.recentlyClosedTabs.length > 0;
    state.routines = state.activeWorkspaceId === 'banking' ? [] : routines;
    state.tabGroups = (groupsByAccount.get(state.activeAccountSpaceId) ?? [])
      .filter((group) => state.tabs.some((tab) => tab.accountSpaceId === state.activeAccountSpaceId && tab.groupId === group.id));
    groupsByAccount.set(state.activeAccountSpaceId, state.tabGroups);
    const batch = batchesByAccount.get(state.activeAccountSpaceId);
    state.closedTabBatch = batch ? { count: batch.entries.length, groupName: batch.groupName } : undefined;
    listeners.forEach((listener) => listener(chromeSnapshot()));
  };
  const requireAssistantPolicy = (mode: 'cloud' | 'local') => {
    if (state.assistantPolicy.cloud === 'unavailable') throw new Error('Assistant requests are unavailable in this Account Space.');
    if (mode === 'cloud' && state.assistantPolicy.cloud === 'disabled') throw new Error('Cloud AI is disabled in this Account Space.');
  };
  const recordAssistantReceipt = (mode: AssistantReceipt['mode'], target: string, purpose: AssistantReceipt['purpose']) => {
    const id = state.activeAccountSpaceId;
    const receipt: AssistantReceipt = { at: new Date().toISOString(), mode, purpose, destination: new URL(target).origin };
    assistantReceipts.set(id, [receipt, ...assistantReceipts.get(id) ?? []].slice(0, 12));
    publish();
  };
  media.addEventListener('change', () => { syncDarkMode(); publish(); });
  globalThis.addEventListener('resize', () => { if (state.splitView && state.splitView.suspended !== splitSuspended()) publish(); });
  const activeTab = () => state.tabs.find((tab) => tab.id === state.activeTabId)!;
  const reopenPreviewTab = (id?: string) => {
    const closed = closedByAccount.get(state.activeAccountSpaceId);
    if (!closed?.length) return;
    const index = id ? closed.findIndex((entry) => entry.id === id) : 0;
    if (index < 0) return;
    const [entry] = closed.splice(index, 1);
    const tab = pageTab(crypto.randomUUID(), state.activeAccountSpaceId, entry.title, entry.url, { workspaceId: state.activeWorkspaceId });
    state.tabs.push(tab);
    if (!id) state.activeTabId = tab.id;
    publish();
  };
  const agentListeners = new Set<() => void>();
  const agentState: AgentUiStatus = { enabled: false, paused: false, active: false, clients: [], spaces: [], tabs: [], audit: [],
    command: 'node', commandArgs: ['packages/agent-mcp/dist/cli.js'] };
  const agentTabId = 'aeddf71a-49cd-4ab5-b36f-2244a9258852';
  const previewAgentAction = params.get('preview') === 'agent-action';
  const previewSiteApproval = params.get('preview') === 'agent-site-approval';
  if (previewAgentAction || previewSiteApproval) {
    Object.assign(agentState, {
      enabled: true, active: true, selectedTab: agentTabId,
      clients: [{ id: agentTabId, name: 'Codex', active: true, expiresAt: Date.now() + 60 * 60_000,
        policy: { profile: 'develop', outside: 'observe', session: '1h', origins: [] } }],
      tabs: [{ id: agentTabId, name: 'http://localhost:3000', client: 'Codex', space: 'Agent Account Space', manual: false }],
      current: { client: 'Codex', step: 'click', tabId: agentTabId },
      pending: { id: '9c7757bc-bf61-4685-9a31-9d38499f4ca0', client: 'Codex', tab: 'Agent Account Space',
        origin: 'http://localhost:3000', action: previewSiteApproval ? 'tab open' : 'click',
        target: previewSiteApproval ? undefined : 'button: Save',
        formTarget: previewSiteApproval ? undefined : 'http://localhost:3000/save',
        expiresAt: Date.now() + 120_000, canAllowSession: previewSiteApproval, canAllowAlways: previewSiteApproval },
    });
  }
  const agentChange = () => agentListeners.forEach((listener) => listener());
  const desktopOnly = async (): Promise<never> => { throw new Error('This action is available in the desktop app.'); };
  const handlers: PrivateBrowserApi = {
    getAgentStatus: async () => structuredClone(agentState),
    onAgentChanged: (listener) => {
      agentListeners.add(listener);
      return () => { agentListeners.delete(listener); };
    },
    setAgentsEnabled: async (enabled) => {
      agentState.enabled = enabled === true;
      agentState.spaces = agentState.enabled ? [{ id: agentTabId, name: 'Agent Account Space' }] : [];
      agentChange();
    },
    beginAgentPairing: async () => {
      agentState.pairing = { code: '12345678', expiresAt: Date.now() + 300_000 };
      agentChange();
    },
    decideAgentAction: async () => { agentState.pending = undefined; agentChange(); },
    stopAgents: async () => {
      agentState.active = false;
      agentState.current = undefined;
      agentState.tabs = [];
      agentState.pending = undefined;
      agentChange();
    },
    resumeAgents: desktopOnly,
    openAgentWorkspace: desktopOnly,
    revokeAgent: desktopOnly,
    renewAgent: desktopOnly,
    setAgentPolicy: desktopOnly,
    grantAgentUploads: desktopOnly,
    revokeAgentUploads: desktopOnly,
    addAgentSpace: desktopOnly,
    resetAgentSpace: desktopOnly,
    clearAgentAudit: desktopOnly,
    exportAgentAudit: desktopOnly,
    selectAgentTab: desktopOnly,
    setAgentTabManual: desktopOnly,
    closeAgentTab: desktopOnly,
    lendAgentTab: desktopOnly,
    returnAgentTab: desktopOnly,
    // A browser preview has no native pages, file dialogs, secure windows,
    // account tokens or local developer bridge. Make those limits explicit.
    back: desktopOnly,
    forward: desktopOnly,
    stop: async () => undefined,
    print: desktopOnly,
    openPdfInTab: desktopOnly,
    savePdf: desktopOnly,
    findInPage: desktopOnly,
    stopFindInPage: async () => undefined,
    setTabMuted: desktopOnly,
    hardReload: async () => handlers.reload(),
    addBookmarkFolder: async (id, parent, name) => {
      if (id !== state.activeAccountSpaceId) throw new Error('The Account Space changed');
      savedBookmarkFolders.set(id, createBookmarkFolder(state.bookmarks.filter((item) => item.accountSpaceId === id), getPreviewFolders(id), parent, name));
      publish();
    },
    moveBookmarkFolder: async (id, source, parent) => {
      const name = source.path.at(-1);
      if (!name) throw new Error('Choose a folder to move');
      updatePreviewFolder(id, source, { location: parent.location, path: [...parent.path, name] });
    },
    renameBookmarkFolder: async (parent, name, next, id) => updatePreviewFolder(id ?? state.activeAccountSpaceId,
      { ...parent, path: [...parent.path, name] }, { ...parent, path: [...parent.path, next.trim()] }),
    removeBookmarkFolder: async (parent, name, id) => updatePreviewFolder(id ?? state.activeAccountSpaceId, { ...parent, path: [...parent.path, name] }),
    exportBookmarks: desktopOnly,
    quit: desktopOnly,
    deleteAccountSpace: desktopOnly,
    clearGoogleConfiguration: desktopOnly,
    cancelGoogleConnection: async () => false,
    gmailOverview: desktopOnly,
    readGmailReplyDraft: async (id, _operation, messageId) => {
      fixtureGoogleAccount(id);
      if (messageId !== 'mail-current') throw new Error('The original message is unavailable.');
      return { ok: true, data: { sourceRevision: fixtureReply, recipient: 'stocks@example.test', subject: 'New stock update' } };
    },
    googleOverviewPage: async (id, _operation, service, next) => {
      if (!overviewCursor || id !== google || id !== state.activeAccountSpaceId || service === 'calendar') return desktopOnly();
      if (service === 'drive') return { ok: true, data: { page: 1, limited: false, items: [
        { id: 'file-fixture', title: 'Stock worksheet', original: 'https://drive.google.com/open?id=file-fixture' },
      ] } };
      if (next === overviewCursor) return { ok: true, data: { page: 2, limited: false, items: [
        { id: 'mail-older', title: 'Previous stock update', detail: 'stocks@example.test' },
      ] } };
      return { ok: true, data: { page: 1, next: overviewCursor, limited: false, items: [
        { id: 'mail-current', title: 'New stock update', detail: 'stocks@example.test', original: 'https://mail.google.com/mail/#inbox/mail-current' },
      ] } };
    },
    searchGmail: desktopOnly,
    prepareGmailSend: async (id, input, revision) => prepareFixtureAction(id, 'gmail', { input, revision }),
    sendGmail: async (id, _operation, input, token, revision) => applyFixtureAction(id, 'gmail', { input, revision }, token),
    listDriveFiles: desktopOnly,
    createDriveFile: desktopOnly,
    prepareDriveShare: async (id, fileId, email, role) => prepareFixtureAction(id, 'drive', { fileId, email, role }),
    shareDriveFile: async (id, _operation, fileId, email, role, token) => applyFixtureAction(id, 'drive', { fileId, email, role }, token),
    listCalendarEvents: desktopOnly,
    prepareCalendarWrite: async (id, action, input) => prepareFixtureAction(id, 'calendar', { action, input }),
    writeCalendarEvent: async (id, _operation, action, input, token) => applyFixtureAction(id, 'calendar', { action, input }, token),
    listContacts: desktopOnly,
    previewBackupUpload: async (id) => {
      if (!backupGenerationFixture || id !== google || state.activeAccountSpaceId !== id) throw new Error('Open the enabled backup in its unlocked Account Space.');
      backupUploadReview = { id: crypto.randomUUID(), accountSpaceId: id, conflict: true,
        local: { createdAt: new Date().toISOString(), bookmarks: 3, folders: 1, tabs: 1, history: 0 },
        remote: previousBackups[0], generations: previousBackups.slice(1),
        merged: { createdAt: new Date().toISOString(), bookmarks: 6, folders: 2, tabs: 3, history: 0 } };
      return backupUploadReview;
    },
    applyBackupUpload: async (id, _operation, resolution) => {
      if (backupUploadReview?.id !== id || backupUploadReview.accountSpaceId !== state.activeAccountSpaceId) throw new Error('Review the backup again before saving.');
      backupUploadReview = undefined;
      document.documentElement.dataset.previewBackupResolution = resolution;
      const account = state.accountSpaces.find(({ id }) => id === google)!;
      account.backupLastUploadedAt = new Date().toISOString();
      account.backupReminderAt = undefined;
      publish();
      return { status: 'uploaded', etag: 'fixture-backup-etag' };
    },
    cancelBackupUpload: async (id) => { if (backupUploadReview?.id === id) backupUploadReview = undefined; },
    setBackupReminder: async (id, days) => {
      if (!backupGenerationFixture || id !== google || state.activeAccountSpaceId !== id) throw new Error('The backup changed.');
      const account = state.accountSpaces.find(({ id }) => id === google)!;
      account.backupReminderDays = days;
      account.backupReminderAt = days ? new Date(Date.now() + days * 86_400_000).toISOString() : undefined;
      publish();
    },
    previewBackupRestore: async (id, _operation, code, generation) => {
      if (id !== google || (!backupGenerationFixture && (params.get('backupRestore') !== 'sample' || code !== 'fixture-recovery-code'))) {
        throw new Error('Encrypted backup failed authentication or is corrupt.');
      }
      backupRestoreReview = {
        id: crypto.randomUUID(), accountSpaceId: id, accountLabel: 'Operations', workspaceId: 'personal',
        createdAt: generation ?? (backupGenerationFixture ? previousBackups[0].createdAt : '2026-11-21T12:00:00.000Z'),
        ...(backupGenerationFixture ? { generations: previousBackups } : {}),
        counts: { bookmarks: { added: 2, duplicates: 1, capacityExceeded: 0 },
          history: { added: 0, duplicates: 1, capacityExceeded: 0 }, tabs: { added: 1, duplicates: 0, capacityExceeded: 2 } },
      };
      return backupRestoreReview;
    },
    applyBackupRestore: async (id) => {
      if (backupRestoreReview?.id !== id) throw new Error('Review the backup again before restoring.');
      document.documentElement.dataset.previewBackupApplied = backupRestoreReview.accountSpaceId;
      backupRestoreReview = undefined;
    },
    cancelBackupRestore: async (id) => { if (backupRestoreReview?.id === id) backupRestoreReview = undefined; },
    disableBackup: desktopOnly,
    cancelOperation: async () => false,
    performRecoveryAction: desktopOnly,
    captureDeveloperDiagnostics: desktopOnly,
    clearDeveloperDiagnostics: async () => undefined,
    disconnectBridge: desktopOnly,
    cancelBridgePairing: desktopOnly,
    selectBridgeProject: desktopOnly,
    runBridgeAction: desktopOnly,
    prepareDeveloperAiPreview: desktopOnly,
    pairControlCenter: desktopOnly,
    disconnectControlCenter: desktopOnly,
    approveAiPreview: desktopOnly,
    askAi: desktopOnly,
    requestVaultUnlock: desktopOnly,
    unlockVaultWithHello: desktopOnly,
    enableVaultHello: desktopOnly,
    disableVaultHello: desktopOnly,
    requestVaultPairing: desktopOnly,
    lockVault: desktopOnly,
    syncVaultNow: desktopOnly,
    getVaultConflictReview: async () => ({ local: [], cloud: [] }),
    resolveVaultConflict: desktopOnly,
    migrateLegacyVault: desktopOnly,
    cleanupLegacyVault: desktopOnly,
    openVaultEditor: desktopOnly,
    requestSaveFromPage: desktopOnly,
    requestVaultDelete: desktopOnly,
    acknowledgeVaultRecovery: desktopOnly,
    copyPassword: desktopOnly,
    copyTotp: desktopOnly,
    autofill: desktopOnly,
    configureUpdateService: desktopOnly,
    clearUpdateService: desktopOnly,
    openUpdatePage: desktopOnly,
    downloadManagedUpdate: async (version, sha256) => {
      if (!managedUpdate || state.activeWorkspaceId === 'banking') throw new Error('Download the installer using the desktop app.');
      const result = await handlers.checkForUpdates();
      if (result.state !== 'available' || version !== result.latest.version || sha256 !== result.latest.sha256) throw new Error('Check for updates again.');
      const { sizeBytes } = result.latest;
      const pending: ManagedUpdateStatus = { phase: 'downloading', version, receivedBytes: sizeBytes / 2, totalBytes: sizeBytes };
      managedUpdate = pending;
      publish();
      window.setTimeout(() => {
        if (managedUpdate !== pending) return;
        managedUpdate = { phase: 'ready', version, publisher: { state: 'unsigned' } };
        publish();
      }, 500);
    },
    cancelManagedUpdate: async () => {
      if (!managedUpdate || state.activeWorkspaceId === 'banking') throw new Error('Cancel the download using the desktop app.');
      managedUpdate = { phase: 'failed', failure: 'cancelled', message: 'Download cancelled.' };
      publish();
    },
    installManagedUpdate: async () => {
      if (managedUpdate?.phase !== 'ready' || state.activeWorkspaceId === 'banking') throw new Error('Install a verified file using the desktop app.');
      managedUpdate = { phase: 'launched', version: managedUpdate.version };
      publish();
    },
    getState: async () => chromeSnapshot(),
    controlDownload: async (id, action) => {
      const entry = sampleDownloads.find((item) => item.id === id && item.accountSpaceId === state.activeAccountSpaceId);
      if (!entry?.canCancel || state.activeWorkspaceId === 'banking') throw new Error('Download is unavailable in this Account Space');
      if (action === 'pause' && entry.canPause) Object.assign(entry, { paused: true, canPause: false, canResume: true });
      else if (action === 'resume' && entry.paused && entry.canResume || action === 'retry' && entry.state === 'interrupted' && entry.canResume) {
        Object.assign(entry, { state: 'progressing', paused: false, canPause: true, canResume: false });
      } else if (action === 'cancel') Object.assign(entry, { state: 'cancelled', paused: false, canCancel: false, canPause: false, canResume: false });
      else throw new Error('This download cannot be paused or resumed right now.');
      publish();
    },
    getSitePermissions: async (id, origin) => {
      const tab = state.tabs.find((item) => item.id === id && item.id === state.activeTabId);
      if (!tab || tab.isHome || new URL(tab.url).origin !== origin) throw new Error('The page changed. Open site information again.');
      return (['download', 'camera', 'notifications'] as const).map((capability): SitePermissionStatus => {
        const grant = tab.accountSpaceId === google && sampleGrants.find((item) => item.origin === origin && item.capability === capability);
        if (state.activeWorkspaceId === 'banking' || capability === 'camera') return { capability, decision: 'blocked' };
        return grant ? { capability, decision: 'allowed', duration: grant.duration } : { capability, decision: 'ask' };
      });
    },
    revokeSitePermission: async (id, origin, capability) => {
      await handlers.getSitePermissions(id, origin);
      if (state.activeWorkspaceId === 'banking' || state.activeAccountSpaceId !== google) throw new Error('Permission changes are unavailable in this Account Space.');
      sampleGrants = sampleGrants.filter((item) => item.origin !== origin || item.capability !== capability);
      return handlers.getSitePermissions(id, origin);
    },
    listAccountPermissionGrants: async (id) => state.activeWorkspaceId === 'personal' && id === google
      && !state.accountSpaces.find((item) => item.id === id)?.locked ? structuredClone(sampleGrants) : [],
    saveRoutine: async (input) => {
      const routine = requireBrowserRoutine(input);
      if (state.activeWorkspaceId === 'banking' || routine.links.some((link) => !state.accountSpaces.some((account) => account.id === link.accountSpaceId && account.workspaceId !== 'banking'))) {
        throw new Error('Choose a regular Account Space for each link');
      }
      const index = routines.findIndex((item) => item.id === routine.id);
      if (index === -1) routines.push(routine);
      else routines[index] = routine;
      publish();
    },
    saveTabSet: async (value) => {
      const input = value as TabSetInput;
      if (state.activeWorkspaceId === 'banking' || input.accountSpaceId !== state.activeAccountSpaceId
        || !state.accountSpaces.some((account) => account.id === input.accountSpaceId && !account.locked)) {
        throw new Error('Return to the original regular Account Space to save the tabs.');
      }
      const tabs = resolveTabSet(state.tabs, input);
      if (input.kind === 'routine') {
        await handlers.saveRoutine({
          id: crypto.randomUUID(), name: input.name, checklist: [],
          links: tabs.map(({ accountSpaceId, url }) => ({ accountSpaceId, url })),
          focusIndex: Math.max(0, tabs.findIndex((tab) => tab.id === state.activeTabId)),
        });
        return tabs.length;
      }
      const added = appendTabSetBookmarks(state.bookmarks, tabs, input);
      state.bookmarks.push(...added);
      if (added.length) publish();
      return added.length;
    },
    openReferenceSearch: async (value) => {
      const input = value as ReferenceSearchInput;
      if (state.activeWorkspaceId === 'banking' || input?.accountSpaceId !== state.activeAccountSpaceId
        || !state.accountSpaces.some((account) => account.id === input.accountSpaceId && !account.locked)) {
        throw new Error('Return to the original regular Account Space to open the reference.');
      }
      const url = referenceSearchUrl(state.settings, input.keyword, input.reference);
      if (!url || url !== input.reviewedUrl) throw new Error('Review the current search address before opening it.');
      await handlers.newTab();
      await handlers.navigate(url);
    },
    deleteRoutine: async (id) => { routines = routines.filter((routine) => routine.id !== id); publish(); },
    markRoutineChecklist: async (id, index, done) => {
      const item = routines.find((routine) => routine.id === id)?.checklist[Number(index)];
      if (!item) return;
      item.done = done === true;
      if (item.done) item.completedAt = new Date().toISOString();
      publish();
    },
    resetRoutineChecklist: async (id) => {
      for (const item of routines.find((routine) => routine.id === id)?.checklist ?? []) item.done = false;
      publish();
    },
    runRoutine: async (id) => {
      const routine = routines.find((item) => item.id === id);
      if (state.activeWorkspaceId === 'banking' || !routine) throw new Error('Routine is unavailable');
      let reused = 0;
      let opened = 0;
      let focus: BrowserTab | undefined;
      const skipped: number[] = [];
      for (const [index, link] of routine.links.entries()) {
        const account = state.accountSpaces.find((candidate) => candidate.id === link.accountSpaceId);
        if (!account || account.locked || account.workspaceId === 'banking') { skipped.push(index); continue; }
        let tab = state.tabs.find((item) => item.accountSpaceId === link.accountSpaceId && !item.isHome && canonicalRoutineUrl(item.url) === link.url);
        if (tab) reused += 1;
        else {
          tab = pageTab(crypto.randomUUID(), account.id, new URL(link.url).hostname, link.url, { workspaceId: account.workspaceId });
          state.tabs.push(tab);
          opened += 1;
        }
        if (index === routine.focusIndex && !tab.restorePaused && !tab.problem) focus = tab;
      }
      if (focus) {
        state.activeTabId = focus.id;
        state.activeWorkspaceId = focus.workspaceId;
        state.activeAccountSpaceId = focus.accountSpaceId;
      }
      publish();
      return { opened, reused, skipped, focusUnavailable: !focus };
    },
    reload: async () => { Object.assign(activeTab(), { problem: undefined, restorePaused: undefined }); publish(); },
    restoreSelectedTabs: async (value) => {
      const ids = new Set(value as string[]);
      for (const tab of state.tabs) {
        if (tab.accountSpaceId === state.activeAccountSpaceId && !tab.isHome) tab.restorePaused = !ids.has(tab.id);
      }
      state.startupTabRecovery = undefined;
      const first = state.tabs.find((tab) => ids.has(tab.id) && tab.accountSpaceId === state.activeAccountSpaceId);
      if (first) state.activeTabId = first.id;
      else await handlers.newTab();
      publish();
    },
    reviewBrowsingData: async (value) => {
      const input = requireBrowsingDataInput(value);
      if (!state.accountSpaces.some((account) => account.id === input.accountSpaceId && account.workspaceId === state.activeWorkspaceId && !account.locked)) {
        throw new Error('Unlock this Account Space to manage its browsing data.');
      }
      const visits = browsingDataVisitIds(state.history, input, Date.now());
      const review: BrowsingDataReview = { id: crypto.randomUUID(), accountSpaceId: input.accountSpaceId, range: input.range,
        siteOrigin: input.siteOrigin, historyCount: visits.size, websiteData: input.websiteData, cache: input.cache };
      clearDataReview = { review, visits, initiator: state.activeAccountSpaceId };
      return review;
    },
    deleteReviewedBrowsingData: async (id) => {
      const pending = clearDataReview;
      if (!pending || pending.review.id !== id || pending.initiator !== state.activeAccountSpaceId) {
        throw new Error('Review the browsing data again before deleting.');
      }
      clearDataReview = undefined;
      const count = state.history.length;
      state.history = state.history.filter((item) => item.accountSpaceId !== pending.review.accountSpaceId || !pending.visits.has(item.id));
      publish();
      return count - state.history.length;
    },
    deleteHistoryVisit: async (id, visitId) => {
      if (id !== state.activeAccountSpaceId) throw new Error('Return to the Account Space that owns this visit.');
      state.history = state.history.filter((item) => item.accountSpaceId !== id || item.id !== visitId);
      publish();
    },
    queryHistory: (async (id: unknown, input: unknown) => {
      const scope = state.activeWorkspaceId === 'banking' || state.activeAccountSpaceId !== id ? [] : state.history;
      return queryHistory(scope, state.activeAccountSpaceId, input as Parameters<PrivateBrowserApi['queryHistory']>[1]);
    }) satisfies PrivateBrowserApi['queryHistory'],
    onState: (callback) => { listeners.add(callback as (snapshot: BrowserSnapshot) => void); return () => listeners.delete(callback as (snapshot: BrowserSnapshot) => void); },
    onDownloadProgress: () => () => undefined,
    onCommand: () => () => undefined,
    onFindResult: () => () => undefined,
    onUpdateAvailable: () => () => undefined,
    onGoogleOperationProgress: () => () => undefined,
    getGoogleConnectionHealth: async (id) => {
      const selected = state.accountSpaces.find((account) => account.id === id && account.workspaceId === state.activeWorkspaceId);
      if (!selected || selected.locked || selected.workspaceId === 'banking') return { state: 'unavailable' };
      const sample = params.get('googleHealth');
      if (id === google && sample === 'quota') return { state: 'quota', lastSuccessAt: '2026-11-21T12:00:00Z', retryAt: '2026-11-21T14:00:00Z' };
      if (id === google && sample === 'reconnect') return { state: 'reconnect', lastSuccessAt: '2026-11-21T12:00:00Z' };
      return { state: selected.googleConnection === 'connected' ? 'ready' : 'disconnected' };
    },
    onVaultState: () => () => undefined,
    // Recorded on the document so browser tests can compare it with the visible chrome.
    setLayout: async (layout) => {
      document.documentElement.dataset.previewLayout = JSON.stringify(layout);
      splitInsets = layout.left + layout.right;
      if (state.splitView && state.splitView.suspended !== splitSuspended()) publish();
    },
    setOverlayOpen: async () => undefined,
    // A normal browser has no native view to place; record the slot for browser tests instead.
    setSideAppBounds: async (_id, rect) => { document.documentElement.dataset.previewSideApp = JSON.stringify(rect); },
    sideAppCommand: async () => undefined,
    openDownload: async () => { throw new Error('This preview cannot open files. Use the desktop Downloads panel.'); },
    showDownload: async () => { throw new Error('This preview cannot open folders. Use the desktop Downloads panel.'); },
    setDownloadHistory: async (id, enabled) => {
      if (id !== state.activeAccountSpaceId || state.activeWorkspaceId === 'banking') throw new Error('Download history is unavailable in this Account Space');
      if (enabled) savedDownloadHistory.add(id);
      else savedDownloadHistory.delete(id);
      publish();
    },
    chooseDownloadFolder: async (id) => {
      if (id !== state.activeAccountSpaceId || state.activeWorkspaceId === 'banking') throw new Error('Download folders are unavailable in this Account Space.');
      if (params.get('downloadFolder') !== 'sample') throw new Error('Choose a real download folder in the desktop app.');
      previewDownloadFolders.set(id, { name: 'Sample invoices', ask: previewDownloadFolders.get(id)?.ask ?? true });
      publish();
    },
    setDownloadFolderMode: async (id, mode) => {
      if (id !== state.activeAccountSpaceId || state.activeWorkspaceId === 'banking') throw new Error('Download folders are unavailable in this Account Space.');
      if (mode === 'default') previewDownloadFolders.delete(id);
      else {
        const selected = previewDownloadFolders.get(id);
        if (!selected) throw new Error('Choose a download folder first.');
        previewDownloadFolders.set(id, { ...selected, ask: mode === 'ask' });
      }
      publish();
    },
    removeDownloadEntry: async (id, downloadId) => {
      const index = sampleDownloads.findIndex((item) => item.id === downloadId && item.accountSpaceId === id
        && !item.canCancel && item.state !== 'progressing' && item.checksum !== 'checking');
      if (id !== state.activeAccountSpaceId || state.activeWorkspaceId === 'banking' || index < 0) throw new Error('Download is unavailable in this Account Space');
      sampleDownloads.splice(index, 1);
      publish();
    },
    clearSideAppData: async () => undefined,
    respondToPermissionPrompt: async (_id, decision) => { document.documentElement.dataset.previewPermission = String(decision); state.pendingPermission = undefined; publish(); },
    freezeContent: async () => null,
    toggleFullscreen: async () => { state.windowState.fullscreen = !state.windowState.fullscreen; publish(); },
    // Same rules as the main process: validated patch, Home address normalized, Banking Home is the New Tab page.
    setBrowserSettings: async (value, workspace) => {
      const patch = requireBrowserSettingsPatch(value);
      if (patch.spellcheck?.languages.some((language) => !state.availableSpellcheckLanguages.includes(language))) {
        throw new Error('A selected spellcheck dictionary is unavailable on this device.');
      }
      const active = state.activeWorkspaceId;
      if (workspace !== undefined && workspace !== active) throw new Error('The workspace changed. Reopen its settings.');
      if (active === 'banking' && patch.assistantPrompts) throw new Error('Assistant presets are unavailable in this workspace.');
      if (active === 'banking' && (patch.homePage !== undefined || patch.homePageUrl !== undefined
        || patch.startup !== undefined || patch.startupPages !== undefined || patch.siteKeywords !== undefined)) {
        throw new Error('Home, startup pages and site keywords are unavailable in Banking.');
      }
      if (patch.homePageUrl !== undefined) {
        const url = parseWebAddress(patch.homePageUrl);
        if (!url) throw new Error('Enter a web address, for example tenten.ma');
        patch.homePageUrl = url;
      }
      workspaceSettings[active] = mergeBrowserSettings(state.settings, patch);
      publish();
    },
    goHome: async () => {
      const protectedWorkspace = WORKSPACES.find((item) => item.id === activeTab().workspaceId)?.protected ?? false;
      await handlers.navigate(resolveHomeUrl(state.settings, protectedWorkspace));
    },
    zoom: async (direction) => {
      const tab = activeTab();
      if (tab.isHome) return;
      if (direction !== 'in' && direction !== 'out' && direction !== 'reset') throw new Error('Invalid zoom direction');
      const key = siteZoomKey(tab.accountSpaceId, tab.url);
      const percent = nextZoomPercent(tab.zoomPercent ?? 100, direction);
      if (percent === 100) siteZoom.delete(key);
      else siteZoom.set(key, percent);
      for (const item of state.tabs) {
        if (!item.isHome && siteZoomKey(item.accountSpaceId, item.url) === key) item.zoomPercent = percent;
      }
      publish();
    },
    setUiPreferences: async (patch, expectedAccount) => {
      if (expectedAccount !== undefined && expectedAccount !== state.activeAccountSpaceId) throw new Error('The Account Space changed. Open the tool again.');
      const { sidePanelTool, ...globalPreferences } = patch as UiPreferencesPatch;
      state.ui = mergeUiPreferences(state.ui, globalPreferences);
      if (isPinnablePanelTool(sidePanelTool)) {
        if (!isPinnablePanelTool(commonPanelTool)) commonPanelTool = 'assistant';
        previewPanelTools.set(state.activeAccountSpaceId, sidePanelTool);
      } else if (sidePanelTool) commonPanelTool = sidePanelTool;
      syncDarkMode();
      publish();
    },
    setSidePanelPin: async (id, tool, enabled) => {
      if (id !== state.activeAccountSpaceId || !regularPanelAccount()) throw new Error('Tool pins are unavailable in this Account Space.');
      const pins = previewPanelPins.get(id) ?? new Set<PinnablePanelTool>();
      if (enabled) pins.add(tool);
      else pins.delete(tool);
      previewPanelPins.set(id, pins);
      publish();
    },
    toggleBookmarkBar: async () => { state.ui = mergeUiPreferences(state.ui, { bookmarkBarMode: state.ui.bookmarkBarMode === 'hidden' ? 'always' : 'hidden' }); publish(); },
    activateTab: async (value) => { const tab = state.tabs.find((item) => item.id === value); if (tab) { tab.sleeping = undefined; state.activeTabId = tab.id; publish(); } },
    setSplitView: async (otherTabId) => {
      const id = state.activeAccountSpaceId;
      if (otherTabId === undefined) splitPairs.delete(id);
      else {
        const active = activeTab();
        const other = state.tabs.find((tab) => tab.id === otherTabId && tab.accountSpaceId === id);
        if (!regularPanelAccount() || !other || other === active || !splitPageAllowed(active) || !splitPageAllowed(other)
          || active.developerToolsOpen || other.developerToolsOpen) throw new Error('Choose two regular pages in this Account Space.');
        if (splitSuspended()) throw new Error('Widen the browser to open two pages side by side.');
        splitPairs.set(id, { leftTabId: active.id, rightTabId: other.id });
      }
      publish();
    },
    newTab: async () => { const id = `preview-${crypto.randomUUID()}`; state.tabs.push(homeTab(id, state.activeWorkspaceId, state.activeAccountSpaceId)); state.activeTabId = id; publish(); },
    openTemporaryBrowsing: desktopOnly,
    closeTab: async (value) => {
      const tab = state.tabs.find((item) => item.id === value);
      if (!tab) return;
      if (!tab.isHome && tab.workspaceId !== 'banking') {
        const closed = { id: tab.id, title: tab.title, url: tab.url, closedAt: new Date().toISOString() };
        closedByAccount.set(tab.accountSpaceId, [closed, ...(closedByAccount.get(tab.accountSpaceId) ?? [])].slice(0, 25));
      }
      const siblings = state.tabs.filter((item) => item.accountSpaceId === tab.accountSpaceId);
      if (siblings.length === 1) { Object.assign(tab, homeTab(tab.id, tab.workspaceId, tab.accountSpaceId)); publish(); return; }
      const index = siblings.indexOf(tab);
      state.tabs = state.tabs.filter((item) => item.id !== tab.id);
      if (state.activeTabId === tab.id) state.activeTabId = siblings[index + 1]?.id ?? siblings[index - 1].id;
      publish();
    },
    reopenClosedTab: async () => reopenPreviewTab(),
    reopenRecentTab: async (id) => reopenPreviewTab(String(id)),
    moveTab: async (idValue, indexValue) => {
      const owned = state.tabs.filter((tab) => tab.accountSpaceId === state.activeAccountSpaceId);
      const tab = owned.find((item) => item.id === idValue);
      if (!tab) return;
      const reordered = moveTabWithinAccountSpace(state.tabs, tab.id, keepTabBlockIndex(owned, tab, Number(indexValue)));
      state.tabs = replaceAccountTabOrder(reordered, tab.accountSpaceId, orderAccountTabs(reordered.filter((item) => item.accountSpaceId === tab.accountSpaceId)));
      publish();
    },
    organizeTab: async (value) => {
      const id = state.activeAccountSpaceId;
      const result = organizeTabs(state.tabs.filter((tab) => tab.accountSpaceId === id), groupsByAccount.get(id) ?? [], value as TabOrganizationAction, crypto.randomUUID());
      state.tabs = replaceAccountTabOrder(state.tabs, id, result.tabs);
      groupsByAccount.set(id, result.groups);
      publish();
    },
    duplicateTab: async (value) => {
      const tab = state.tabs.find((item) => item.id === value && item.accountSpaceId === state.activeAccountSpaceId);
      if (!tab) return;
      const id = crypto.randomUUID();
      state.tabs.push({ ...tab, id, pinned: undefined, groupId: undefined });
      state.activeTabId = id;
      publish();
    },
    closeTabBatch: async (value, scopeValue, confirmedValue) => {
      const accountId = state.activeAccountSpaceId;
      const owned = state.tabs.filter((tab) => tab.accountSpaceId === accountId);
      const entries = tabBatchTargets(owned, String(value), scopeValue as TabBatchScope);
      const confirmed = confirmedValue as string[];
      if (!entries.length || confirmed.length !== entries.length || entries.some((tab, index) => tab.id !== confirmed[index])) throw new Error('The tab selection changed');
      const groups = (groupsByAccount.get(accountId) ?? []).filter((group) => entries.some((tab) => tab.groupId === group.id));
      batchesByAccount.set(accountId, { entries, groups, groupName: scopeValue === 'group' ? groups[0]?.name : undefined });
      const ids = new Set(confirmed);
      state.tabs = state.tabs.filter((tab) => !ids.has(tab.id));
      if (ids.has(state.activeTabId)) {
        const next = state.tabs.find((tab) => tab.id === value) ?? state.tabs.find((tab) => tab.accountSpaceId === accountId);
        if (next) state.activeTabId = next.id;
        else await handlers.newTab();
      }
      publish();
    },
    undoTabBatch: async () => {
      const accountId = state.activeAccountSpaceId;
      const batch = batchesByAccount.get(accountId);
      if (!batch) return;
      batchesByAccount.delete(accountId);
      const groups = groupsByAccount.get(accountId) ?? [];
      groupsByAccount.set(accountId, [...groups, ...batch.groups.filter((group) => !groups.some((item) => item.id === group.id))]);
      state.tabs.push(...batch.entries);
      state.tabs = replaceAccountTabOrder(state.tabs, accountId, orderAccountTabs(state.tabs.filter((tab) => tab.accountSpaceId === accountId)));
      publish();
    },
    navigate: async (value) => {
      const text = String(value);
      const tab = activeTab();
      if (text === 'private://home') Object.assign(tab, { url: text, title: 'New tab', isHome: true, developerToolsAllowed: false });
      else {
        const url = resolveWorkspaceNavigation(text, state.settings, state.activeWorkspaceId === 'banking');
        Object.assign(tab, { url, title: new URL(url).hostname, isHome: false, zoomPercent: siteZoom.get(siteZoomKey(tab.accountSpaceId, url)) ?? 100, securityWarning: url.startsWith('http:') ? 'insecure' : undefined, developerToolsAllowed: canUseDeveloperTools(tab.workspaceId, false, url) });
      }
      publish();
    },
    addressMatches: async (id, text) => {
      if (id !== state.activeAccountSpaceId || state.accountSpaces.some((item) => item.id === id && item.locked)) return [];
      return findAddressMatches(String(text), state.activeAccountSpaceId, state.tabs, state.bookmarks, state.activeWorkspaceId === 'banking' ? [] : state.history);
    },
    openAddressMatch: async (accountId, source, id) => {
      if (accountId !== state.activeAccountSpaceId || state.accountSpaces.some((item) => item.id === accountId && item.locked)) throw new Error('This address result is no longer available');
      const entries = source === 'tab' ? state.tabs : source === 'bookmark' ? state.bookmarks : source === 'history' && state.activeWorkspaceId !== 'banking' ? state.history : [];
      const entry = entries.find((item) => item.id === id && item.accountSpaceId === accountId);
      if (!entry) throw new Error('This address result is no longer available');
      await (source === 'tab' ? handlers.activateTab(entry.id) : handlers.navigate(entry.url));
    },
    openBookmark: async (value) => { const item = state.bookmarks.find((entry) => entry.id === value); if (item) { const id = `preview-${crypto.randomUUID()}`; state.tabs.push(pageTab(id, state.activeAccountSpaceId, item.title, item.url)); state.activeTabId = id; publish(); } },
    openBookmarksInBackground: (async (account: unknown, ids: unknown) => {
      const activeAccount = state.activeAccountSpaceId;
      if (activeAccount !== account || state.accountSpaces.find((item) => item.id === activeAccount)?.locked) {
        throw new Error('The Account Space changed. Reopen the bookmark preview.');
      }
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error('Invalid bookmark selection');
      const { pending, reused, skipped } = planBookmarkBatch(
        state.bookmarks.filter((item) => item.accountSpaceId === activeAccount), state.tabs.filter((tab) => tab.accountSpaceId === activeAccount), ids,
      );
      state.tabs.push(...pending.map(({ bookmark }) => pageTab(crypto.randomUUID(), activeAccount, bookmark.title, bookmark.url)));
      publish();
      return { opened: pending.length, reused, skipped };
    }) satisfies PrivateBrowserApi['openBookmarksInBackground'],
    toggleBookmark: async () => {
      const tab = activeTab();
      if (tab.isHome) return;
      const existing = state.bookmarks.find((item) => item.url === tab.url && item.accountSpaceId === tab.accountSpaceId);
      state.bookmarks = existing ? state.bookmarks.filter((item) => item !== existing) : [...state.bookmarks, { id: crypto.randomUUID(), workspaceId: tab.workspaceId, accountSpaceId: tab.accountSpaceId, title: tab.title, url: tab.url, createdAt: new Date().toISOString(), location: 'bar', folderPath: [], order: 99, orderPath: [99] }];
      publish();
    },
    saveBookmarkToFolder: async (id, tabId, url, folder) => {
      const tab = activeTab();
      if (id !== state.activeAccountSpaceId || tab.id !== tabId || tab.url !== url || tab.isHome) throw new Error('The page changed');
      const owned = state.bookmarks.filter((item) => item.accountSpaceId === id);
      const existing = owned.find((item) => item.url === url);
      if (existing) {
        await handlers.changeBookmarks(id, [existing.id], folder);
        return;
      }
      const orderPath = nextBookmarkOrder(owned, getPreviewFolders(id), folder);
      state.bookmarks.push({ id: crypto.randomUUID(), workspaceId: tab.workspaceId, accountSpaceId: id, title: tab.title, url,
        location: folder.location, folderPath: [...folder.path], order: orderPath[0], orderPath, createdAt: new Date().toISOString() });
      publish();
    },
    moveBookmark: async (level, key, index) => {
      const id = state.activeAccountSpaceId;
      const result = reorderBookmarkLevel(state.bookmarks, getPreviewFolders(id), id, level, key, index);
      state.bookmarks = result.bookmarks;
      savedBookmarkFolders.set(id, result.folders);
      publish();
    },
    renameBookmark: async (idValue, titleValue) => { state.bookmarks = renameBookmark(state.bookmarks, String(idValue), String(titleValue)); publish(); },
    removeBookmark: async (idValue) => { state.bookmarks = removeBookmark(state.bookmarks, String(idValue)); publish(); },
    editBookmarkAddress: async (idValue, address) => {
      const id = String(idValue);
      if (!state.bookmarks.some((item) => item.id === id && item.accountSpaceId === state.activeAccountSpaceId)) throw new Error('Bookmark is unavailable');
      state.bookmarks = editBookmarkAddress(state.bookmarks, id, String(address));
      publish();
    },
    changeBookmarks: async (account, ids, destination) => {
      const current = state.activeAccountSpaceId;
      if (account !== current) throw new Error('The Account Space changed');
      const result = changeBookmarkBatch(state.bookmarks, current, ids as string[], destination as BookmarkLevelInput | undefined, getPreviewFolders(current));
      if (!result.undo) return 0;
      state.bookmarks = result.bookmarks;
      bookmarkUndos.set(current, result.undo);
      publish();
      return result.undo.before.length;
    },
    undoBookmarks: async (account) => {
      const current = state.activeAccountSpaceId;
      if (account !== current) throw new Error('The Account Space changed');
      const undo = bookmarkUndos.get(current);
      if (!undo) return 0;
      const result = restoreBookmarkBatch(state.bookmarks, current, undo);
      state.bookmarks = result.bookmarks;
      bookmarkUndos.delete(current);
      publish();
      return result.restored;
    },
    setShortcutTiles: async (idValue, tilesValue) => { if (tilesValue === null) delete state.shortcutsByAccountSpace[String(idValue)]; else state.shortcutsByAccountSpace[String(idValue)] = tilesValue as ShortcutTile[]; publish(); },
    toggleTrackerBlocking: async () => {
      if (state.activeWorkspaceId === 'banking') throw new Error('Tracker blocking stays on in Banking.');
      trackerBlocking = !trackerBlocking;
      publish();
    },
    setTrackerCompatibility: async (tabId, origin, paused) => {
      if (state.activeWorkspaceId === 'banking' || !state.trackerSite || state.trackerSite.origin !== origin
        || tabId !== state.activeTabId || (paused && !state.trackerSite.canPause)) {
        throw new Error('Tracker compatibility is unavailable on this page.');
      }
      trackers.pause(state.activeAccountSpaceId, origin, paused);
      publish();
    },
    setMemorySaverSite: async (tabId, origin, keepAwake) => {
      if (tabId !== state.activeTabId || state.memorySaverSite?.origin !== origin) throw new Error('The site changed. Open Site information again.');
      const sites = memorySites.get(state.activeAccountSpaceId) ?? new Set<string>();
      if (keepAwake) sites.add(origin);
      else sites.delete(origin);
      memorySites.set(state.activeAccountSpaceId, sites);
      publish();
    },
    switchAccountSpace: async (value) => { const id = value as AccountSpaceId; const selected = state.accountSpaces.find((item) => item.id === id); if (!selected || selected.locked) throw new Error('Account Space is unavailable'); state.activeAccountSpaceId = id; state.activeWorkspaceId = selected.workspaceId; state.activeTabId = state.tabs.find((tab) => tab.accountSpaceId === id)!.id; publish(); },
    switchWorkspace: async (value) => { const workspaceId = value as WorkspaceId; state.activeWorkspaceId = workspaceId; state.activeAccountSpaceId = state.accountSpaces.find((item) => item.workspaceId === workspaceId)!.id; state.activeTabId = state.tabs.find((tab) => tab.accountSpaceId === state.activeAccountSpaceId)!.id; publish(); },
    addLocalAccountSpace: async (workspaceValue, labelValue, colorValue, googleSetupPending) => {
      const id = crypto.randomUUID() as AccountSpaceId;
      const created = account(id, workspaceValue as WorkspaceId, String(labelValue), colorValue as 'indigo');
      state.accountSpaces.push({ ...created, googleSetupPending: googleSetupPending && created.workspaceId !== 'banking' ? true : undefined });
      state.tabs.push(homeTab(`preview-${id}`, created.workspaceId, id));
      state.activeAccountSpaceId = id;
      state.activeTabId = `preview-${id}`;
      publish();
      return id;
    },
    updateAccountSpace: async (idValue, labelValue, colorValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { if (typeof labelValue === 'string') selected.label = labelValue; if (typeof colorValue === 'string') selected.color = colorValue as typeof selected.color; publish(); } },
    reorderAccountSpaces: async (_workspace, orderValue) => { (orderValue as AccountSpaceId[]).forEach((id, order) => { const item = state.accountSpaces.find((candidate) => candidate.id === id); if (item) item.order = order; }); publish(); },
    openInAccountSpace: async (id, url) => {
      if (overviewFixture && id === google && id === state.activeAccountSpaceId) {
        await handlers.newTab();
        await handlers.navigate(url);
      }
    },
    setAccountSpaceLocked: async (idValue, lockedValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.locked = Boolean(lockedValue); selected.googleConnection = selected.locked ? 'locked' : 'disconnected'; publish(); } },
    configureGoogle: async () => { state.googleConfiguration = { configured: true, source: 'encrypted-settings' }; publish(); },
    connectGoogleAccount: async (idValue, modulesValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.kind = 'google'; delete selected.googleSetupPending; selected.email = selected.email ?? 'account@example.com'; selected.googleConnection = 'connected'; selected.enabledModules = [...modulesValue as typeof selected.enabledModules]; publish(); } return { ok: true }; },
    disconnectGoogleAccount: async (idValue, revoke) => {
      const selected = state.accountSpaces.find((item) => item.id === idValue && item.workspaceId === state.activeWorkspaceId);
      if (!selected) throw new Error('Choose an Account Space in the current workspace.');
      document.documentElement.dataset.previewGoogleAccess = revoke ? 'revoke' : 'disconnect';
      selected.googleConnection = 'disconnected';
      selected.enabledModules = [];
      selected.grantedScopes = [];
      publish();
      return { ok: true };
    },
    clearAccountSpaceData: async (id) => {
      const selected = state.accountSpaces.find((item) => item.id === id && item.workspaceId === state.activeWorkspaceId);
      if (!selected) throw new Error('Choose an Account Space in the current workspace.');
      selected.websiteStatus = 'not-visited';
      state.history = state.history.filter((item) => item.accountSpaceId !== selected.id);
      for (const tab of state.tabs.filter((item) => item.accountSpaceId === selected.id)) {
        Object.assign(tab, homeTab(tab.id, selected.workspaceId, selected.id));
      }
      publish();
    },
    createBackupRecoveryCode: async () => `PB1-${'A'.repeat(43)}`,
    verifyAndEnableBackup: async (idValue, _code, includeOpenTabsValue, includeHistoryValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.backupEnabled = true; selected.backupIncludesOpenTabs = Boolean(includeOpenTabsValue); selected.backupIncludesHistory = Boolean(includeHistoryValue); publish(); } },
    uploadBackup: async () => ({ status: 'uploaded', etag: 'preview-etag' }),
    getAiProvider: async () => previewProvider,
    checkAiProvider: async () => {
      requireAssistantPolicy(previewProvider.mode ?? 'local');
      if (!previewProvider.configured) return { state: 'not-configured' };
      if (previewProvider.mode) recordAssistantReceipt(previewProvider.mode, previewProvider.mode === 'local' ? 'http://127.0.0.1:11434' : previewProvider.endpoint!, 'connection-test');
      return { state: params.get('aiCheck') === 'model' ? 'model' : 'ready' };
    },
    prepareAiPreview: (async (scope: unknown) => {
      if (state.activeWorkspaceId === 'banking') throw new Error('AI is unavailable in this workspace');
      if (params.get('localAi') !== 'sample') throw new Error('A sample reading page is unavailable.');
      assistantReview = undefined;
      assistantExtraSources.clear();
      assistantPage = {
        id: crypto.randomUUID(), accountSpaceId: state.activeAccountSpaceId, tabId: state.activeTabId,
        service: 'browser', sourceRevision: 'preview-ai-page', sourceUrl: 'https://example.test/article',
        title: 'Sample catalogue', url: 'https://example.test', redactions: 0, protectedPage: false,
        text: scope === 'selection' ? 'A brass kettle sits on the shelf.' : 'The café stocks ceramic mugs. A brass kettle sits on the shelf. الشاي متوفر اليوم.',
      };
      return assistantPage;
    }) satisfies PrivateBrowserApi['prepareAiPreview'],
    prepareAssistantSource: async (id, tabId) => {
      requireAssistantPolicy('local');
      const tab = state.tabs.find((item) => item.id === tabId && item.accountSpaceId === state.activeAccountSpaceId && !item.isHome);
      if (!tab || state.activeTabId === tab.id || assistantPage?.id !== id) throw new Error('Choose another open webpage in this Account Space.');
      const source: AssistantSelectionSource = {
        id: crypto.randomUUID(), tabId: tab.id, title: tab.title, url: new URL(tab.url).origin,
        text: 'The additional catalogue lists a ceramic mug.', redactions: 0,
      };
      assistantExtraSources.set(source.id, source);
      return source;
    },
    reviewAssistantRequest: async (id, context, questionValue, withEvidence, edits) => {
      if (!assistantPage || assistantPage.id !== id || assistantPage.accountSpaceId !== state.activeAccountSpaceId || assistantPage.tabId !== state.activeTabId) {
        throw new Error('Read the page again before reviewing the request.');
      }
      if (!previewProvider.configured || !previewProvider.mode || !previewProvider.model) throw new Error('Configure an AI provider first.');
      requireAssistantPolicy(previewProvider.mode);
      const text = redactSensitiveText(String(context));
      const additional = ((edits ?? []) as AssistantSelectionEdit[]).map((edit) => {
        const source = assistantExtraSources.get(edit.id);
        if (!source) throw new Error('Read the added source again.');
        const excerpt = redactSensitiveText(edit.text);
        return { ...source, text: excerpt.text, redactions: excerpt.redactions };
      });
      const includeCurrent = !additional.length || Boolean(text.text.trim());
      const excerpts = [...(includeCurrent ? [{ ...assistantPage, text: text.text, redactions: text.redactions }] : []), ...additional];
      if (excerpts.reduce((total, excerpt) => total + excerpt.text.length, 0) > MAX_ASSISTANT_CONTEXT) {
        throw new Error('Reduce the combined excerpts to 12,000 characters.');
      }
      const question = redactSensitiveText(String(questionValue).trim());
      const parent = additional.length ? { title: 'Reviewed webpages', url: 'See source origins below' } : assistantPage;
      const data: AiRequestReview = {
        id: crypto.randomUUID(), mode: previewProvider.mode, model: previewProvider.model,
        destination: previewProvider.mode === 'local' ? 'http://127.0.0.1:11434/api/chat' : `${previewProvider.endpoint}/chat/completions`,
        systemPrompt: AI_SYSTEM_PROMPT, userPrompt: aiUserPrompt({ ...parent, text: formatAssistantExcerpts(excerpts, additional.length > 0) }, assistantQuestion(question.text, withEvidence === true)),
        redactions: excerpts.reduce((total, source) => total + source.redactions, question.redactions),
      };
      assistantReview = { data, context: excerpts.map((source) => source.text), withEvidence: withEvidence === true };
      return data;
    },
    sendReviewedAssistant: async (id) => {
      if (!assistantPage || assistantPage.accountSpaceId !== state.activeAccountSpaceId || assistantPage.tabId !== state.activeTabId
        || !assistantReview || assistantReview.data.id !== id) throw new Error('Review the request before sending it.');
      const { data, context, withEvidence } = assistantReview;
      assistantReview = undefined;
      requireAssistantPolicy(data.mode);
      recordAssistantReceipt(data.mode, data.destination, 'page-request');
      if (params.get('aiRequest') === 'timeout-once' && !timeoutFixtureUsed) {
        timeoutFixtureUsed = true;
        return { kind: 'timeout' };
      }
      if (params.get('aiRequest') === 'waiting') {
        return new Promise<AssistantAnswer>((finish) => { previewRequest = { id: data.id, finish }; });
      }
      assistantPage = undefined;
      assistantExtraSources.clear();
      const answer = 'The sample shows a brass kettle on the shelf.';
      const fixture = withEvidence ? JSON.stringify({ findings: [{
        claim: answer, quote: params.get('aiSources') === 'unverified' ? 'This passage does not occur in the sample.' : 'A brass kettle sits on the shelf.',
      }] }) : answer;
      return readAssistantAnswer(fixture, withEvidence, context);
    },
    cancelReviewedAssistant: async (id) => {
      if (previewRequest && previewRequest.id === id) {
        previewRequest.finish({ kind: 'cancelled' });
        previewRequest = undefined;
      }
    },
    setAssistantCloudAllowed: async (id, allowed) => {
      if (id !== state.activeAccountSpaceId) throw new Error('The Account Space changed.');
      requireAssistantPolicy('local');
      if (allowed) disabledCloudAccounts.delete(state.activeAccountSpaceId);
      else {
        disabledCloudAccounts.add(state.activeAccountSpaceId);
        if (assistantReview?.data.mode === 'cloud') assistantReview = undefined;
      }
      publish();
    },
    prepareClaudeExcerpt: async () => {
      const tab = state.tabs.find(({ id }) => id === state.activeTabId);
      if (!tab || tab.isHome || state.activeWorkspaceId === 'banking' || params.get('claudeExcerpt') !== 'sample') {
        throw new Error('Select visible page text, then try again.');
      }
      claudeExcerpt = { id: crypto.randomUUID(), url: new URL(tab.url).origin,
        ...redactSensitiveText('Selected catalogue paragraph. token=demo-value') };
      return claudeExcerpt;
    },
    cancelClaudeExcerpt: async (id) => { if (claudeExcerpt?.id === id) claudeExcerpt = undefined; },
    copyClaudeExcerpt: async (id) => {
      if (claudeExcerpt?.id !== id) throw new Error('Review the selection again before copying.');
      document.documentElement.dataset.previewClaudeCopy = claudeExcerpt.text;
      claudeExcerpt = undefined;
    },
    revokeAiContext: async () => {
      claudeExcerpt = undefined;
      assistantReview = undefined;
      assistantPage = undefined;
      assistantExtraSources.clear();
      previewRequest?.finish({ kind: 'cancelled' });
      previewRequest = undefined;
    },
    getLocalAiModels: async () => {
      if (state.activeWorkspaceId === 'banking') throw new Error('AI is unavailable in this workspace');
      return params.get('localAi') === 'sample'
        ? { state: 'ready', models: ['preview-small:latest', 'preview-large:latest'] } : { state: 'unavailable', models: [] };
    },
    configureAiProvider: async (input) => {
      const provider = input as AiProviderInput;
      previewProvider = 'mode' in provider ? { configured: true, mode: 'local', model: provider.model }
        : { configured: true, mode: 'cloud', model: provider.model, endpoint: provider.endpoint };
      return previewProvider;
    },
    clearAiProvider: async () => { previewProvider = { configured: false }; return previewProvider; },
    copyText: async (value) => navigator.clipboard.writeText(String(value)),
    importBookmarkHtml: (async (id: unknown) => {
      const accountSpaceId = state.activeAccountSpaceId;
      if (state.activeWorkspaceId === 'banking' || id !== accountSpaceId
        || !state.accountSpaces.some((item) => item.id === accountSpaceId && !item.locked)) throw new Error('Choose an unlocked regular Account Space.');
      if (params.get('chrome') !== 'empty') return undefined;
      const itemId = 'sample-html-' + accountSpaceId;
      if (state.bookmarks.some((item) => item.id === itemId)) return { imported: 0, skipped: 2 };
      state.bookmarks.push({
        id: itemId, accountSpaceId, workspaceId: state.activeWorkspaceId, title: 'Sample HTML bookmark',
        url: 'https://example.test/html-bookmark', folderPath: ['Imported file'], location: 'other', order: 0, orderPath: [0, 0],
        createdAt: '2026-11-21T12:00:00Z',
      });
      publish();
      return { imported: 1, skipped: 1 };
    }) satisfies PrivateBrowserApi['importBookmarkHtml'],
    listChromeProfiles: (async () => {
      if (params.get('chrome') === 'error') throw new Error('The sample Chrome profiles could not be read');
      if (params.get('chrome') === 'empty') return [];
      const profiles = [{ id: 'Default', name: 'Sample Chrome profile', isDefault: true, hasBookmarks: true, hasHistory: true, hasPreferences: true }];
      if (params.get('chrome') === 'mapping') profiles.push({ id: 'Profile 1', name: 'Research', isDefault: false, hasBookmarks: true, hasHistory: false, hasPreferences: true });
      return profiles.map((profile) => ({
        ...profile,
        suggestedAccountSpaceId: profile.isDefault && state.activeWorkspaceId !== 'banking' ? state.activeAccountSpaceId : undefined,
        imported: importedChromeProfiles.has(profile.id),
        importedInto: importedChromeProfiles.get(profile.id),
      }));
    }) satisfies PrivateBrowserApi['listChromeProfiles'],
    previewChromeImport: (async (value: unknown) => {
      const options = value as ChromeImportOptions;
      const destination = state.accountSpaces.find((item) => item.id === options.accountSpaceId && item.workspaceId === state.activeWorkspaceId);
      if (!destination || destination.locked || destination.workspaceId === 'banking') throw new Error('Choose an available regular Account Space and sample profile');
      if (importedChromeProfiles.has(options.profileId)) throw new Error('This Chrome profile has already been imported.');
      const key = 'preview-import-' + options.profileId + '-' + destination.id;
      const addBookmark = options.bookmarks && !state.bookmarks.some((item) => item.id === key);
      const addHistory = options.history && !state.history.some((item) => item.id === key);
      const skipped = { bookmarks: Number(options.bookmarks && !addBookmark), history: Number(options.history && !addHistory), passwords: 0 };
      const timestamp = '2026-09-12T10:00:00.000Z';
      const id = crypto.randomUUID();
      pendingChromeImport = { id, options, owner: state.activeAccountSpaceId };
      const { patch, appliedSettings } = chromeSettingsFixture(options);
      return {
        id, accountSpaceId: destination.id, settingsPatch: patch,
        result: { imported: { bookmarks: Number(addBookmark), history: Number(addHistory), passwords: 0 }, skipped, warnings: [], appliedSettings },
        duplicates: skipped.bookmarks + skipped.history, unsupported: 0, overLimit: 0,
        folders: addBookmark ? [{ location: 'bar', path: ['Sample folder'], count: 1 }] : [], moreFolders: 0,
        historyRange: addHistory ? { from: timestamp, through: timestamp } : undefined,
      };
    }) satisfies PrivateBrowserApi['previewChromeImport'],
    confirmChromeImport: async (id) => {
      const pending = pendingChromeImport;
      if (!pending || pending.id !== id || pending.owner !== state.activeAccountSpaceId) throw new Error('Preview this Chrome import again.');
      pendingChromeImport = undefined;
      return handlers.importChrome(pending.options);
    },
    discardChromeImport: async (id) => { if (pendingChromeImport?.id === id) pendingChromeImport = undefined; },
    canUndoChromeImport: async (id) => typeof id === 'string' && chromeUndo.has(id as AccountSpaceId),
    undoChromeImport: async (id) => {
      const destination = state.accountSpaces.find((item) => item.id === id && item.workspaceId === state.activeWorkspaceId && item.workspaceId !== 'banking' && !item.locked);
      if (!destination) throw new Error('Choose an available regular Account Space');
      const undo = chromeUndo.get(destination.id);
      const key = 'preview-import-' + undo?.profileId + '-' + destination.id;
      const bookmarks = state.bookmarks.length;
      const history = state.history.length;
      if (undo?.bookmark) state.bookmarks = state.bookmarks.filter((item) => item.id !== key || item.title !== 'Sample imported page');
      if (undo?.history) state.history = state.history.filter((item) => item.id !== key);
      if (undo?.settings) workspaceSettings[destination.workspaceId] = undo.settings;
      if (undo && !state.bookmarks.some((item) => item.id === key) && !state.history.some((item) => item.id === key)) {
        importedChromeProfiles.delete(undo.profileId);
      }
      chromeUndo.delete(destination.id);
      publish();
      return { bookmarks: bookmarks - state.bookmarks.length, history: history - state.history.length, settingsRestored: undo?.settings ? true : undefined };
    },
    importChrome: (async (value: unknown) => {
      const { profileId, accountSpaceId, workspaceId, bookmarks, history } = value as Parameters<PrivateBrowserApi['importChrome']>[0];
      const destination = state.accountSpaces.find((item) => item.id === accountSpaceId && item.workspaceId === workspaceId);
      if (!destination || destination.locked || workspaceId === 'banking') throw new Error('Choose an available regular Account Space');
      if (importedChromeProfiles.has(profileId)) throw new Error('This Chrome profile has already been imported.');
      const url = 'https://example.test/chrome-import';
      const title = 'Sample imported page';
      const timestamp = '2026-09-12T10:00:00.000Z';
      const id = 'preview-import-' + profileId + '-' + accountSpaceId;
      const addBookmark = bookmarks && !state.bookmarks.some((item) => item.id === id);
      const addHistory = history && !state.history.some((item) => item.id === id);
      if (addBookmark) state.bookmarks.push({ id, accountSpaceId, workspaceId, title, url, createdAt: timestamp, location: 'bar', folderPath: ['Sample folder'], order: 500, orderPath: [500, 0] });
      if (addHistory) state.history.push({ id, accountSpaceId, workspaceId, title, url, visitedAt: timestamp });
      const { patch, appliedSettings } = chromeSettingsFixture(value as ChromeImportOptions);
      const before = patch ? settingsForWorkspace({ settings: DEFAULT_BROWSER_SETTINGS, workspaceSettings }, workspaceId) : undefined;
      if (before && patch) workspaceSettings[workspaceId] = mergeBrowserSettings(before, patch);
      if (addBookmark || addHistory || patch) {
        importedChromeProfiles.set(profileId, accountSpaceId);
        chromeUndo.set(accountSpaceId, { profileId, bookmark: addBookmark, history: addHistory, settings: before });
      }
      publish();
      return {
        imported: { bookmarks: Number(addBookmark), history: Number(addHistory), passwords: 0 },
        skipped: { bookmarks: Number(bookmarks && !addBookmark), history: Number(history && !addHistory), passwords: 0 },
        warnings: [],
        appliedSettings,
      };
    }) satisfies PrivateBrowserApi['importChrome'],
    reviewChromePasswords: async () => {
      if (params.get('chromePassword') !== 'sample' || state.activeWorkspaceId === 'banking' || state.activeWorkspaceId === 'development') {
        throw new Error('Password files are unavailable in the synthetic preview');
      }
      const review: ChromePasswordImportReview = {
        id: crypto.randomUUID(), sourceCount: 3, toImport: 1, skipped: { 'already-saved': 1, 'unsupported-site': 1 },
        issues: [{ entry: 2, reason: 'already-saved', origin: 'https://shop.example.test', username: 'sample@example.test' },
          { entry: 3, reason: 'unsupported-site' }],
      };
      passwordReview = { review, accountId: state.activeAccountSpaceId };
      return review;
    },
    importReviewedChromePasswords: async (id) => {
      if (passwordReview?.review.id !== id || passwordReview.accountId !== state.activeAccountSpaceId) throw new Error('Review the password file again before importing.');
      const { review } = passwordReview;
      passwordReview = undefined;
      return { imported: review.toImport, skipped: review.skipped };
    },
    discardChromePasswordReview: async (id) => {
      if (passwordReview?.review.id === id) passwordReview = undefined;
    },
    getBridgeStatus: (async () => ({ state: 'disconnected', browserVersion: 'Preview' })) satisfies PrivateBrowserApi['getBridgeStatus'],
    listBridgeProjects: (async () => []) satisfies PrivateBrowserApi['listBridgeProjects'],
    beginBridgePairing: (async () => {
      throw new Error('VS Code pairing requires the desktop app');
    }) satisfies PrivateBrowserApi['beginBridgePairing'],
    installBridgeExtension: (async () => {
      throw new Error('Extension installation requires the desktop app');
    }) satisfies PrivateBrowserApi['installBridgeExtension'],
    toggleDeveloperTools: (async () => {
      throw new Error('Native DevTools require the desktop app');
    }) satisfies PrivateBrowserApi['toggleDeveloperTools'],
    inspectDeveloperPage: (async () => {
      const tab = activeTab();
      if (!tab.developerToolsAllowed) throw new Error('Page inspection is unavailable for this tab');
      return { route: new URL(tab.url).pathname, framework: 'Synthetic preview', viewport: window.innerWidth + ' x ' + window.innerHeight };
    }) satisfies PrivateBrowserApi['inspectDeveloperPage'],
    getDefaultBrowserStatus: async () => false,
    openDefaultBrowserSettings: (async () => {
      throw new Error('Changing the default browser requires the desktop app');
    }) satisfies PrivateBrowserApi['openDefaultBrowserSettings'],
    testDefaultBrowser: (async () => {
      throw new Error('Testing the Windows default browser requires the desktop app');
    }) satisfies PrivateBrowserApi['testDefaultBrowser'],
    getUpdateService: async () => ({ configured: false, currentVersion: '0.5.7', source: 'public' as const, endpoint: 'https://private-browser-downloads.digitronics-electro.workers.dev' }),
    checkForUpdates: async () => {
      const updateMode = new URLSearchParams(location.search).get('update');
      if (updateMode === 'loading') await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      if (updateMode === 'error') throw new Error('The public update service could not be reached');
      const latestVersion = updateMode === 'available' ? '0.5.8' : '0.5.7';
      return {
        state: updateMode === 'available' ? 'available' as const : 'up-to-date' as const,
        currentVersion: '0.5.7',
        latest: {
          schemaVersion: 1 as const,
          appId: 'private-browser' as const,
          version: latestVersion,
          buildNumber: 83,
          channel: 'stable' as const,
          publishedAt: '2026-09-12T18:20:00.000Z',
          filename: `Private-Browser-${latestVersion}-Setup.exe`,
          sizeBytes: 115_638_545,
          sha256: '259a374e199949d72b7fa87c6aed3eef9834340b99ed5dfd17da68038a922eec',
          commitSha: 'fabad9b310b10efcc7332e88599620db8d437b2a',
          releaseNotes: 'Review release highlights before installing a new browser version.',
          downloadUrl: 'https://private-browser-downloads.digitronics-electro.workers.dev/download/latest.exe?expires=9999999999&signature=preview',
          downloadPageUrl: 'https://private-browser-downloads.digitronics-electro.workers.dev/download?expires=9999999999&signature=preview',
          expiresAt: '2286-11-20T17:46:39.000Z',
        },
        checkedAt: new Date().toISOString(),
      };
    },
    openReleaseHistory: async () => handlers.navigate('https://private-browser-downloads.digitronics-electro.workers.dev/#release-history'),
    listVault: async () => ({ available: true,
      items: params.has('vaultHealth') && !params.has('vaultGuide') ? [vaultHealthFixture] : [],
      lifecycle: params.get('vaultGuide') ? 'locked' : 'unlocked',
      platformUnlock: params.get('vaultGuide') === 'enrolled' ? 'enrolled' : undefined, sync: 'idle', dirty: false, generation: 1 }),
    checkVaultHealth: async (id): Promise<VaultHealthReport> => {
      if (id !== state.activeAccountSpaceId || state.activeWorkspaceId === 'banking' || state.activeWorkspaceId === 'development' || params.has('vaultGuide')) {
        throw new Error('Vault health is unavailable in this Account Space.');
      }
      return params.has('vaultHealth')
        ? { checked: 1, findings: [{ id: vaultHealthFixture.id, issues: ['weak-password'] }] }
        : { checked: 0, findings: [] };
    },
    editVaultHealthLogin: async () => { throw new Error('Open the desktop app to edit a login in a secure window.'); },
    getVaultMigrationStatus: async () => ({ legacyAvailable: false }),
    // The Control Center link, paired, with one task (docs/systems/control-center-link.md).
    getControlCenterStatus: async () => ({ state: 'connected', url: 'http://127.0.0.1:4317', fingerprint: '4F1C 9A2E 77D0 13B8 C6E5 0A94 2D61 F3B7' }),
    listControlCenterRepositories: async () => ({ repositories: [{ id: 'repo-shop', name: 'shop', devOrigin: 'http://127.0.0.1:5173' }, { id: 'repo-site', name: 'site', devOrigin: null }], suggestedId: 'repo-shop' }),
    listControlCenterTasks: async () => [{ id: 'TASK-0042', title: 'The cart page crashes when it is empty', repositoryName: 'shop', status: 'COMPLETED', currentStageName: 'Complete', blocker: null, finalStatus: 'READY', createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:20:00.000Z', dashboardUrl: 'http://127.0.0.1:4317/tasks/TASK-0042' }],
    sendToControlCenter: async () => ({ id: 'TASK-0043', title: 'Preview task', repositoryName: 'shop', status: 'QUEUED', currentStageName: 'Investigate', blocker: null, finalStatus: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dashboardUrl: 'http://127.0.0.1:4317/tasks/TASK-0043' }),
    recheckControlCenterTask: async () => ({ name: 'browser-recheck-1.md', capturedAt: new Date().toISOString(), attachedAt: new Date().toISOString() }),
    inspectVaultFormShape: async () => ({ hasUsername: false, hasPassword: false }),
    copyGeneratedCredential: async () => {
      if (state.activeWorkspaceId === 'banking') throw new Error('Vault clipboard is disabled in this workspace');
      vaultClipboardUntil = Date.now() + 30_000;
    },
    vaultClipboardDeadline: async () => state.activeWorkspaceId === 'banking' ? undefined : vaultClipboardUntil,
    clearVaultClipboard: async () => {
      if (state.activeWorkspaceId === 'banking') throw new Error('Vault clipboard is disabled in this workspace');
      const hadCopy = Boolean(vaultClipboardUntil && vaultClipboardUntil > Date.now());
      vaultClipboardUntil = undefined;
      return hadCopy;
    },
    resetVaultPicks: async (id) => {
      if (id !== state.activeAccountSpaceId || state.activeWorkspaceId === 'banking' || state.activeWorkspaceId === 'development') {
        throw new Error('Remembered picks are unavailable in this Account Space.');
      }
      return true;
    },
    vaultFillReadiness: async () => {
      if (params.has('vaultGuide')) return 'locked';
      if (state.activeWorkspaceId === 'banking') return 'manual';
      const value = params.get('vaultFill');
      return (['connect', 'locked', 'no-match', 'unsupported', 'ready', 'choose-login'] as const)
        .find((candidate) => candidate === value) ?? 'unsupported';
    },
  };
  Object.defineProperty(window, 'privateBrowser', { value: handlers, configurable: true });
  document.documentElement.dataset.browserPreview = 'synthetic';
}
