import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SafeStorageAdapter } from './account-store.js';
import type { AccountSpaceId, WorkspaceId } from './types.js';
import { bookmarkReplica, decryptBookmarkReplica, encryptBookmarkReplica, planBookmarkMerge, replicaDigest, resolveBookmarkMerge, type BookmarkConflict, type BookmarkReplica } from './bookmark-replica.js';
import { isDriveFileId, type BookmarkReplicaTransport } from './google-backup-transport.js';
import { atomicWrite } from './myvault/vault-store.js';

export type BookmarkSyncAction = 'status' | 'start' | 'export-pairing' | 'import-pairing' | 'review' | 'apply' | 'unpair';
export interface BookmarkSyncStatus { enabled: boolean; initializing: boolean; lastSyncedAt?: string }
export interface BookmarkSyncPreview {
  id: string;
  expiresAt: string;
  deviceBookmarks: number;
  pairedBookmarks: number;
  deviceOnlyBookmarks: number;
  removedHere: number;
  removedInPair: number;
  conflicts: BookmarkConflict[];
}

export interface BookmarkPairing {
  workspaceId: WorkspaceId;
  fileId: string;
  key: string;
}

interface Scope { id: AccountSpaceId; workspaceId: WorkspaceId; subject: string }
interface StoredPairing extends BookmarkPairing {
  version: 1;
  subject: string;
  initializing: boolean;
  lastSyncedAt?: string;
  baseline?: BookmarkReplica;
}

interface Review {
  id: string;
  scope: Scope;
  expires: number;
  pairing: StoredPairing;
  localDigest: string;
  remoteDigest: string;
  etag: string;
  plan: ReturnType<typeof planBookmarkMerge>;
}

const disabled: BookmarkSyncStatus = { enabled: false, initializing: false };
const fingerprint = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(key);

export class BookmarkSyncManager {
  private review?: Review;

  constructor(private readonly directory: string, private readonly encryption: SafeStorageAdapter, private readonly transport: BookmarkReplicaTransport) {}

  status(scope: Scope): BookmarkSyncStatus {
    const pairing = this.read(scope);
    return pairing ? { enabled: !pairing.initializing, initializing: pairing.initializing, lastSyncedAt: pairing.lastSyncedAt } : disabled;
  }

  clearReview(): void { this.review = undefined; }

  async start(scope: Scope, local: BookmarkReplica, signal: AbortSignal): Promise<BookmarkSyncStatus> {
    const old = this.read(scope);
    if (old && !old.initializing) throw new Error('This Account Space is already paired.');
    if (local.workspaceId !== scope.workspaceId || !this.encryption.isEncryptionAvailable()) throw new Error('Secure device storage is required to pair bookmarks.');
    signal.throwIfAborted();
    // Reserve the ID and persist the key before any upload. A retry probes the same object.
    const pairing: StoredPairing = old ?? { version: 1, workspaceId: scope.workspaceId, subject: scope.subject,
      fileId: await this.transport.reserve(scope.id, signal), key: randomBytes(32).toString('base64url'), initializing: true };
    signal.throwIfAborted();
    if (!old) this.write(scope, pairing);
    const key = Buffer.from(pairing.key, 'base64url');
    try {
      let remote = await this.transport.read(scope.id, pairing.fileId, signal);
      if (!remote) {
        await this.transport.create(scope.id, pairing.fileId, encryptBookmarkReplica(local, key), signal);
        remote = await this.transport.read(scope.id, pairing.fileId, signal);
      }
      if (!remote) throw new Error('Drive could not verify the initial library. Retry setup.');
      const baseline = decryptBookmarkReplica(remote.bytes, key, scope.workspaceId);
      signal.throwIfAborted();
      const lastSyncedAt = new Date().toISOString();
      this.write(scope, { ...pairing, baseline, initializing: false, lastSyncedAt });
      return { enabled: true, initializing: false, lastSyncedAt };
    } finally { key.fill(0); }
  }

  exportPair(scope: Scope): BookmarkPairing {
    const { fileId, key, workspaceId } = this.requirePairing(scope);
    return { fileId, key, workspaceId };
  }

  async importPair(scope: Scope, pair: BookmarkPairing, signal: AbortSignal): Promise<void> {
    if (this.read(scope)) throw new Error('Disconnect this device before importing a different pairing.');
    if (pair.workspaceId !== scope.workspaceId || !isDriveFileId(pair.fileId) || !validKey(pair.key)) throw new Error('Choose a pairing from the same workspace.');
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Secure device storage is required to pair bookmarks.');
    const remote = await this.transport.read(scope.id, pair.fileId, signal);
    if (!remote) throw new Error('Connect the Google account used to create the bookmark pairing.');
    const key = Buffer.from(pair.key, 'base64url');
    try { decryptBookmarkReplica(remote.bytes, key, scope.workspaceId); } finally { key.fill(0); }
    signal.throwIfAborted();
    this.write(scope, { ...pair, version: 1, subject: scope.subject, initializing: false });
  }

  async prepare(scope: Scope, local: BookmarkReplica, deviceOnlyBookmarks: number, signal: AbortSignal): Promise<BookmarkSyncPreview> {
    this.clearReview();
    const pairing = this.requirePairing(scope);
    const remote = await this.transport.read(scope.id, pairing.fileId, signal);
    if (!remote) throw new Error('The paired bookmark library is unavailable.');
    const key = Buffer.from(pairing.key, 'base64url');
    let remoteData: BookmarkReplica;
    try { remoteData = decryptBookmarkReplica(remote.bytes, key, scope.workspaceId); } finally { key.fill(0); }
    const plan = planBookmarkMerge(pairing.baseline, local, remoteData);
    if (plan.conflicts.size > 100) throw new Error('Resolve some bookmark differences on one device and review again.');
    signal.throwIfAborted();
    const id = randomUUID();
    const expires = Date.now() + 2 * 60_000;
    this.review = { id, scope, expires, pairing, localDigest: replicaDigest(local), remoteDigest: fingerprint(remote.bytes), etag: remote.etag, plan };
    const removed = (current: BookmarkReplica) => {
      const ids = new Set(current.bookmarks.map(({ id }) => id));
      return pairing.baseline?.bookmarks.filter(({ id }) => !ids.has(id)).length ?? 0;
    };
    return { id, expiresAt: new Date(expires).toISOString(), deviceBookmarks: local.bookmarks.length, pairedBookmarks: remoteData.bookmarks.length,
      deviceOnlyBookmarks, removedHere: removed(local), removedInPair: removed(remoteData), conflicts: [...plan.conflicts.values()].map(({ item }) => item) };
  }

  async apply(scope: Scope, id: string, choice: 'local' | 'remote' | undefined,
    readLocal: () => BookmarkReplica, applyLocal: (replica: BookmarkReplica) => void, signal: AbortSignal): Promise<BookmarkSyncStatus> {
    const preview = this.review;
    this.clearReview();
    if (!preview || preview.id !== id || preview.expires <= Date.now() || preview.scope.id !== scope.id
      || preview.scope.subject !== scope.subject || preview.scope.workspaceId !== scope.workspaceId) throw new Error('Review the paired bookmarks again.');
    const pairing = this.requirePairing(scope);
    if (pairing.fileId !== preview.pairing.fileId || pairing.key !== preview.pairing.key || replicaDigest(readLocal()) !== preview.localDigest) {
      throw new Error('Local bookmarks changed. Review sync again.');
    }
    const merged = resolveBookmarkMerge(scope.workspaceId, preview.plan, choice);
    const remote = await this.transport.read(scope.id, pairing.fileId, signal);
    if (!remote || remote.etag !== preview.etag || fingerprint(remote.bytes) !== preview.remoteDigest
      || preview.expires <= Date.now() || replicaDigest(readLocal()) !== preview.localDigest) throw new Error('Bookmarks changed after review. Review sync again.');
    signal.throwIfAborted();
    let written = false;
    const key = Buffer.from(pairing.key, 'base64url');
    try {
      const before = decryptBookmarkReplica(remote.bytes, key, scope.workspaceId);
      if (replicaDigest(before) !== replicaDigest(merged)) {
        await this.transport.save(scope.id, pairing.fileId, remote.etag, encryptBookmarkReplica(merged, key), signal);
        written = true;
      }
    } finally { key.fill(0); }
    signal.throwIfAborted();
    if (replicaDigest(readLocal()) !== preview.localDigest) {
      throw new Error(written ? 'The paired library was saved. Local bookmarks changed during transfer. Review sync again.' : 'Local bookmarks changed. Review sync again.');
    }
    applyLocal(merged);
    const lastSyncedAt = new Date().toISOString();
    this.write(scope, { ...pairing, lastSyncedAt, baseline: merged });
    return { enabled: true, initializing: false, lastSyncedAt };
  }

  disconnect(scope: Scope): void {
    this.clearReview();
    if (this.read(scope)) unlinkSync(this.path(scope.id));
  }

  private path(id: AccountSpaceId): string { return join(this.directory, id + '.enc'); }

  private read(scope: Scope): StoredPairing | undefined {
    const path = this.path(scope.id);
    if (!existsSync(path)) return undefined;
    try {
      if (!this.encryption.isEncryptionAvailable() || statSync(path).size > 8_000_000) throw new Error('Pairing is unavailable');
      const payload = this.encryption.decryptString(Buffer.from(readFileSync(path, 'utf8'), 'base64'));
      const value = JSON.parse(payload) as StoredPairing;
      if (value.version !== 1 || value.workspaceId !== scope.workspaceId || value.subject !== scope.subject || !isDriveFileId(value.fileId)
        || !validKey(value.key) || typeof value.initializing !== 'boolean') throw new Error('Invalid pairing');
      if (value.baseline) value.baseline = bookmarkReplica(scope.workspaceId, value.baseline.bookmarks, value.baseline.folders);
      return value;
    } catch { throw new Error('This device cannot open the bookmark pairing. The recovery file and paired library are preserved.'); }
  }

  private requirePairing(scope: Scope): StoredPairing {
    const pairing = this.read(scope);
    if (!pairing || pairing.initializing) throw new Error('Finish pairing this Account Space first.');
    return pairing;
  }

  private write(scope: Scope, value: StoredPairing): void {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Secure device storage is required to pair bookmarks.');
    const encrypted = this.encryption.encryptString(JSON.stringify(value)).toString('base64');
    if (encrypted.length > 8_000_000) throw new Error('This bookmark library exceeds the pairing storage limit.');
    atomicWrite(this.path(scope.id), encrypted);
  }
}
