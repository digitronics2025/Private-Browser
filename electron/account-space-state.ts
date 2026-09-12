import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AccountBrowsingStateV2,
  AccountSpaceBookmark,
  AccountSpaceHistoryEntry,
  AccountSpaceId,
  BrowserStateManifestV2,
  PersistedState,
  PrivacyEvent,
  StateRecoveryStatus,
  WorkspaceId,
} from './types.js';
import { AccountStore, type AccountSpaceRecord } from './account-store.js';
import { isAccountSpaceId, requireWorkspaceId } from './account-space-validation.js';
import { isAllowedRemoteUrl } from './security.js';
import { WORKSPACES, sanitizeState } from './state-store.js';

interface MigrationJournal {
  version: 1;
  sourceFingerprint: string;
  backupPath: string;
  accountIdsByWorkspace: Record<WorkspaceId, AccountSpaceId>;
  startedAt: string;
}

export interface AccountSpaceStatePaths {
  legacyFilePath: string;
  manifestFilePath: string;
  accountStateDirectory: string;
  migrationJournalPath: string;
}

export type AccountSpaceStateInitialization =
  | {
      status: 'ready';
      manifest: BrowserStateManifestV2;
      accounts: AccountSpaceRecord[];
      accountStates: AccountBrowsingStateV2[];
      accountRecoveries: StateRecoveryStatus[];
    }
  | { status: 'recovery'; recovery: StateRecoveryStatus };

export interface AccountSpaceStateStoreOptions {
  paths: AccountSpaceStatePaths;
  accountStore: AccountStore;
  now?: () => Date;
  onMigrationPhase?: (phase: 'journal' | 'accounts' | 'account-states' | 'manifest') => void;
}

export class AccountSpaceStateStore {
  private readonly now: () => Date;

  constructor(private readonly options: AccountSpaceStateStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  initialize(): AccountSpaceStateInitialization {
    const { manifestFilePath, legacyFilePath } = this.options.paths;
    if (existsSync(manifestFilePath)) return this.loadExistingV2();
    if (existsSync(legacyFilePath)) return this.migrateLegacy();
    return this.createFresh();
  }

  saveManifest(manifest: BrowserStateManifestV2): void {
    atomicWriteJson(this.options.paths.manifestFilePath, validateManifest(manifest));
  }

  saveAccountState(state: AccountBrowsingStateV2): void {
    const sanitized = validateAccountState(state);
    atomicWriteJson(this.accountStatePath(sanitized.accountSpaceId), sanitized);
  }

  private createFresh(): AccountSpaceStateInitialization {
    const fingerprint = createHash('sha256').update(`fresh:${randomUUID()}`).digest('hex');
    const ids = createStableAccountIds(fingerprint);
    const accounts = this.ensureDefaultAccounts(ids, fingerprint);
    const accountStates = WORKSPACES.map((workspace) => createDefaultAccountState(workspace.id, ids[workspace.id]));
    for (const state of accountStates) this.saveAccountState(state);
    const manifest = createManifest(ids, 'digitronics', [], true);
    this.saveManifest(manifest);
    return { status: 'ready', manifest, accounts, accountStates, accountRecoveries: [] };
  }

  private migrateLegacy(): AccountSpaceStateInitialization {
    let sourceBytes: Buffer;
    let legacy: PersistedState;
    try {
      sourceBytes = readFileSync(this.options.paths.legacyFilePath);
      const parsed = JSON.parse(sourceBytes.toString('utf8')) as Partial<PersistedState>;
      if (parsed.version !== 1 || !Array.isArray(parsed.tabs)) throw new Error('Unsupported legacy state');
      legacy = sanitizeState(parsed as PersistedState);
    } catch {
      return { status: 'recovery', recovery: this.preserveBrowserStateForRecovery(this.options.paths.legacyFilePath, 'invalid-state', true) };
    }

    const sourceFingerprint = createHash('sha256').update(sourceBytes).digest('hex');
    let journal: MigrationJournal;
    try {
      journal = this.loadOrCreateJournal(sourceFingerprint);
    } catch {
      return { status: 'recovery', recovery: this.preserveBrowserStateForRecovery(this.options.paths.legacyFilePath, 'migration-interrupted', true) };
    }
    this.options.onMigrationPhase?.('journal');

    try {
      const accounts = this.ensureDefaultAccounts(journal.accountIdsByWorkspace, sourceFingerprint);
      this.options.onMigrationPhase?.('accounts');
      const accountStates = this.migrateAccountStates(legacy, journal.accountIdsByWorkspace);
      for (const state of accountStates) this.stageAccountState(state);
      for (const state of accountStates) this.publishStagedAccountState(state.accountSpaceId);
      this.options.onMigrationPhase?.('account-states');
      const manifest = createManifest(
        journal.accountIdsByWorkspace,
        legacy.activeWorkspaceId,
        legacy.privacyLog,
        legacy.trackerBlocking,
      );
      this.saveManifest(manifest);
      this.options.onMigrationPhase?.('manifest');
      return { status: 'ready', manifest, accounts, accountStates, accountRecoveries: [] };
    } catch {
      return {
        status: 'recovery',
        recovery: {
          readOnly: true,
          scope: 'browser-state',
          reason: 'migration-interrupted',
          backupAvailable: existsSync(journal.backupPath),
          actions: ['retry', 'open-backup-location', 'restore-v1', 'fresh-start'],
        },
      };
    }
  }

  private loadExistingV2(): AccountSpaceStateInitialization {
    let manifest: BrowserStateManifestV2;
    try {
      const parsed = JSON.parse(readFileSync(this.options.paths.manifestFilePath, 'utf8')) as BrowserStateManifestV2;
      manifest = validateManifest(parsed);
    } catch (error) {
      const reason = error instanceof UnsupportedStateVersionError ? 'unsupported-version' : 'invalid-state';
      return { status: 'recovery', recovery: this.preserveBrowserStateForRecovery(this.options.paths.manifestFilePath, reason, existsSync(this.options.paths.legacyFilePath)) };
    }

    const accounts: AccountSpaceRecord[] = [];
    const accountStates: AccountBrowsingStateV2[] = [];
    const accountRecoveries: StateRecoveryStatus[] = [];
    for (const accountSpaceId of manifest.accountSpaceIds) {
      const loadedAccount = this.options.accountStore.load(accountSpaceId);
      if (loadedAccount.status === 'corrupt') {
        accountRecoveries.push(accountRecovery(accountSpaceId, true));
        continue;
      }
      if (loadedAccount.status === 'missing') {
        accountRecoveries.push(accountRecovery(accountSpaceId, false));
        continue;
      }
      accounts.push(loadedAccount.record);
      try {
        const parsed = JSON.parse(readFileSync(this.accountStatePath(accountSpaceId), 'utf8')) as AccountBrowsingStateV2;
        const state = validateAccountState(parsed);
        if (state.workspaceId !== loadedAccount.record.workspaceId) throw new Error('Account state ownership mismatch');
        accountStates.push(state);
      } catch {
        const statePath = this.accountStatePath(accountSpaceId);
        if (existsSync(statePath)) this.preserveFile(statePath, 'corrupt');
        accountRecoveries.push(accountRecovery(accountSpaceId, existsSync(statePath)));
      }
    }

    validateActiveMembership(manifest, accounts, accountRecoveries);
    return { status: 'ready', manifest, accounts, accountStates, accountRecoveries };
  }

  private loadOrCreateJournal(sourceFingerprint: string): MigrationJournal {
    const { migrationJournalPath, legacyFilePath } = this.options.paths;
    if (existsSync(migrationJournalPath)) {
      const existing = JSON.parse(readFileSync(migrationJournalPath, 'utf8')) as MigrationJournal;
      if (existing.version !== 1 || existing.sourceFingerprint !== sourceFingerprint) throw new Error('Migration source changed');
      for (const workspace of WORKSPACES) {
        if (!isAccountSpaceId(existing.accountIdsByWorkspace?.[workspace.id])) throw new Error('Invalid migration journal');
      }
      return existing;
    }
    const timestamp = safeTimestamp(this.now());
    const backupPath = `${legacyFilePath}.v1-backup-${timestamp}`;
    if (!existsSync(backupPath)) copyFileSync(legacyFilePath, backupPath);
    const journal: MigrationJournal = {
      version: 1,
      sourceFingerprint,
      backupPath,
      accountIdsByWorkspace: createStableAccountIds(sourceFingerprint),
      startedAt: this.now().toISOString(),
    };
    atomicWriteJson(migrationJournalPath, journal);
    return journal;
  }

  private ensureDefaultAccounts(ids: Record<WorkspaceId, AccountSpaceId>, sourceFingerprint: string): AccountSpaceRecord[] {
    return WORKSPACES.map((workspace, order) => {
      const id = ids[workspace.id];
      const existing = this.options.accountStore.load(id);
      if (existing.status === 'corrupt') throw new Error('Staged Account Space is corrupt');
      if (existing.status === 'ok') {
        if (existing.record.sourceFingerprint !== sourceFingerprint || existing.record.workspaceId !== workspace.id) {
          throw new Error('Staged Account Space does not match this migration');
        }
        return existing.record;
      }
      return this.options.accountStore.createLocal({
        id,
        workspaceId: workspace.id,
        label: workspace.name,
        color: workspaceColor(workspace.id),
        order,
        partitionKey: `persist:private-browser-${workspace.id}`,
        sourceFingerprint,
      });
    });
  }

  private migrateAccountStates(legacy: PersistedState, ids: Record<WorkspaceId, AccountSpaceId>): AccountBrowsingStateV2[] {
    return WORKSPACES.map((workspace) => {
      const accountSpaceId = ids[workspace.id];
      const tabs = legacy.tabs.filter((tab) => tab.workspaceId === workspace.id).map((tab) => ({ ...tab, accountSpaceId }));
      const activeCandidate = legacy.activeTabByWorkspace[workspace.id];
      return validateAccountState({
        version: 2,
        accountSpaceId,
        workspaceId: workspace.id,
        tabs,
        activeTabId: tabs.some((tab) => tab.id === activeCandidate) ? activeCandidate! : tabs[0].id,
        bookmarks: legacy.bookmarks.filter((item) => item.workspaceId === workspace.id).map((item) => ({ ...item, accountSpaceId })),
        history: legacy.history.filter((item) => item.workspaceId === workspace.id).map((item) => ({ ...item, accountSpaceId })),
      });
    });
  }

  private stageAccountState(state: AccountBrowsingStateV2): void {
    atomicWriteJson(`${this.accountStatePath(state.accountSpaceId)}.staged`, validateAccountState(state));
  }

  private publishStagedAccountState(id: AccountSpaceId): void {
    const stagedPath = `${this.accountStatePath(id)}.staged`;
    if (!existsSync(stagedPath)) return;
    mkdirSync(dirname(this.accountStatePath(id)), { recursive: true });
    renameSync(stagedPath, this.accountStatePath(id));
  }

  private accountStatePath(id: AccountSpaceId): string {
    return join(this.options.paths.accountStateDirectory, `${id}.json`);
  }

  private preserveBrowserStateForRecovery(
    filePath: string,
    reason: StateRecoveryStatus['reason'],
    restoreV1: boolean,
  ): StateRecoveryStatus {
    const backupPath = existsSync(filePath) ? this.preserveFile(filePath, 'recovery') : undefined;
    return {
      readOnly: true,
      scope: 'browser-state',
      reason,
      backupAvailable: Boolean(backupPath),
      actions: restoreV1
        ? ['retry', 'open-backup-location', 'restore-v1', 'fresh-start']
        : ['retry', 'open-backup-location', 'fresh-start'],
    };
  }

  private preserveFile(filePath: string, label: string): string {
    const backupPath = `${filePath}.${label}-${safeTimestamp(this.now())}`;
    if (!existsSync(backupPath)) copyFileSync(filePath, backupPath);
    return backupPath;
  }
}

export function validateManifest(input: BrowserStateManifestV2): BrowserStateManifestV2 {
  if (!input || typeof input !== 'object') throw new Error('Invalid browser state manifest');
  if (input.version !== 2) throw new UnsupportedStateVersionError();
  const activeWorkspaceId = requireWorkspaceId(input.activeWorkspaceId);
  if (!Array.isArray(input.accountSpaceIds) || input.accountSpaceIds.length < WORKSPACES.length || input.accountSpaceIds.length > 500) {
    throw new Error('Invalid Account Space manifest');
  }
  const accountSpaceIds = input.accountSpaceIds.map((id) => {
    if (!isAccountSpaceId(id)) throw new Error('Invalid Account Space manifest');
    return id;
  });
  if (new Set(accountSpaceIds).size !== accountSpaceIds.length) throw new Error('Duplicate Account Space identifier');
  const activeAccountSpaceByWorkspace: Partial<Record<WorkspaceId, AccountSpaceId>> = {};
  for (const workspace of WORKSPACES) {
    const id = input.activeAccountSpaceByWorkspace?.[workspace.id];
    if (!isAccountSpaceId(id) || !accountSpaceIds.includes(id)) throw new Error('Invalid active Account Space');
    activeAccountSpaceByWorkspace[workspace.id] = id;
  }
  return {
    version: 2,
    activeWorkspaceId,
    accountSpaceIds,
    activeAccountSpaceByWorkspace,
    trackerBlocking: input.trackerBlocking !== false,
    privacyLog: sanitizePrivacyLog(input.privacyLog),
  };
}

export function validateAccountState(input: AccountBrowsingStateV2): AccountBrowsingStateV2 {
  if (!input || typeof input !== 'object' || input.version !== 2 || !isAccountSpaceId(input.accountSpaceId)) {
    throw new Error('Invalid Account Space browsing state');
  }
  const workspaceId = requireWorkspaceId(input.workspaceId);
  if (!Array.isArray(input.tabs)) throw new Error('Invalid Account Space tabs');
  const tabs = input.tabs.slice(0, 100).filter((tab) =>
    tab && tab.accountSpaceId === input.accountSpaceId && tab.workspaceId === workspaceId && typeof tab.id === 'string'
      && (tab.url === 'private://home' || isAllowedRemoteUrl(tab.url)),
  ).map((tab) => ({
    id: tab.id.slice(0, 200),
    workspaceId,
    accountSpaceId: input.accountSpaceId,
    title: typeof tab.title === 'string' ? tab.title.slice(0, 500) : 'New tab',
    url: tab.url,
    isHome: tab.url === 'private://home' || Boolean(tab.isHome),
  }));
  if (tabs.length === 0) {
    tabs.push({ id: randomUUID(), workspaceId, accountSpaceId: input.accountSpaceId, title: 'New tab', url: 'private://home', isHome: true });
  }
  const activeTabId = tabs.some((tab) => tab.id === input.activeTabId) ? input.activeTabId : tabs[0].id;
  const bookmarks = sanitizeAccountItems<AccountSpaceBookmark>(input.bookmarks, input.accountSpaceId, workspaceId, 1000);
  const history = sanitizeAccountItems<AccountSpaceHistoryEntry>(input.history, input.accountSpaceId, workspaceId, 500);
  return { version: 2, accountSpaceId: input.accountSpaceId, workspaceId, tabs, activeTabId, bookmarks, history };
}

function sanitizeAccountItems<T extends AccountSpaceBookmark | AccountSpaceHistoryEntry>(
  value: unknown,
  accountSpaceId: AccountSpaceId,
  workspaceId: WorkspaceId,
  maximum: number,
): T[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).filter((item) =>
    item && typeof item === 'object'
      && (item as T).accountSpaceId === accountSpaceId
      && (item as T).workspaceId === workspaceId
      && typeof (item as T).id === 'string'
      && typeof (item as T).title === 'string'
      && isAllowedRemoteUrl((item as T).url),
  ).map((item) => ({ ...item, title: (item as T).title.slice(0, 500), accountSpaceId, workspaceId })) as T[];
}

function createManifest(
  ids: Record<WorkspaceId, AccountSpaceId>,
  activeWorkspaceId: WorkspaceId,
  privacyLog: PrivacyEvent[],
  trackerBlocking: boolean,
): BrowserStateManifestV2 {
  return {
    version: 2,
    activeWorkspaceId,
    accountSpaceIds: WORKSPACES.map((workspace) => ids[workspace.id]),
    activeAccountSpaceByWorkspace: Object.fromEntries(WORKSPACES.map((workspace) => [workspace.id, ids[workspace.id]])),
    trackerBlocking,
    privacyLog: sanitizePrivacyLog(privacyLog),
  };
}

function createDefaultAccountState(workspaceId: WorkspaceId, accountSpaceId: AccountSpaceId): AccountBrowsingStateV2 {
  const id = randomUUID();
  return {
    version: 2,
    accountSpaceId,
    workspaceId,
    tabs: [{ id, workspaceId, accountSpaceId, title: 'New tab', url: 'private://home', isHome: true }],
    activeTabId: id,
    bookmarks: [],
    history: [],
  };
}

function createStableAccountIds(sourceFingerprint: string): Record<WorkspaceId, AccountSpaceId> {
  return Object.fromEntries(WORKSPACES.map((workspace) => [workspace.id, stableUuid(sourceFingerprint, workspace.id)])) as Record<WorkspaceId, AccountSpaceId>;
}

function stableUuid(fingerprint: string, workspaceId: WorkspaceId): AccountSpaceId {
  const bytes = Buffer.from(createHash('sha256').update(`${fingerprint}:${workspaceId}`).digest('hex').slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as AccountSpaceId;
}

function workspaceColor(workspaceId: WorkspaceId): AccountSpaceRecord['color'] {
  return { digitronics: 'indigo', tenten: 'amber', development: 'violet', personal: 'emerald', banking: 'rose' }[workspaceId] as AccountSpaceRecord['color'];
}

function validateActiveMembership(
  manifest: BrowserStateManifestV2,
  accounts: AccountSpaceRecord[],
  recoveries: StateRecoveryStatus[],
): void {
  for (const workspace of WORKSPACES) {
    const activeId = manifest.activeAccountSpaceByWorkspace[workspace.id];
    const recovering = recoveries.some((recovery) => recovery.accountSpaceId === activeId);
    if (!recovering && !accounts.some((account) => account.id === activeId && account.workspaceId === workspace.id)) {
      throw new Error('Active Account Space crosses a workspace boundary');
    }
  }
}

function sanitizePrivacyLog(value: unknown): PrivacyEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).filter((entry) => entry && typeof entry === 'object') as PrivacyEvent[];
}

function accountRecovery(accountSpaceId: AccountSpaceId, backupAvailable: boolean): StateRecoveryStatus {
  return {
    readOnly: true,
    scope: 'account-space',
    reason: 'account-corrupt',
    accountSpaceId,
    backupAvailable,
    actions: ['retry', 'open-backup-location', 'fresh-start'],
  };
}

function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporaryPath, filePath);
}

function safeTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-');
}

class UnsupportedStateVersionError extends Error {}
