import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { AccountBrowsingStateV2, AccountSpaceBookmark, AccountSpaceHistoryEntry, AccountSpaceId, BackupGenerationSummary, BackupRestorePreview, BackupUploadPreview, BookmarkFolder, BrowserTab, HistoryEntry, WorkspaceId } from './types.js';
import { MAX_ACCOUNT_BOOKMARKS, MAX_ACCOUNT_TABS, validateAccountState } from './account-space-state.js';
import { RETAINED_HISTORY_LIMIT } from './history-query.js';
import { AccountStore, type SafeStorageAdapter } from './account-store.js';
import { appendBookmarkFolders, validateBookmarkFolders } from './bookmark-tree.js';

const BACKUP_AAD = Buffer.from('private-browser-account-space-backup:v1', 'utf8');
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const MAX_PRIOR_GENERATIONS = 2;

export interface BackupBookmarkFolder {
  id: string;
  parentId?: string;
  title: string;
  order: number;
}

export interface AccountBackupSnapshot {
  version: 1;
  createdAt: string;
  workspaceId?: WorkspaceId;
  bookmarks: AccountSpaceBookmark[];
  bookmarkFolders: BackupBookmarkFolder[];
  folderTree?: BookmarkFolder[];
  settings: { trackerBlocking: boolean };
  openTabs?: Array<Pick<BrowserTab, 'id' | 'workspaceId' | 'accountSpaceId' | 'title' | 'url' | 'isHome'>>;
  history?: HistoryEntry[];
}

export interface AccountBackupPayload extends AccountBackupSnapshot {
  generations?: AccountBackupSnapshot[];
}

export interface EncryptedBackupEnvelope {
  version: 1;
  algorithm: 'AES-256-GCM';
  iv: string;
  authenticationTag: string;
  ciphertext: string;
}

export interface RemoteEncryptedBackup {
  bytes: Uint8Array;
  etag: string;
  fileId: string;
}

export interface EncryptedBackupTransport {
  read(accountSpaceId: AccountSpaceId, signal?: AbortSignal): Promise<RemoteEncryptedBackup | undefined>;
  write(accountSpaceId: AccountSpaceId, bytes: Uint8Array, expectedEtag?: string, signal?: AbortSignal): Promise<{ etag: string; fileId: string }>;
}

export type BackupWriteResult =
  | { status: 'uploaded'; etag: string }
  | { status: 'conflict'; localEtag?: string; remoteEtag: string };

export class AccountBackupManager {
  private readonly pendingRecoveryKeys = new Map<AccountSpaceId, Buffer>();
  private readonly writes = new Set<AccountSpaceId>();

  constructor(
    private readonly accounts: AccountStore,
    private readonly encryption: SafeStorageAdapter,
    private readonly transport: EncryptedBackupTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  createRecoveryCode(accountSpaceId: AccountSpaceId): string {
    const account = this.accounts.require(accountSpaceId);
    if (!account.enabledModules.includes('encrypted-backup')) throw new Error('Enable and reconnect the encrypted backup module first');
    const key = randomBytes(32);
    this.pendingRecoveryKeys.get(accountSpaceId)?.fill(0);
    this.pendingRecoveryKeys.set(accountSpaceId, key);
    return encodeRecoveryCode(key);
  }

  verifyAndEnable(accountSpaceId: AccountSpaceId, recoveryCode: string, includeOpenTabs: boolean, includeHistory: boolean): void {
    const pending = this.pendingRecoveryKeys.get(accountSpaceId);
    let supplied: Buffer;
    try { supplied = decodeRecoveryCode(recoveryCode); } catch { throw new Error('Recovery code did not match'); }
    if (!pending || pending.length !== supplied.length || !timingSafeEqual(pending, supplied)) {
      supplied.fill(0);
      throw new Error('Recovery code did not match');
    }
    if (!this.encryption.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
    const wrappedRecoveryKey = this.encryption.encryptString(pending.toString('base64url')).toString('base64');
    this.accounts.update(accountSpaceId, (account) => {
      account.backup = { enabled: true, wrappedRecoveryKey, includeOpenTabs, includeHistory, enabledAt: this.now().toISOString(), reminderDays: 14 };
    });
    supplied.fill(0);
    pending.fill(0);
    this.pendingRecoveryKeys.delete(accountSpaceId);
  }

  disable(accountSpaceId: AccountSpaceId): void {
    this.pendingRecoveryKeys.get(accountSpaceId)?.fill(0);
    this.pendingRecoveryKeys.delete(accountSpaceId);
    this.accounts.update(accountSpaceId, (account) => {
      account.backup = { enabled: false, includeOpenTabs: false, includeHistory: false };
    });
  }

  buildPayload(
    accountSpaceId: AccountSpaceId,
    value: {
      bookmarks: AccountSpaceBookmark[];
      bookmarkFolders?: BackupBookmarkFolder[];
      folderTree?: BookmarkFolder[];
      trackerBlocking: boolean;
      openTabs: BrowserTab[];
      history: HistoryEntry[];
    },
  ): AccountBackupPayload {
    const account = this.accounts.require(accountSpaceId);
    const bookmarks = value.bookmarks.filter((item) => item.accountSpaceId === accountSpaceId && item.workspaceId === account.workspaceId).map(sanitizeBookmark);
    const bookmarkFolders = (value.bookmarkFolders ?? []).slice(0, 1000).map(sanitizeFolder);
    const folderTree = validateBookmarkFolders(value.folderTree);
    const payload: AccountBackupPayload = {
      version: 1,
      createdAt: this.now().toISOString(),
      workspaceId: account.workspaceId,
      bookmarks,
      bookmarkFolders,
      ...(folderTree.length ? { folderTree } : {}),
      settings: { trackerBlocking: value.trackerBlocking },
    };
    if (account.backup.includeOpenTabs) {
      payload.openTabs = value.openTabs.filter((tab) => tab.accountSpaceId === accountSpaceId && tab.workspaceId === account.workspaceId).slice(0, 100).map(({ id, workspaceId, accountSpaceId: idOfAccount, title, url, isHome }) => ({ id, workspaceId, accountSpaceId: idOfAccount, title: title.slice(0, 500), url, isHome }));
    }
    if (account.backup.includeHistory) {
      payload.history = value.history.filter((entry) => entry.accountSpaceId === accountSpaceId && entry.workspaceId === account.workspaceId).slice(0, 500).map((entry) => ({ ...entry, title: entry.title.slice(0, 500) }));
    }
    return payload;
  }

  async reviewUpload(accountSpaceId: AccountSpaceId, payload: AccountBackupPayload, signal?: AbortSignal):
    Promise<{ details: Omit<BackupUploadPreview, 'id' | 'accountSpaceId'>; expectedEtag: string | null }> {
    const account = this.accounts.require(accountSpaceId);
    const key = this.unwrapLocalKey(accountSpaceId);
    try {
      const existing = await this.transport.read(accountSpaceId, signal);
      const remote = existing && decryptCompatibleBackup(existing, key, account.workspaceId);
      return { expectedEtag: existing?.etag ?? null, details: {
        local: summarizeBackup(payload), remote: remote && summarizeBackup(remote),
        merged: remote && summarizeBackup(mergePayloads(remote, payload)),
        generations: (remote?.generations ?? []).map(summarizeBackup),
        conflict: Boolean(existing && existing.etag !== account.backup.remoteEtag),
      } };
    } finally {
      key.fill(0);
    }
  }

  async upload(
    accountSpaceId: AccountSpaceId,
    payload: AccountBackupPayload,
    conflictResolution?: 'merge' | 'overwrite',
    signal?: AbortSignal,
    reviewedEtag?: string | null,
  ): Promise<BackupWriteResult> {
    const account = this.accounts.require(accountSpaceId);
    if (this.writes.has(accountSpaceId)) throw new Error('An encrypted backup is already being saved.');
    const key = this.unwrapLocalKey(accountSpaceId);
    this.writes.add(accountSpaceId);
    try {
      const remote = await this.transport.read(accountSpaceId, signal);
      if (reviewedEtag !== undefined && (remote?.etag ?? null) !== reviewedEtag) throw new Error('The encrypted backup changed. Review it again.');
      if (remote && remote.etag !== account.backup.remoteEtag && !conflictResolution) {
        return { status: 'conflict', localEtag: account.backup.remoteEtag, remoteEtag: remote.etag };
      }
      const previous = remote && decryptCompatibleBackup(remote, key, account.workspaceId);
      const nextPayload = previous && conflictResolution === 'merge' ? mergePayloads(previous, payload) : snapshotForGeneration(payload);
      const envelope = encryptBackupPayload(retainBackupGenerations(nextPayload, previous), key);
      const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
      if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error('Encrypted backup exceeds its size limit');
      signal?.throwIfAborted();
      const written = await this.transport.write(accountSpaceId, bytes, remote?.etag, signal);
      this.accounts.update(accountSpaceId, (record) => {
        record.backup.remoteEtag = written.etag;
        record.backup.remoteFileId = written.fileId;
        record.backup.lastUploadedAt = payload.createdAt;
      });
      return { status: 'uploaded', etag: written.etag };
    } finally {
      this.writes.delete(accountSpaceId);
      key.fill(0);
    }
  }

  async restore(accountSpaceId: AccountSpaceId, recoveryCode?: string, signal?: AbortSignal): Promise<AccountBackupPayload> {
    const key = recoveryCode ? decodeRecoveryCode(recoveryCode) : this.unwrapLocalKey(accountSpaceId);
    try {
      const remote = await this.transport.read(accountSpaceId, signal);
      if (!remote) throw new Error('No encrypted backup was found');
      return decryptBackupEnvelope(parseEnvelope(remote.bytes), key);
    } finally {
      key.fill(0);
    }
  }

  async restoreGeneration(accountSpaceId: AccountSpaceId, recoveryCode?: string, createdAt?: string, signal?: AbortSignal):
    Promise<{ payload: AccountBackupSnapshot; generations: BackupGenerationSummary[] }> {
    const remote = await this.restore(accountSpaceId, recoveryCode, signal);
    const generations = [snapshotForGeneration(remote), ...(remote.generations ?? [])];
    const payload = createdAt ? generations.find((item) => item.createdAt === createdAt) : generations[0];
    if (!payload) throw new Error('This backup generation is no longer available.');
    return { payload, generations: generations.map(summarizeBackup) };
  }

  clearAccount(accountSpaceId: AccountSpaceId): void {
    this.pendingRecoveryKeys.get(accountSpaceId)?.fill(0);
    this.pendingRecoveryKeys.delete(accountSpaceId);
  }

  private unwrapLocalKey(accountSpaceId: AccountSpaceId): Buffer {
    const account = this.accounts.require(accountSpaceId);
    if (!account.backup.enabled || !account.backup.wrappedRecoveryKey || !this.encryption.isEncryptionAvailable()) {
      throw new Error('Backup restore is disabled because recovery material is unavailable');
    }
    try {
      const encoded = this.encryption.decryptString(Buffer.from(account.backup.wrappedRecoveryKey, 'base64'));
      const key = Buffer.from(encoded, 'base64url');
      if (key.length !== 32) throw new Error('Invalid recovery key');
      return key;
    } catch {
      throw new Error('Backup restore is disabled because recovery material is unavailable');
    }
  }
}

function decryptCompatibleBackup(remote: RemoteEncryptedBackup, key: Uint8Array, workspaceId: WorkspaceId): AccountBackupPayload {
  const payload = decryptBackupEnvelope(parseEnvelope(remote.bytes), key);
  if (payload.workspaceId && payload.workspaceId !== workspaceId) throw new Error('This backup belongs to a different workspace.');
  return payload;
}

export function summarizeBackup(payload: AccountBackupSnapshot): BackupGenerationSummary {
  return { createdAt: payload.createdAt, bookmarks: payload.bookmarks.length, folders: payload.folderTree?.length ?? payload.bookmarkFolders.length,
    tabs: payload.openTabs?.length ?? 0, history: payload.history?.length ?? 0 };
}

export function backupUploadRevision(payload: AccountBackupPayload): string {
  return createHash('sha256').update(JSON.stringify({ ...payload, createdAt: undefined })).digest('hex');
}

function snapshotForGeneration({ generations: _generations, ...snapshot }: AccountBackupPayload): AccountBackupSnapshot {
  return snapshot;
}

function retainBackupGenerations(latest: AccountBackupSnapshot, previous?: AccountBackupPayload): AccountBackupPayload {
  if (!previous) return latest;
  const generations = [snapshotForGeneration(previous), ...(previous.generations ?? [])].slice(0, MAX_PRIOR_GENERATIONS);
  while (generations.length) {
    const candidate = { ...latest, generations };
    const paddedSize = Math.ceil(Buffer.byteLength(JSON.stringify(candidate), 'utf8') / 3) * 4 + 160;
    if (paddedSize <= MAX_BACKUP_BYTES) return candidate;
    generations.pop();
  }
  return latest;
}

/**
 * What a decrypted backup may put into one Account Space.
 *
 * Items are re-stamped with the target's id: a backup lives in the Google
 * account's own Drive app-data, and restoring it on a new device or after a
 * reinstall — its whole purpose — meets a freshly generated local id (F-45).
 * The workspace must still match, and everything passes the same validator as
 * the on-disk state, so a malformed item is dropped rather than merged (F-63).
 * Browser-wide settings are deliberately not restored (F-59).
 */
export function restorableItems(
  payload: AccountBackupPayload,
  target: { accountSpaceId: AccountSpaceId; workspaceId: WorkspaceId },
): { bookmarks: AccountSpaceBookmark[]; history?: AccountSpaceHistoryEntry[]; openTabs?: AccountBrowsingStateV2['tabs'] } {
  const items: Array<{ workspaceId?: unknown }> = [...payload.bookmarks, ...(payload.history ?? []), ...(payload.openTabs ?? [])];
  if ((payload.workspaceId && payload.workspaceId !== target.workspaceId) || items.some((item) => !item || item.workspaceId !== target.workspaceId)) {
    throw new Error('This backup was made in another workspace');
  }
  const restamp = <T extends object>(list: T[] | undefined): T[] => (list ?? []).map((item) => ({ ...item, accountSpaceId: target.accountSpaceId }));
  const clean = validateAccountState({
    version: 2,
    accountSpaceId: target.accountSpaceId,
    workspaceId: target.workspaceId,
    tabs: restamp(payload.openTabs),
    activeTabId: payload.openTabs?.[0]?.id ?? '',
    bookmarks: restamp(payload.bookmarks),
    history: restamp(payload.history),
  });
  return {
    bookmarks: clean.bookmarks,
    ...(payload.history ? { history: clean.history } : {}),
    ...(payload.openTabs?.length ? { openTabs: clean.tabs } : {}),
  };
}

type CurrentBrowsingItems = Pick<AccountBrowsingStateV2, 'bookmarks' | 'history' | 'tabs'> & {
  bookmarkFoldersByAccountSpace?: Record<string, BookmarkFolder[]>;
};

function accountBrowsingItems(accountSpaceId: AccountSpaceId, current: CurrentBrowsingItems): CurrentBrowsingItems {
  return {
    bookmarks: current.bookmarks.filter((item) => item.accountSpaceId === accountSpaceId),
    history: current.history.filter((item) => item.accountSpaceId === accountSpaceId),
    tabs: current.tabs.filter((item) => item.accountSpaceId === accountSpaceId),
  };
}

export function backupRestoreRevision(accountSpaceId: AccountSpaceId, current: CurrentBrowsingItems): string {
  const { bookmarks, history, tabs } = accountBrowsingItems(accountSpaceId, current);
  return createHash('sha256').update(JSON.stringify({
    bookmarks, history, retainedHistoryCount: current.history.length,
    folders: current.bookmarkFoldersByAccountSpace?.[accountSpaceId],
    tabs: tabs.map(({ id, url, title, isHome }) => [id, url, title, isHome]),
  })).digest('base64url');
}

export function planBackupRestore(payload: AccountBackupPayload, target: {
  accountSpaceId: AccountSpaceId; workspaceId: WorkspaceId;
}, current: CurrentBrowsingItems) {
  const source = restorableItems(payload, target);
  const local = accountBrowsingItems(target.accountSpaceId, current);
  const bookmarkKey = (item: AccountSpaceBookmark) => JSON.stringify([item.location, item.folderPath, item.url]);
  const historyKey = (item: HistoryEntry) => JSON.stringify([item.visitedAt, item.url]);
  const tabKey = (item: AccountBrowsingStateV2['tabs'][number]) => item.url;
  const bookmarks = newBackupItems(source.bookmarks, local.bookmarks, bookmarkKey, MAX_ACCOUNT_BOOKMARKS - local.bookmarks.length);
  const readableHistory = (source.history ?? []).filter((item) => Number.isFinite(Date.parse(item.visitedAt)));
  const history = newBackupItems(readableHistory, local.history, historyKey, RETAINED_HISTORY_LIMIT - current.history.length);
  const tabs = newBackupItems((source.openTabs ?? []).filter((item) => !item.isHome), local.tabs, tabKey, MAX_ACCOUNT_TABS - local.tabs.length);
  const counts: BackupRestorePreview['counts'] = { bookmarks: bookmarks.counts, history: history.counts, tabs: tabs.counts };
  const folders = validateBookmarkFolders(payload.folderTree);
  const existing = current.bookmarkFoldersByAccountSpace?.[target.accountSpaceId] ?? [];
  const result = appendBookmarkFolders(existing, folders);
  const added = result.slice(existing.length);
  if (folders.length) {
    const keyFor = (item: BookmarkFolder) => JSON.stringify([item.location, item.path]);
    const localKeys = new Set(existing.map(keyFor));
    const duplicates = folders.filter((item) => localKeys.has(keyFor(item))).length;
    counts.folders = { added: added.length, duplicates, capacityExceeded: Math.max(0, folders.length - duplicates - added.length) };
  }
  return { counts, items: { bookmarks: bookmarks.items, folders: added, history: history.items, tabs: tabs.items } };
}

function newBackupItems<T extends { id: string }>(remote: T[], current: T[], key: (item: T) => string, capacity: number) {
  const ids = new Set(current.map(({ id }) => id));
  const keys = new Set(current.map(key));
  const items: T[] = [];
  let duplicates = 0;
  let capacityExceeded = 0;
  for (const item of remote) {
    const identity = key(item);
    if (ids.has(item.id) || keys.has(identity)) {
      duplicates += 1;
      continue;
    }
    ids.add(item.id);
    keys.add(identity);
    if (items.length >= capacity) {
      capacityExceeded += 1;
      continue;
    }
    items.push({ ...item, id: randomUUID() });
  }
  return { items, counts: { added: items.length, duplicates, capacityExceeded } };
}

export function encryptBackupPayload(payload: AccountBackupPayload, key: Uint8Array): EncryptedBackupEnvelope {
  if (key.byteLength !== 32) throw new Error('Backup encryption requires a 256-bit key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(BACKUP_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { version: 1, algorithm: 'AES-256-GCM', iv: iv.toString('base64url'), authenticationTag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
}

export function decryptBackupEnvelope(envelope: EncryptedBackupEnvelope, key: Uint8Array): AccountBackupPayload {
  if (key.byteLength !== 32 || envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM') throw new Error('Unsupported encrypted backup');
  try {
    const iv = Buffer.from(envelope.iv, 'base64url');
    const tag = Buffer.from(envelope.authenticationTag, 'base64url');
    const ciphertext = Buffer.from(envelope.ciphertext, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0 || ciphertext.length > MAX_BACKUP_BYTES) throw new Error('Invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(BACKUP_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return validatePayload(JSON.parse(plaintext) as unknown);
  } catch {
    throw new Error('Encrypted backup failed authentication or is corrupt');
  }
}

export function encodeRecoveryCode(key: Uint8Array): string {
  if (key.byteLength !== 32) throw new Error('Recovery code requires a 256-bit key');
  return `PB1-${Buffer.from(key).toString('base64url')}`;
}

export function decodeRecoveryCode(value: string): Buffer {
  if (!/^PB1-[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid recovery code');
  const key = Buffer.from(value.slice(4), 'base64url');
  if (key.length !== 32) throw new Error('Invalid recovery code');
  return key;
}

function parseEnvelope(bytes: Uint8Array): EncryptedBackupEnvelope {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_BACKUP_BYTES) throw new Error('Encrypted backup exceeds its size limit');
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')) as EncryptedBackupEnvelope; } catch { throw new Error('Encrypted backup is malformed'); }
}

function validatePayload(value: unknown): AccountBackupPayload {
  const latest = validateSnapshot(value);
  const generations = (value as Partial<AccountBackupPayload>).generations;
  if (generations === undefined) return latest;
  if (!Array.isArray(generations) || generations.length > MAX_PRIOR_GENERATIONS) throw new Error('Invalid backup generations');
  return { ...latest, generations: generations.map(validateSnapshot) };
}

function validateSnapshot(value: unknown): AccountBackupSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid backup payload');
  const payload = value as Partial<AccountBackupPayload>;
  if (payload.version !== 1 || typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt)) || !Array.isArray(payload.bookmarks) || !Array.isArray(payload.bookmarkFolders) || !payload.settings || typeof payload.settings.trackerBlocking !== 'boolean') throw new Error('Invalid backup payload');
  if (payload.openTabs && !Array.isArray(payload.openTabs)) throw new Error('Invalid backup tabs');
  if (payload.history && !Array.isArray(payload.history)) throw new Error('Invalid backup history');
  const clean = snapshotForGeneration(payload as AccountBackupPayload);
  if (clean.folderTree !== undefined) clean.folderTree = validateBookmarkFolders(clean.folderTree);
  return clean;
}

function mergePayloads(remote: AccountBackupPayload, local: AccountBackupPayload): AccountBackupPayload {
  return {
    ...local,
    bookmarks: mergeById(remote.bookmarks, local.bookmarks),
    bookmarkFolders: mergeById(remote.bookmarkFolders, local.bookmarkFolders),
    folderTree: remote.folderTree || local.folderTree ? appendBookmarkFolders(local.folderTree ?? [], remote.folderTree ?? []) : undefined,
    openTabs: local.openTabs ? mergeById(remote.openTabs ?? [], local.openTabs) : undefined,
    history: local.history ? mergeById(remote.history ?? [], local.history).sort((left, right) => right.visitedAt.localeCompare(left.visitedAt)).slice(0, 500) : undefined,
  };
}

function mergeById<T extends { id: string }>(remote: T[], local: T[]): T[] {
  return [...new Map([...remote, ...local].map((item) => [item.id, item])).values()];
}

function sanitizeBookmark(value: AccountSpaceBookmark): AccountSpaceBookmark {
  return { ...value, id: value.id.slice(0, 200), title: value.title.slice(0, 500), url: value.url.slice(0, 4096) };
}

function sanitizeFolder(value: BackupBookmarkFolder): BackupBookmarkFolder {
  return { id: value.id.slice(0, 200), parentId: value.parentId?.slice(0, 200), title: value.title.slice(0, 500), order: Math.max(0, Math.min(10_000, Math.trunc(value.order))) };
}
