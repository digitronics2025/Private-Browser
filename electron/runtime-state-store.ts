import { randomUUID } from 'node:crypto';
import type {
  AccountBrowsingStateV2,
  AccountSpaceHealth,
  AccountSpaceId,
  AccountSpaceSummary,
  BrowserStateManifestV2,
  RuntimeBrowserStateV2,
  StateRecoveryStatus,
  WorkspaceId,
} from './types.js';
import { AccountStore, type AccountSpaceRecord } from './account-store.js';
import { AccountSpaceStateStore, type AccountSpaceStateInitialization } from './account-space-state.js';
import { WORKSPACES } from './state-store.js';

export class RuntimeStateStore {
  private state: RuntimeBrowserStateV2;
  private readonly records = new Map<AccountSpaceId, AccountSpaceRecord>();
  private readonly readOnly: boolean;

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
    for (const record of initialization.accounts) this.records.set(record.id, record);
    this.state = combine(initialization.manifest, initialization.accounts, initialization.accountStates, initialization.accountRecoveries);
  }

  get(): RuntimeBrowserStateV2 {
    return structuredClone(this.state);
  }

  isReadOnly(): boolean {
    return this.readOnly;
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

  update(mutator: (state: RuntimeBrowserStateV2) => void): RuntimeBrowserStateV2 {
    if (this.readOnly) throw new Error('Browser state is in read-only recovery mode');
    const next = structuredClone(this.state);
    mutator(next);
    normalizeRuntimeState(next);
    this.persist(next);
    this.state = next;
    return this.get();
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
      delete state.activeTabByAccountSpace[id];
      if (state.activeAccountSpaceByWorkspace[account.workspaceId] === id) state.activeAccountSpaceByWorkspace[account.workspaceId] = replacement.id;
    });
    this.records.delete(id);
    this.accountStore.remove(id);
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
      accountSpaceIds: next.accountSpaces.map((account) => account.id),
      activeAccountSpaceByWorkspace: next.activeAccountSpaceByWorkspace,
      privacyLog: next.privacyLog,
      trackerBlocking: next.trackerBlocking,
    };
    for (const account of next.accountSpaces) {
      const tabs = next.tabs.filter((tab) => tab.accountSpaceId === account.id);
      const state: AccountBrowsingStateV2 = {
        version: 2,
        accountSpaceId: account.id,
        workspaceId: account.workspaceId,
        tabs: tabs.map(({ loading: _loading, canGoBack: _back, canGoForward: _forward, favicon: _favicon, developerToolsAllowed: _tools, developerToolsOpen: _toolsOpen, securityWarning: _warning, ...tab }) => tab),
        activeTabId: next.activeTabByAccountSpace[account.id],
        bookmarks: next.bookmarks.filter((item) => item.accountSpaceId === account.id),
        history: next.history.filter((item) => item.accountSpaceId === account.id),
      };
      this.persistedStore.saveAccountState(state);
    }
    this.persistedStore.saveManifest(manifest);
  }
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
    tabs,
    activeTabByAccountSpace,
    bookmarks: accountStates.flatMap((state) => state.bookmarks),
    history: accountStates.flatMap((state) => state.history),
    privacyLog: [...manifest.privacyLog],
    trackerBlocking: manifest.trackerBlocking,
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

function normalizeRuntimeState(state: RuntimeBrowserStateV2): void {
  const accountsById = new Map(state.accountSpaces.map((account) => [account.id, account]));
  for (const workspace of WORKSPACES) {
    const members = state.accountSpaces.filter((account) => account.workspaceId === workspace.id);
    if (members.length === 0) throw new Error('Every workspace requires at least one Account Space');
    const active = state.activeAccountSpaceByWorkspace[workspace.id];
    if (!active || !members.some((account) => account.id === active)) state.activeAccountSpaceByWorkspace[workspace.id] = members[0].id;
  }
  state.tabs = state.tabs.filter((tab) => accountsById.get(tab.accountSpaceId)?.workspaceId === tab.workspaceId);
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
  state.history = state.history.filter((item) => accountsById.get(item.accountSpaceId)?.workspaceId === item.workspaceId).slice(0, 2500);
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
    accountSpaces,
    accountHealth: accountSpaces.map((account) => ({ accountSpaceId: account.id, status: 'locked', checkedAt: now })),
    recovery,
  };
}

function accountSort(left: AccountSpaceSummary, right: AccountSpaceSummary): number {
  return left.workspaceId.localeCompare(right.workspaceId) || left.order - right.order || left.id.localeCompare(right.id);
}
