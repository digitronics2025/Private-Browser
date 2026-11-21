import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  AccountBrowsingStateV2,
  AccountSpaceHealth,
  AccountSpaceId,
  AccountSpaceSummary,
  AddressMatch,
  BrowserStateManifestV2,
  HistoryPage,
  HistoryQuery,
  RuntimeBrowserStateV2,
  StateRecoveryStatus,
  WorkspaceId,
} from './types.js';
import { AccountStore, type AccountSpaceRecord } from './account-store.js';
import { AccountSpaceStateStore, type AccountSpaceStateInitialization } from './account-space-state.js';
import { pruneBookmarkIcons } from './bookmark-icons.js';
import { isAvailableRegularAccount } from './external-link-routing.js';
import { findAddressMatches } from './address-matches.js';
import { queryHistory, RETAINED_HISTORY_LIMIT } from './history-query.js';
import { defaultBrowserRoutines } from './browser-routines.js';
import { WORKSPACES } from './state-store.js';
import { DEFAULT_BROWSER_SETTINGS, sanitizeBrowserSettings, sanitizeWorkspaceSettings } from './browser-settings.js';
import { DEFAULT_UI_PREFERENCES, sanitizeUiPreferences } from './ui-preferences.js';

export class RuntimeStateStore {
  private state: RuntimeBrowserStateV2;
  private readonly records = new Map<AccountSpaceId, AccountSpaceRecord>();
  private readonly readOnly: boolean;
  private readonly savedAccounts = new Map<AccountSpaceId, AccountBrowsingStateV2>();
  private savedManifest?: BrowserStateManifestV2;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pendingWrites = false;
  /**
   * Accounts waiting in per-account recovery. They stay in the manifest and
   * their files are never written until the user resolves them, so a save
   * elsewhere can neither drop them nor overwrite what recovery must preserve.
   */
  private readonly recovering = new Set<AccountSpaceId>();

  constructor(
    private readonly persistedStore: AccountSpaceStateStore,
    private readonly accountStore: AccountStore,
    initialization: AccountSpaceStateInitialization,
  ) {
    if (initialization.status === 'recovery') {
      this.readOnly = true;
      this.state = recoveryRuntimeState(initialization.recovery);
      return;
    }
    this.readOnly = false;
    this.savedManifest = initialization.manifest;
    for (const snapshot of initialization.accountStates) this.savedAccounts.set(snapshot.accountSpaceId, snapshot);
    for (const record of initialization.accounts) this.records.set(record.id, record);
    for (const recovery of initialization.accountRecoveries) if (recovery.accountSpaceId) this.recovering.add(recovery.accountSpaceId);
    this.state = combine(initialization.manifest, initialization.accounts, initialization.accountStates, initialization.accountRecoveries);
    rememberExternalLinkAccount(this.state);
  }

  get(): RuntimeBrowserStateV2 {
    return structuredClone(this.state);
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  trackerBlockingEnabled(): boolean {
    return this.state.trackerBlocking;
  }

  addressMatches(accountSpaceId: AccountSpaceId, text: string): AddressMatch[] {
    const account = this.activeReadableAccount(accountSpaceId);
    if (!account) return [];
    return findAddressMatches(text, account.id, this.state.tabs, this.state.bookmarks,
      account.workspaceId === 'banking' ? [] : this.state.history);
  }

  addressMatchTarget(accountSpaceId: AccountSpaceId, source: AddressMatch['source'], id: string): string | undefined {
    const account = this.activeReadableAccount(accountSpaceId);
    if (!account || (source === 'history' && account.workspaceId === 'banking')) return undefined;
    const entries = source === 'tab' ? this.state.tabs : source === 'bookmark' ? this.state.bookmarks : this.state.history;
    return entries.find((entry) => entry.id === id && entry.accountSpaceId === accountSpaceId)?.url;
  }

  retainedHistory(accountSpaceId: AccountSpaceId, input: HistoryQuery): HistoryPage {
    const account = this.activeReadableAccount(accountSpaceId);
    if (!account || account.workspaceId === 'banking') return { entries: [], page: 0, pages: 0, total: 0, trimmed: false };
    return queryHistory(this.state.history, account.id, input, this.state.historyTrimmedByAccountSpace?.[account.id]);
  }

  private activeReadableAccount(id: AccountSpaceId): AccountSpaceSummary | undefined {
    if (this.readOnly || this.state.activeAccountSpaceByWorkspace[this.state.activeWorkspaceId] !== id
      || this.state.accountHealth.some((health) => health.accountSpaceId === id && health.status === 'account-corrupt')) return undefined;
    return this.state.accountSpaces.find((account) => account.id === id && !account.locked);
  }

  /**
   * Legacy per-workspace partitions that no Account Space uses any more — left
   * behind when a migrated default account is fresh-started with a new record
   * (F-62). Nothing is reported while any account is in recovery: an unreadable
   * record might still own one of them.
   */
  orphanedLegacyPartitions(): string[] {
    if (this.readOnly || this.recovering.size) return [];
    const used = new Set([...this.records.values()].map((record) => record.partitionKey));
    return WORKSPACES.map((workspace) => `persist:private-browser-${workspace.id}`).filter((key) => !used.has(key));
  }

  partitionFor(id: AccountSpaceId): string {
    const record = this.records.get(id);
    if (!record || this.state.recovery?.accountSpaceId === id) throw new Error('Account Space is unavailable while it is in recovery');
    return record.partitionKey;
  }

  recordFor(id: AccountSpaceId): AccountSpaceRecord {
    const record = this.records.get(id);
    if (!record) throw new Error('Account Space record not found');
    return structuredClone(record);
  }

  assistantPreferences(id: AccountSpaceId): { cloudAllowed: boolean; receipts: NonNullable<AccountSpaceRecord['assistantReceipts']> } | undefined {
    const record = this.records.get(id);
    return record && { cloudAllowed: record.assistantCloudAllowed !== false, receipts: structuredClone(record.assistantReceipts ?? []) };
  }

  update(mutator: (state: RuntimeBrowserStateV2) => void, persistence: 'immediate' | 'routine' = 'immediate'): RuntimeBrowserStateV2 {
    if (this.readOnly) throw new Error('Browser state is in read-only recovery mode');
    const next = structuredClone(this.state);
    mutator(next);
    normalizeRuntimeState(next, this.recovering);
    rememberExternalLinkAccount(next);
    if (persistence === 'immediate') {
      try {
        this.persist(next);
        this.finishPendingWrites();
      } catch (error) {
        // Some independent files may have committed before another write failed.
        // Retry against the previously accepted state if the caller received an error.
        this.queueSave(1000);
        throw error;
      }
    } else {
      this.queueSave(250);
    }
    this.state = next;
    return this.get();
  }

  flushPendingWrites(): void {
    if (!this.pendingWrites) return;
    this.persist(this.state);
    this.finishPendingWrites();
  }

  private queueSave(delay: number): void {
    this.pendingWrites = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      try {
        this.flushPendingWrites();
      } catch {
        if (delay < 1000) console.warn('Browser state write delayed. Private Browser will retry.');
        this.queueSave(Math.min(10000, Math.max(1000, 2 * delay)));
      }
    }, delay);
    this.saveTimer.unref();
  }

  private finishPendingWrites(): void {
    this.pendingWrites = false;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  refreshAccount(record: AccountSpaceRecord): void {
    if (this.readOnly) throw new Error('Browser state is in read-only recovery mode');
    this.records.set(record.id, structuredClone(record));
    this.state.accountSpaces = [...this.records.values()].map((item) => this.accountStore.toSummary(item)).sort(accountSort);
  }

  addAccount(record: AccountSpaceRecord): RuntimeBrowserStateV2 {
    if (this.records.has(record.id)) throw new Error('Account Space already exists');
    this.records.set(record.id, structuredClone(record));
    try {
      return this.update((state) => {
        state.accountSpaces.push(this.accountStore.toSummary(record));
        const tabId = randomUUID();
        state.tabs.push({
          id: tabId,
          accountSpaceId: record.id,
          workspaceId: record.workspaceId,
          title: 'New tab',
          url: 'private://home',
          isHome: true,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          developerToolsAllowed: false,
          developerToolsOpen: false,
        });
        state.activeTabByAccountSpace[record.id] = tabId;
        state.activeAccountSpaceByWorkspace[record.workspaceId] = record.id;
        state.activeWorkspaceId = record.workspaceId;
      });
    } catch (error) {
      this.records.delete(record.id);
      throw error;
    }
  }

  removeAccount(id: AccountSpaceId): RuntimeBrowserStateV2 {
    const account = this.state.accountSpaces.find((candidate) => candidate.id === id);
    if (!account) throw new Error('Account Space was not found');
    const workspaceAccounts = this.state.accountSpaces.filter((candidate) => candidate.workspaceId === account.workspaceId);
    if (workspaceAccounts.length <= 1) throw new Error('Create a replacement Account Space before removing the only one in this workspace');
    const replacement = workspaceAccounts.find((candidate) => candidate.id !== id)!;
    const result = this.update((state) => {
      state.accountSpaces = state.accountSpaces.filter((candidate) => candidate.id !== id);
      state.accountHealth = state.accountHealth.filter((health) => health.accountSpaceId !== id);
      state.tabs = state.tabs.filter((tab) => tab.accountSpaceId !== id);
      state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.accountSpaceId !== id);
      state.history = state.history.filter((entry) => entry.accountSpaceId !== id);
      if (state.historyTrimmedByAccountSpace) delete state.historyTrimmedByAccountSpace[id];
      if (state.tabGroupsByAccountSpace) delete state.tabGroupsByAccountSpace[id];
      delete state.activeTabByAccountSpace[id];
      delete state.shortcutsByAccountSpace[id];
      delete state.bookmarkIconsByAccountSpace[id];
      if (state.sidePanelsByAccountSpace) delete state.sidePanelsByAccountSpace[id];
      if (state.activeAccountSpaceByWorkspace[account.workspaceId] === id) state.activeAccountSpaceByWorkspace[account.workspaceId] = replacement.id;
    });
    this.records.delete(id);
    this.accountStore.remove(id);
    // The manifest no longer lists it, so its plaintext history, tabs and
    // bookmarks file is deleted too (F-39).
    this.persistedStore.removeAccountState(id);
    this.savedAccounts.delete(id);
    this.recovering.delete(id);
    return result;
  }

  reorder(workspaceId: WorkspaceId, ids: AccountSpaceId[]): RuntimeBrowserStateV2 {
    const members = this.state.accountSpaces.filter((account) => account.workspaceId === workspaceId);
    if (ids.length !== members.length || new Set(ids).size !== ids.length || members.some((account) => !ids.includes(account.id))) {
      throw new Error('Reorder must contain every Account Space in exactly one workspace');
    }
    for (const [order, id] of ids.entries()) {
      const record = this.accountStore.update(id, (account) => { account.order = order; });
      this.records.set(id, record);
    }
    this.state.accountSpaces = [...this.records.values()].map((record) => this.accountStore.toSummary(record)).sort(accountSort);
    return this.get();
  }

  private persist(next: RuntimeBrowserStateV2): void {
    const manifest: BrowserStateManifestV2 = {
      version: 2,
      activeWorkspaceId: next.activeWorkspaceId,
      accountSpaceIds: [...new Set([...next.accountSpaces.map((account) => account.id), ...this.recovering])],
      activeAccountSpaceByWorkspace: next.activeAccountSpaceByWorkspace,
      lastExternalLinkAccountSpaceId: next.lastExternalLinkAccountSpaceId,
      privacyLog: next.privacyLog,
      trackerBlocking: next.trackerBlocking,
      bookmarkBarVisible: next.ui.bookmarkBarMode !== 'hidden',
      ui: next.ui,
      settings: next.settings,
      workspaceSettings: next.workspaceSettings,
      routines: next.routines,
    };
    const tabsByAccount = byAccount(next.tabs);
    const bookmarksByAccount = byAccount(next.bookmarks);
    const historyByAccount = byAccount(next.history);
    for (const account of next.accountSpaces) {
      if (this.recovering.has(account.id)) continue;
      const tabs = tabsByAccount.get(account.id) ?? [];
      const state: AccountBrowsingStateV2 = {
        version: 2,
        accountSpaceId: account.id,
        workspaceId: account.workspaceId,
        tabs: tabs.map(({ loading: _loading, canGoBack: _back, canGoForward: _forward, favicon: _favicon, developerToolsAllowed: _tools, developerToolsOpen: _toolsOpen, securityWarning: _warning, audible: _audible, muted: _muted, zoomPercent: _zoom, problem: _problem, ...tab }) => tab),
        activeTabId: next.activeTabByAccountSpace[account.id],
        bookmarks: bookmarksByAccount.get(account.id) ?? [],
        history: historyByAccount.get(account.id) ?? [],
        ...(next.historyTrimmedByAccountSpace?.[account.id] ? { historyTrimmed: true } : {}),
        ...(next.tabGroupsByAccountSpace?.[account.id]?.length ? { tabGroups: next.tabGroupsByAccountSpace[account.id] } : {}),
        ...(next.shortcutsByAccountSpace[account.id] ? { shortcuts: next.shortcutsByAccountSpace[account.id] } : {}),
        ...(next.bookmarkIconsByAccountSpace[account.id] ? { bookmarkIcons: next.bookmarkIconsByAccountSpace[account.id] } : {}),
        ...(next.sidePanelsByAccountSpace?.[account.id] ? { sidePanel: next.sidePanelsByAccountSpace[account.id] } : {}),
      };
      if (!isDeepStrictEqual(this.savedAccounts.get(account.id), state)) {
        this.persistedStore.saveAccountState(state);
        this.savedAccounts.set(account.id, state);
      }
    }
    if (!isDeepStrictEqual(this.savedManifest, manifest)) {
      this.persistedStore.saveManifest(manifest);
      this.savedManifest = manifest;
    }
  }
}

function byAccount<T extends { accountSpaceId: AccountSpaceId }>(rows: T[]): Map<AccountSpaceId, T[]> {
  const result = new Map<AccountSpaceId, T[]>();
  for (const row of rows) {
    const members = result.get(row.accountSpaceId);
    if (members) members.push(row);
    else result.set(row.accountSpaceId, [row]);
  }
  return result;
}

function rememberExternalLinkAccount(state: RuntimeBrowserStateV2): void {
  const activeId = state.activeAccountSpaceByWorkspace[state.activeWorkspaceId];
  const active = state.accountSpaces.find((account) => account.id === activeId);
  if (active && isAvailableRegularAccount(state, active)) {
    state.lastExternalLinkAccountSpaceId = active.id;
    return;
  }
  const previous = state.accountSpaces.find((account) => account.id === state.lastExternalLinkAccountSpaceId);
  if (!previous || !isAvailableRegularAccount(state, previous)) delete state.lastExternalLinkAccountSpaceId;
}

function combine(
  manifest: BrowserStateManifestV2,
  records: AccountSpaceRecord[],
  accountStates: AccountBrowsingStateV2[],
  recoveries: StateRecoveryStatus[],
): RuntimeBrowserStateV2 {
  const accountSpaces = records.map(recordToSummary).sort(accountSort);
  const tabs = accountStates.flatMap((state) => state.tabs.map((tab) => ({
    ...tab,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    developerToolsAllowed: false,
    developerToolsOpen: false,
  })));
  const activeTabByAccountSpace = Object.fromEntries(accountStates.map((state) => [state.accountSpaceId, state.activeTabId]));
  const accountHealth: AccountSpaceHealth[] = records.map((record) => ({
    accountSpaceId: record.id,
    status: record.googleConnection,
    checkedAt: record.updatedAt,
  }));
  for (const recovery of recoveries) {
    if (!recovery.accountSpaceId) continue;
    accountHealth.push({ accountSpaceId: recovery.accountSpaceId, status: 'account-corrupt', checkedAt: new Date().toISOString(), detailCode: 'record-unreadable' });
  }
  const firstRecovery = recoveries[0];
  return {
    version: 2,
    activeWorkspaceId: manifest.activeWorkspaceId,
    activeAccountSpaceByWorkspace: { ...manifest.activeAccountSpaceByWorkspace },
    lastExternalLinkAccountSpaceId: manifest.lastExternalLinkAccountSpaceId,
    tabs,
    activeTabByAccountSpace,
    bookmarks: accountStates.flatMap((state) => state.bookmarks),
    history: accountStates.flatMap((state) => state.history),
    historyTrimmedByAccountSpace: Object.fromEntries(accountStates.filter((state) => state.historyTrimmed).map((state) => [state.accountSpaceId, true as const])),
    tabGroupsByAccountSpace: Object.fromEntries(accountStates.filter((state) => state.tabGroups?.length).map((state) => [state.accountSpaceId, state.tabGroups!])),
    privacyLog: [...manifest.privacyLog],
    trackerBlocking: manifest.trackerBlocking,
    bookmarkBarVisible: manifest.bookmarkBarVisible,
    ui: sanitizeUiPreferences(manifest.ui, manifest.bookmarkBarVisible),
    settings: sanitizeBrowserSettings(manifest.settings),
    workspaceSettings: sanitizeWorkspaceSettings(manifest.workspaceSettings),
    routines: manifest.routines ?? defaultBrowserRoutines(manifest.activeAccountSpaceByWorkspace),
    shortcutsByAccountSpace: Object.fromEntries(accountStates.filter((state) => state.shortcuts).map((state) => [state.accountSpaceId, state.shortcuts!])),
    bookmarkIconsByAccountSpace: Object.fromEntries(accountStates.filter((state) => state.bookmarkIcons).map((state) => [state.accountSpaceId, state.bookmarkIcons!])),
    sidePanelsByAccountSpace: Object.fromEntries(accountStates.flatMap((state) => state.sidePanel ? [[state.accountSpaceId, state.sidePanel]] : [])),
    accountSpaces,
    accountHealth,
    recovery: firstRecovery,
  };
}

function recordToSummary(record: AccountSpaceRecord): AccountSpaceSummary {
  const avatar = record.googleIdentity?.avatar;
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    label: record.label,
    color: record.color,
    order: record.order,
    kind: record.kind,
    email: record.googleIdentity?.email,
    displayName: record.googleIdentity?.displayName,
    avatarDataUrl: avatar ? `data:${avatar.mimeType};base64,${avatar.bytesBase64}` : undefined,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    locked: record.locked,
    googleConnection: record.googleConnection,
    websiteStatus: record.websiteStatus,
    enabledModules: [...record.enabledModules],
    grantedScopes: [...record.grantedScopes],
    backupEnabled: record.backup.enabled,
    backupIncludesOpenTabs: record.backup.includeOpenTabs,
    backupIncludesHistory: record.backup.includeHistory,
  };
}

function normalizeRuntimeState(state: RuntimeBrowserStateV2, recovering: ReadonlySet<AccountSpaceId> = new Set()): void {
  state.ui = sanitizeUiPreferences(state.ui);
  state.bookmarkBarVisible = state.ui.bookmarkBarMode !== 'hidden';
  const accountsById = new Map(state.accountSpaces.map((account) => [account.id, account]));
  for (const workspace of WORKSPACES) {
    const members = state.accountSpaces.filter((account) => account.workspaceId === workspace.id);
    if (members.length === 0) {
      // A workspace whose only account is in recovery keeps pointing at it.
      if (recovering.has(state.activeAccountSpaceByWorkspace[workspace.id]!)) continue;
      throw new Error('Every workspace requires at least one Account Space');
    }
    const active = state.activeAccountSpaceByWorkspace[workspace.id];
    if (!active || !members.some((account) => account.id === active)) state.activeAccountSpaceByWorkspace[workspace.id] = members[0].id;
  }
  const seenTabIds = new Set<string>();
  state.tabs = state.tabs.filter((tab) => {
    if (seenTabIds.has(tab.id) || accountsById.get(tab.accountSpaceId)?.workspaceId !== tab.workspaceId) return false;
    seenTabIds.add(tab.id);
    return true;
  });
  for (const account of state.accountSpaces) {
    let tabs = state.tabs.filter((tab) => tab.accountSpaceId === account.id);
    if (tabs.length === 0) {
      const id = randomUUID();
      state.tabs.push({
        id,
        accountSpaceId: account.id,
        workspaceId: account.workspaceId,
        title: 'New tab',
        url: 'private://home',
        isHome: true,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        developerToolsAllowed: false,
        developerToolsOpen: false,
      });
      tabs = state.tabs.filter((tab) => tab.accountSpaceId === account.id);
    }
    if (!tabs.some((tab) => tab.id === state.activeTabByAccountSpace[account.id])) state.activeTabByAccountSpace[account.id] = tabs[0].id;
  }
  state.bookmarks = state.bookmarks.filter((item) => accountsById.get(item.accountSpaceId)?.workspaceId === item.workspaceId);
  if (state.tabGroupsByAccountSpace) {
    const occupied = new Set(state.tabs.filter((tab) => tab.groupId).map((tab) => tab.accountSpaceId + ':' + tab.groupId));
    for (const [id, groups] of Object.entries(state.tabGroupsByAccountSpace)) {
      state.tabGroupsByAccountSpace[id] = groups.filter((group) => occupied.has(id + ':' + group.id));
    }
  }
  // An icon outlives neither its Account Space nor the last bookmark on its host.
  const bookmarkIcons: RuntimeBrowserStateV2['bookmarkIconsByAccountSpace'] = {};
  for (const [id, icons] of Object.entries(state.bookmarkIconsByAccountSpace)) {
    if (!accountsById.has(id as AccountSpaceId)) continue;
    const kept = pruneBookmarkIcons(icons, state.bookmarks.filter((item) => item.accountSpaceId === id));
    if (kept) bookmarkIcons[id] = kept;
  }
  state.bookmarkIconsByAccountSpace = bookmarkIcons;
  const retainedHistory = state.history.filter((item) => accountsById.get(item.accountSpaceId)?.workspaceId === item.workspaceId);
  const trimmedAccounts = state.historyTrimmedByAccountSpace ??= {};
  for (const removed of retainedHistory.slice(RETAINED_HISTORY_LIMIT)) trimmedAccounts[removed.accountSpaceId] = true;
  state.history = retainedHistory.slice(0, RETAINED_HISTORY_LIMIT);
  state.privacyLog = state.privacyLog.slice(0, 100);
}

function recoveryRuntimeState(recovery: StateRecoveryStatus): RuntimeBrowserStateV2 {
  const now = new Date().toISOString();
  const accountSpaces = WORKSPACES.map((workspace, order) => ({
    id: randomUUID() as AccountSpaceId,
    workspaceId: workspace.id,
    label: `${workspace.name} recovery`,
    color: 'slate' as const,
    order,
    kind: 'local' as const,
    createdAt: now,
    lastUsedAt: now,
    locked: true,
    googleConnection: 'locked' as const,
    websiteStatus: 'unknown' as const,
    enabledModules: [],
    grantedScopes: [],
    backupEnabled: false,
    backupIncludesOpenTabs: false,
    backupIncludesHistory: false,
  }));
  const tabs = accountSpaces.map((account) => ({
    id: randomUUID(),
    workspaceId: account.workspaceId,
    accountSpaceId: account.id,
    title: 'Recovery',
    url: 'private://home',
    isHome: true,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    developerToolsAllowed: false,
    developerToolsOpen: false,
  }));
  return {
    version: 2,
    activeWorkspaceId: 'digitronics',
    activeAccountSpaceByWorkspace: Object.fromEntries(accountSpaces.map((account) => [account.workspaceId, account.id])),
    tabs,
    activeTabByAccountSpace: Object.fromEntries(tabs.map((tab) => [tab.accountSpaceId, tab.id])),
    bookmarks: [],
    history: [],
    privacyLog: [],
    trackerBlocking: true,
    bookmarkBarVisible: true,
    ui: { ...DEFAULT_UI_PREFERENCES },
    settings: { ...DEFAULT_BROWSER_SETTINGS },
    shortcutsByAccountSpace: {},
    bookmarkIconsByAccountSpace: {},
    accountSpaces,
    accountHealth: accountSpaces.map((account) => ({ accountSpaceId: account.id, status: 'locked', checkedAt: now })),
    recovery,
  };
}

function accountSort(left: AccountSpaceSummary, right: AccountSpaceSummary): number {
  return left.workspaceId.localeCompare(right.workspaceId) || left.order - right.order || left.id.localeCompare(right.id);
}
