import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AccountSpaceBookmark, AccountSpaceId, BrowserTab, HistoryEntry } from './types.js';
import { AccountStore, type SafeStorageAdapter } from './account-store.js';

const BACKUP_AAD = Buffer.from('private-browser-account-space-backup:v1', 'utf8');
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

export interface BackupBookmarkFolder {
  id: string;
  parentId?: string;
  title: string;
  order: number;
}

export interface AccountBackupPayload {
  version: 1;
  createdAt: string;
  bookmarks: AccountSpaceBookmark[];
  bookmarkFolders: BackupBookmarkFolder[];
  settings: { trackerBlocking: boolean };
  openTabs?: Array<Pick<BrowserTab, 'id' | 'workspaceId' | 'accountSpaceId' | 'title' | 'url' | 'isHome'>>;
  history?: HistoryEntry[];
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
      account.backup = { enabled: true, wrappedRecoveryKey, includeOpenTabs, includeHistory };
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
      trackerBlocking: boolean;
      openTabs: BrowserTab[];
      history: HistoryEntry[];
    },
  ): AccountBackupPayload {
    const account = this.accounts.require(accountSpaceId);
    const bookmarks = value.bookmarks.filter((item) => item.accountSpaceId === accountSpaceId && item.workspaceId === account.workspaceId).map(sanitizeBookmark);
    const bookmarkFolders = (value.bookmarkFolders ?? []).slice(0, 1000).map(sanitizeFolder);
    const payload: AccountBackupPayload = {
      version: 1,
      createdAt: this.now().toISOString(),
      bookmarks,
      bookmarkFolders,
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

  async upload(
    accountSpaceId: AccountSpaceId,
    payload: AccountBackupPayload,
    conflictResolution?: 'merge' | 'overwrite',
    signal?: AbortSignal,
  ): Promise<BackupWriteResult> {
    const account = this.accounts.require(accountSpaceId);
    const key = this.unwrapLocalKey(accountSpaceId);
    try {
      const remote = await this.transport.read(accountSpaceId, signal);
      if (remote && remote.etag !== account.backup.remoteEtag && !conflictResolution) {
        return { status: 'conflict', localEtag: account.backup.remoteEtag, remoteEtag: remote.etag };
      }
      const nextPayload = remote && conflictResolution === 'merge'
        ? mergePayloads(decryptBackupEnvelope(parseEnvelope(remote.bytes), key), payload)
        : payload;
      const envelope = encryptBackupPayload(nextPayload, key);
      const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
      if (bytes.byteLength > MAX_BACKUP_BYTES) throw new Error('Encrypted backup exceeds its size limit');
      const written = await this.transport.write(accountSpaceId, bytes, remote && conflictResolution !== 'overwrite' ? remote.etag : undefined, signal);
      this.accounts.update(accountSpaceId, (record) => {
        record.backup.remoteEtag = written.etag;
        record.backup.remoteFileId = written.fileId;
      });
      return { status: 'uploaded', etag: written.etag };
    } finally {
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
  if (!value || typeof value !== 'object') throw new Error('Invalid backup payload');
  const payload = value as Partial<AccountBackupPayload>;
  if (payload.version !== 1 || typeof payload.createdAt !== 'string' || !Array.isArray(payload.bookmarks) || !Array.isArray(payload.bookmarkFolders) || !payload.settings || typeof payload.settings.trackerBlocking !== 'boolean') throw new Error('Invalid backup payload');
  if (payload.openTabs && !Array.isArray(payload.openTabs)) throw new Error('Invalid backup tabs');
  if (payload.history && !Array.isArray(payload.history)) throw new Error('Invalid backup history');
  return payload as AccountBackupPayload;
}

function mergePayloads(remote: AccountBackupPayload, local: AccountBackupPayload): AccountBackupPayload {
  return {
    ...local,
    bookmarks: mergeById(remote.bookmarks, local.bookmarks),
    bookmarkFolders: mergeById(remote.bookmarkFolders, local.bookmarkFolders),
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
