import type { PrivateBrowserApi } from '../electron/preload.cjs';
import type { ChromeImportOptions } from '../electron/types';
import type { PermissionGrantSummary, SitePermissionStatus } from '../electron/types';
import type { AccountSpaceId, AiProviderInput, AiProviderStatus, Bookmark, BookmarkLevelInput, BrowserSnapshot, BrowserTab, RecentlyClosedTab, ShortcutTile, TabBatchScope, TabGroup, TabOrganizationAction, UiPreferencesPatch, Workspace, WorkspaceId } from '../electron/types';
import { mergeUiPreferences, DEFAULT_UI_PREFERENCES } from '../electron/ui-preferences';
import { DEFAULT_BROWSER_SETTINGS, mergeBrowserSettings, requireBrowserSettingsPatch, resolveHomeUrl, resolveWorkspaceNavigation, settingsForWorkspace } from '../electron/browser-settings';
import type { BrowserSettings } from '../electron/types';
import { parseWebAddress } from '../electron/security';
import { findAddressMatches } from '../electron/address-matches';
import { queryHistory } from '../electron/history-query';
import { planBookmarkBatch } from '../electron/bookmark-batch';
import { changeBookmarkBatch, editBookmarkAddress, restoreBookmarkBatch, type BookmarkUndo } from '../electron/bookmark-maintenance';
import { canonicalRoutineUrl, defaultBrowserRoutines, requireBrowserRoutine } from '../electron/browser-routines';
import { appendTabSetBookmarks, resolveTabSet } from '../electron/tab-sets';
import type { TabSetInput } from '../electron/types';
import { keepTabBlockIndex, orderAccountTabs, organizeTabs, replaceAccountTabOrder, tabBatchTargets } from '../electron/tab-organization';
import { canUseDeveloperTools } from '../electron/developer-tools';
import { moveTabWithinAccountSpace, removeBookmark, renameBookmark, reorderBookmarkEntry } from '../electron/bookmark-tree';
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
  const accounts = [
    account(ids.digitronics, 'digitronics', 'Digitronics', 'indigo'), account(ids.tenten, 'tenten', 'TenTen', 'amber'), account(ids.development, 'development', 'Development', 'violet'),
    account(ids.personal, 'personal', 'Personal', 'emerald'),
    { ...account(ids.google, 'personal', 'Operations', 'sky', 1), kind: 'google' as const, email: 'operations@example.com', displayName: 'Operations Team', googleConnection: 'connected' as const, websiteStatus: 'session-data-present' as const, enabledModules: ['identity', 'gmail-metadata', 'drive-files', 'calendar-read'] as const, grantedScopes: ['openid', 'email', 'profile'] },
    account(ids.banking, 'banking', 'Banking', 'rose'),
  ];
  const google = ids.google as AccountSpaceId;
  const params = new URLSearchParams(location.search);
  const state: BrowserSnapshot = {
    settings: { ...DEFAULT_BROWSER_SETTINGS },
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
    sideApps: ['claude', 'easynote'].map((id) => ({ id: id as 'claude' | 'easynote', name: id === 'claude' ? 'Claude' : 'Notes', status: 'ready', canGoBack: false, canGoForward: false })),
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
  const closedByAccount = new Map<AccountSpaceId, RecentlyClosedTab[]>();
  let routines = defaultBrowserRoutines(Object.fromEntries(accounts.filter((account) => account.id !== google).map((account) => [account.workspaceId, account.id])));
  state.routines = routines;
  const groupsByAccount = new Map<AccountSpaceId, TabGroup[]>();
  const batchesByAccount = new Map<AccountSpaceId, { entries: BrowserTab[]; groups: TabGroup[]; groupName?: string }>();
  const sampleDownloads = state.downloads;
  const workspaceSettings: Partial<Record<WorkspaceId, BrowserSettings>> = {};
  let pendingChromeImport: { id: string; options: ChromeImportOptions; owner: AccountSpaceId } | undefined;
  const chromeUndo = new Map<AccountSpaceId, { bookmark: boolean; history: boolean }>();
  let sampleGrants: PermissionGrantSummary[] = params.get('permissions') === 'sample' ? [
    { origin: 'https://example.test', capability: 'download', duration: 'until-revoked' },
    { origin: 'https://mail.google.com', capability: 'notifications', duration: 'session' },
  ] : [];
  let previewProvider: AiProviderStatus = { configured: false };
  const bookmarkUndos = new Map<AccountSpaceId, BookmarkUndo>();
  const publish = () => {
    state.settings = settingsForWorkspace({ settings: DEFAULT_BROWSER_SETTINGS, workspaceSettings }, state.activeWorkspaceId);
    state.bookmarkBarVisible = state.ui.bookmarkBarMode !== 'hidden';
    state.downloads = sampleDownloads.filter((item) => item.accountSpaceId === state.activeAccountSpaceId);
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
    listeners.forEach((listener) => listener(structuredClone(state)));
  };
  media.addEventListener('change', () => { syncDarkMode(); publish(); });
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
  if (params.get('preview') === 'agent-action') {
    Object.assign(agentState, {
      enabled: true, active: true, selectedTab: agentTabId,
      tabs: [{ id: agentTabId, name: 'http://localhost:3000', client: 'Codex', space: 'Agent Account Space', manual: false }],
      current: { client: 'Codex', step: 'click', tabId: agentTabId },
      pending: { id: '9c7757bc-bf61-4685-9a31-9d38499f4ca0', client: 'Codex', tab: 'Agent Account Space',
        origin: 'http://localhost:3000', action: 'click', target: 'button: Save', formTarget: 'http://localhost:3000/save',
        expiresAt: Date.now() + 120_000, canAllowSession: false },
    });
  }
  const agentChange = () => agentListeners.forEach((listener) => listener());
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    getAgentStatus: async () => structuredClone(agentState),
    onAgentChanged: (listener) => {
      agentListeners.add(listener as () => void);
      return () => agentListeners.delete(listener as () => void);
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
    getState: async () => structuredClone(state),
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
    queryHistory: (async (id: unknown, input: unknown) => {
      const scope = state.activeWorkspaceId === 'banking' || state.activeAccountSpaceId !== id ? [] : state.history;
      return queryHistory(scope, state.activeAccountSpaceId, input as Parameters<PrivateBrowserApi['queryHistory']>[1]);
    }) satisfies PrivateBrowserApi['queryHistory'],
    onState: (callback) => { listeners.add(callback as (snapshot: BrowserSnapshot) => void); return () => listeners.delete(callback as (snapshot: BrowserSnapshot) => void); },
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
    setLayout: async (layout) => { document.documentElement.dataset.previewLayout = JSON.stringify(layout); },
    setOverlayOpen: async () => undefined,
    // A normal browser has no native view to place; record the slot for browser tests instead.
    setSideAppBounds: async (_id, rect) => { document.documentElement.dataset.previewSideApp = JSON.stringify(rect); },
    sideAppCommand: async () => undefined,
    openDownload: async () => { throw new Error('This preview cannot open files. Use the desktop Downloads panel.'); },
    showDownload: async () => { throw new Error('This preview cannot open folders. Use the desktop Downloads panel.'); },
    clearSideAppData: async () => undefined,
    respondToPermissionPrompt: async (_id, decision) => { document.documentElement.dataset.previewPermission = String(decision); state.pendingPermission = undefined; publish(); },
    freezeContent: async () => null,
    toggleFullscreen: async () => { state.windowState.fullscreen = !state.windowState.fullscreen; publish(); },
    // Same rules as the main process: validated patch, Home address normalized, Banking Home is the New Tab page.
    setBrowserSettings: async (value, workspace) => {
      const patch = requireBrowserSettingsPatch(value);
      const active = state.activeWorkspaceId;
      if (workspace !== undefined && workspace !== active) throw new Error('The workspace changed. Reopen its settings.');
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
    setUiPreferences: async (patch) => { state.ui = mergeUiPreferences(state.ui, patch as UiPreferencesPatch); syncDarkMode(); publish(); },
    toggleBookmarkBar: async () => { state.ui = mergeUiPreferences(state.ui, { bookmarkBarMode: state.ui.bookmarkBarMode === 'hidden' ? 'always' : 'hidden' }); publish(); },
    activateTab: async (value) => { const tab = state.tabs.find((item) => item.id === value); if (tab) { state.activeTabId = tab.id; publish(); } },
    newTab: async () => { const id = `preview-${crypto.randomUUID()}`; state.tabs.push(homeTab(id, state.activeWorkspaceId, state.activeAccountSpaceId)); state.activeTabId = id; publish(); },
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
        Object.assign(tab, { url, title: new URL(url).hostname, isHome: false, zoomPercent: 100, securityWarning: url.startsWith('http:') ? 'insecure' : undefined, developerToolsAllowed: canUseDeveloperTools(tab.workspaceId, false, url) });
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
    moveBookmark: async (levelValue, keyValue, indexValue) => { state.bookmarks = reorderBookmarkEntry(state.bookmarks, state.activeAccountSpaceId, levelValue as { location: 'bar'; path: string[] }, keyValue as { kind: 'bookmark'; id: string }, Number(indexValue)); publish(); },
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
      const result = changeBookmarkBatch(state.bookmarks, current, ids as string[], destination as BookmarkLevelInput | undefined);
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
    toggleTrackerBlocking: async () => { state.trackerBlocking = !state.trackerBlocking; publish(); },
    switchAccountSpace: async (value) => { const id = value as AccountSpaceId; const selected = state.accountSpaces.find((item) => item.id === id); if (!selected || selected.locked) throw new Error('Account Space is unavailable'); state.activeAccountSpaceId = id; state.activeWorkspaceId = selected.workspaceId; state.activeTabId = state.tabs.find((tab) => tab.accountSpaceId === id)!.id; publish(); },
    switchWorkspace: async (value) => { const workspaceId = value as WorkspaceId; state.activeWorkspaceId = workspaceId; state.activeAccountSpaceId = state.accountSpaces.find((item) => item.workspaceId === workspaceId)!.id; state.activeTabId = state.tabs.find((tab) => tab.accountSpaceId === state.activeAccountSpaceId)!.id; publish(); },
    addLocalAccountSpace: async (workspaceValue, labelValue, colorValue) => { const id = crypto.randomUUID() as AccountSpaceId; const created = account(id, workspaceValue as WorkspaceId, String(labelValue), colorValue as 'indigo'); state.accountSpaces.push(created); state.tabs.push(homeTab(`preview-${id}`, created.workspaceId, id)); state.activeAccountSpaceId = id; state.activeTabId = `preview-${id}`; publish(); return id; },
    updateAccountSpace: async (idValue, labelValue, colorValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { if (typeof labelValue === 'string') selected.label = labelValue; if (typeof colorValue === 'string') selected.color = colorValue as typeof selected.color; publish(); } },
    reorderAccountSpaces: async (_workspace, orderValue) => { (orderValue as AccountSpaceId[]).forEach((id, order) => { const item = state.accountSpaces.find((candidate) => candidate.id === id); if (item) item.order = order; }); publish(); },
    openInAccountSpace: async () => undefined,
    setAccountSpaceLocked: async (idValue, lockedValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.locked = Boolean(lockedValue); selected.googleConnection = selected.locked ? 'locked' : 'disconnected'; publish(); } },
    configureGoogle: async () => { state.googleConfiguration = { configured: true, source: 'encrypted-settings' }; publish(); },
    connectGoogleAccount: async (idValue, modulesValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.kind = 'google'; selected.email = selected.email ?? 'account@example.com'; selected.googleConnection = 'connected'; selected.enabledModules = [...modulesValue as typeof selected.enabledModules]; publish(); } return { ok: true }; },
    disconnectGoogleAccount: async (idValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.googleConnection = 'disconnected'; publish(); } return { ok: true }; },
    createBackupRecoveryCode: async () => `PB1-${'A'.repeat(43)}`,
    verifyAndEnableBackup: async (idValue, _code, includeOpenTabsValue, includeHistoryValue) => { const selected = state.accountSpaces.find((item) => item.id === idValue); if (selected) { selected.backupEnabled = true; selected.backupIncludesOpenTabs = Boolean(includeOpenTabsValue); selected.backupIncludesHistory = Boolean(includeHistoryValue); publish(); } },
    uploadBackup: async () => ({ status: 'uploaded', etag: 'preview-etag' }),
    getAiProvider: async () => previewProvider,
    prepareAiPreview: (async () => {
      if (state.activeWorkspaceId === 'banking') throw new Error('AI is unavailable in this workspace');
      if (params.get('localAi') !== 'sample') throw new Error('A sample reading page is unavailable.');
      return {
        id: 'preview-ai-page', accountSpaceId: state.activeAccountSpaceId, tabId: state.activeTabId,
        service: 'browser', sourceRevision: 'preview-ai-page', sourceUrl: 'https://example.test/article',
        title: 'Sample catalogue', url: 'https://example.test', redactions: 0, protectedPage: false,
        text: 'The café stocks ceramic mugs. A brass kettle sits on the shelf. الشاي متوفر اليوم.',
      };
    }) satisfies PrivateBrowserApi['prepareAiPreview'],
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
      return [{ id: 'Default', name: 'Sample Chrome profile', isDefault: true, hasBookmarks: true, hasHistory: true }];
    }) satisfies PrivateBrowserApi['listChromeProfiles'],
    previewChromeImport: (async (value: unknown) => {
      const options = value as ChromeImportOptions;
      const destination = state.accountSpaces.find((item) => item.id === options.accountSpaceId && item.workspaceId === state.activeWorkspaceId);
      if (!destination || destination.locked || destination.workspaceId === 'banking' || options.profileId !== 'Default') throw new Error('Choose an available regular Account Space and sample profile');
      const key = 'preview-import-' + destination.id;
      const addBookmark = options.bookmarks && !state.bookmarks.some((item) => item.id === key);
      const addHistory = options.history && !state.history.some((item) => item.id === key);
      const skipped = { bookmarks: Number(options.bookmarks && !addBookmark), history: Number(options.history && !addHistory), passwords: 0 };
      const timestamp = '2026-09-12T10:00:00.000Z';
      const id = crypto.randomUUID();
      pendingChromeImport = { id, options, owner: state.activeAccountSpaceId };
      return {
        id, accountSpaceId: destination.id, result: { imported: { bookmarks: Number(addBookmark), history: Number(addHistory), passwords: 0 }, skipped, warnings: [] },
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
      const key = 'preview-import-' + destination.id;
      const bookmarks = state.bookmarks.length;
      const history = state.history.length;
      if (undo?.bookmark) state.bookmarks = state.bookmarks.filter((item) => item.id !== key || item.title !== 'Sample imported page');
      if (undo?.history) state.history = state.history.filter((item) => item.id !== key);
      chromeUndo.delete(destination.id);
      publish();
      return { bookmarks: bookmarks - state.bookmarks.length, history: history - state.history.length };
    },
    importChrome: (async (value: unknown) => {
      const { profileId, accountSpaceId, workspaceId, bookmarks, history } = value as Parameters<PrivateBrowserApi['importChrome']>[0];
      const destination = state.accountSpaces.find((item) => item.id === accountSpaceId && item.workspaceId === workspaceId);
      if (!destination || destination.locked || workspaceId === 'banking') throw new Error('Choose an available regular Account Space');
      if (profileId !== 'Default') throw new Error('The sample Chrome profile is unavailable');
      const url = 'https://example.test/chrome-import';
      const title = 'Sample imported page';
      const timestamp = '2026-09-12T10:00:00.000Z';
      const id = 'preview-import-' + accountSpaceId;
      const addBookmark = bookmarks && !state.bookmarks.some((item) => item.id === id);
      const addHistory = history && !state.history.some((item) => item.id === id);
      if (addBookmark) state.bookmarks.push({ id, accountSpaceId, workspaceId, title, url, createdAt: timestamp, location: 'bar', folderPath: ['Sample folder'], order: 500, orderPath: [500, 0] });
      if (addHistory) state.history.push({ id, accountSpaceId, workspaceId, title, url, visitedAt: timestamp });
      if (addBookmark || addHistory) chromeUndo.set(accountSpaceId, { bookmark: addBookmark, history: addHistory });
      publish();
      return {
        imported: { bookmarks: Number(addBookmark), history: Number(addHistory), passwords: 0 },
        skipped: { bookmarks: Number(bookmarks && !addBookmark), history: Number(history && !addHistory), passwords: 0 },
        warnings: [],
      };
    }) satisfies PrivateBrowserApi['importChrome'],
    importChromePasswords: (async () => {
      throw new Error('Password files are unavailable in the synthetic preview');
    }) satisfies PrivateBrowserApi['importChromePasswords'],
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
    listVault: async () => ({ available: true, items: [], lifecycle: params.get('vaultGuide') ? 'locked' : 'unlocked',
      platformUnlock: params.get('vaultGuide') === 'enrolled' ? 'enrolled' : undefined, sync: 'idle', dirty: false, generation: 1 }),
    getVaultMigrationStatus: async () => ({ legacyAvailable: false }),
    // The Control Center link, paired, with one task (docs/systems/control-center-link.md).
    getControlCenterStatus: async () => ({ state: 'connected', url: 'http://127.0.0.1:4317', fingerprint: '4F1C 9A2E 77D0 13B8 C6E5 0A94 2D61 F3B7' }),
    listControlCenterRepositories: async () => ({ repositories: [{ id: 'repo-shop', name: 'shop', devOrigin: 'http://127.0.0.1:5173' }, { id: 'repo-site', name: 'site', devOrigin: null }], suggestedId: 'repo-shop' }),
    listControlCenterTasks: async () => [{ id: 'TASK-0042', title: 'The cart page crashes when it is empty', repositoryName: 'shop', status: 'COMPLETED', currentStageName: 'Complete', blocker: null, finalStatus: 'READY', createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:20:00.000Z', dashboardUrl: 'http://127.0.0.1:4317/tasks/TASK-0042' }],
    sendToControlCenter: async () => ({ id: 'TASK-0043', title: 'Preview task', repositoryName: 'shop', status: 'QUEUED', currentStageName: 'Investigate', blocker: null, finalStatus: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), dashboardUrl: 'http://127.0.0.1:4317/tasks/TASK-0043' }),
    recheckControlCenterTask: async () => ({ name: 'browser-recheck-1.md' }),
    inspectVaultFormShape: async () => ({ hasUsername: false, hasPassword: false }),
  };
  const api = new Proxy(handlers, { get(target, property) { return target[String(property)] ?? (async () => undefined); } });
  Object.defineProperty(window, 'privateBrowser', { value: api as unknown as PrivateBrowserApi, configurable: true });
  document.documentElement.dataset.browserPreview = 'synthetic';
}
