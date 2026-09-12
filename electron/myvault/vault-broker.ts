import { randomInt, randomUUID } from 'node:crypto';
import { decryptWithSession, encryptVaultPayload, unlockVault, type VaultSession } from './security/vault-crypto.js';
import type { TotpConfig, VaultEnvelope, VaultItem, VaultPayload } from './types.js';
import type { PasskeyCredential } from './security/passkeys/types.js';
import { MyVaultDiskStore, type BrokerConnectionState, type StoreBlockReason } from './vault-store.js';

export type BrokerLifecycle = 'unconfigured' | 'locked' | 'unlocked' | 'conflict' | 'recovery-required';
export type BrokerSyncState = 'disabled' | 'idle' | 'dirty' | 'syncing' | 'synced' | 'conflict' | 'error';

export interface VaultEntryMetadata {
  id: string;
  title: string;
  type: VaultItem['type'];
  username: string;
  url?: string;
  favorite: boolean;
  hasPassword: boolean;
  hasTotp: boolean;
  updatedAt: string;
}

export interface BrokerStatus {
  lifecycle: BrokerLifecycle;
  sync: BrokerSyncState;
  configured: boolean;
  credentialPersistenceAvailable: boolean;
  dirty: boolean;
  remoteVersion?: number;
  lastSyncAt?: string;
  blockedReason?: StoreBlockReason;
  recoveryPath?: string;
  generation: number;
}

export interface BrokerItemInput {
  id?: string;
  title: string;
  username: string;
  password?: string;
  url?: string;
  totp?: TotpConfig;
  notes?: string;
  updatedAt?: string;
}

export type TrustedSecretKind = 'username' | 'password' | 'totp-secret';
export type GeneratedCredentialKind = 'password' | 'passphrase' | 'pin';

const PASSPHRASE_WORDS = ['amber', 'anchor', 'atlas', 'birch', 'canyon', 'cedar', 'cobalt', 'coral', 'ember', 'falcon', 'fjord', 'harbor', 'indigo', 'juniper', 'lantern', 'maple', 'meadow', 'nebula', 'olive', 'orbit', 'pebble', 'quartz', 'river', 'saffron', 'summit', 'tulip', 'velvet', 'willow', 'zephyr'];

function metadata(item: VaultItem): VaultEntryMetadata {
  return {
    id: item.id,
    title: item.title,
    type: item.type,
    username: item.username,
    url: item.url,
    favorite: item.favorite,
    hasPassword: Boolean(item.password),
    hasTotp: Boolean(item.totp),
    updatedAt: item.updatedAt,
  };
}

function normalizeSearch(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function exactOrigin(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Singleton trusted boundary for decrypted state. Renderer IPC must expose intents, never its secret resolver. */
export class VaultBroker {
  private envelope?: VaultEnvelope;
  private connection?: BrokerConnectionState;
  private payload?: VaultPayload;
  private session?: VaultSession;
  private lifecycle: BrokerLifecycle = 'unconfigured';
  private syncState: BrokerSyncState = 'disabled';
  private blockedReason?: StoreBlockReason;
  private recoveryPath?: string;
  private generation = 0;
  private conflictRemote?: { envelope: VaultEnvelope; version: number; updatedAt: string };
  private readonly listeners = new Set<(status: BrokerStatus) => void>();

  constructor(private readonly store: MyVaultDiskStore) {}

  initialize(): BrokerStatus {
    const snapshot = this.store.load();
    this.envelope = snapshot.envelope;
    this.connection = snapshot.connection;
    this.blockedReason = snapshot.blocked;
    this.recoveryPath = snapshot.recoveryPath;
    this.lifecycle = snapshot.blocked ? 'recovery-required' : snapshot.envelope ? 'locked' : 'unconfigured';
    this.syncState = snapshot.connection ? snapshot.connection.dirty ? 'dirty' : 'idle' : 'disabled';
    return this.status();
  }

  status(): BrokerStatus {
    return {
      lifecycle: this.lifecycle,
      sync: this.syncState,
      configured: Boolean(this.envelope && this.connection),
      credentialPersistenceAvailable: this.store.isCredentialPersistenceAvailable(),
      dirty: this.connection?.dirty ?? false,
      remoteVersion: this.connection?.remoteVersion,
      lastSyncAt: this.connection?.lastSyncAt,
      blockedReason: this.blockedReason,
      recoveryPath: this.recoveryPath,
      generation: this.generation,
    };
  }

  subscribe(listener: (status: BrokerStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  installEncryptedVault(envelope: VaultEnvelope, connection: BrokerConnectionState): void {
    if (this.lifecycle === 'recovery-required') throw new Error('Recovery acknowledgement is required');
    if (!this.store.isCredentialPersistenceAvailable()) throw new Error('Secure operating-system credential storage is unavailable');
    this.store.writeEnvelope(envelope);
    this.store.writeConnection(connection);
    this.envelope = envelope;
    this.connection = connection;
    this.releaseSecrets();
    this.lifecycle = 'locked';
    this.syncState = connection.dirty ? 'dirty' : 'idle';
    this.changed();
  }

  acknowledgeRecovery(): void {
    this.store.acknowledgeRecovery();
    this.blockedReason = undefined;
    this.recoveryPath = undefined;
    this.lifecycle = this.envelope ? 'locked' : 'unconfigured';
    this.changed();
  }

  async unlock(masterPassword: string): Promise<BrokerStatus> {
    if (this.lifecycle === 'recovery-required') throw new Error('Recovery acknowledgement is required');
    if (!this.envelope) throw new Error('MyVault is not configured');
    const unlocked = await unlockVault(masterPassword, this.envelope);
    this.payload = unlocked.payload;
    this.session = unlocked.session;
    this.lifecycle = 'unlocked';
    this.changed();
    return this.status();
  }

  lock(): BrokerStatus {
    this.releaseSecrets();
    this.lifecycle = this.envelope ? 'locked' : 'unconfigured';
    this.generation += 1;
    this.changed();
    return this.status();
  }

  searchMetadata(query = '', origin?: string): VaultEntryMetadata[] {
    const payload = this.requireUnlocked();
    const needle = normalizeSearch(query);
    const requestedOrigin = exactOrigin(origin);
    return payload.items
      .filter((item) => item.type === 'login')
      .filter((item) => !requestedOrigin || exactOrigin(item.url) === requestedOrigin)
      .filter((item) => !needle || [item.title, item.username, item.url ?? '', ...item.tags].some((value) => normalizeSearch(value).includes(needle)))
      .map(metadata);
  }

  async saveLogin(input: BrokerItemInput): Promise<VaultEntryMetadata> {
    const payload = this.requireUnlocked();
    const timestamp = input.updatedAt && Number.isFinite(Date.parse(input.updatedAt)) ? input.updatedAt : new Date().toISOString();
    const current = input.id ? payload.items.find((item) => item.id === input.id) : undefined;
    const next: VaultItem = {
      id: current?.id ?? randomUUID(),
      title: input.title.normalize('NFKC').trim(),
      type: 'login',
      username: input.username.normalize('NFKC').trim(),
      password: input.password ?? current?.password,
      url: input.url ? exactOrigin(input.url) : current?.url,
      folder: current?.folder ?? '',
      vault: current?.vault ?? 'Personal',
      favorite: current?.favorite ?? false,
      tags: current?.tags ?? [],
      updatedAt: timestamp,
      totp: input.totp ?? current?.totp,
      notes: input.notes ?? current?.notes,
    };
    if (!next.title || !next.url) throw new Error('A title and valid HTTP(S) origin are required');
    const items = current ? payload.items.map((item) => item.id === current.id ? next : item) : [next, ...payload.items];
    await this.persistMutation({ ...payload, items, updatedAt: timestamp });
    return metadata(next);
  }

  async deleteEntry(id: string): Promise<boolean> {
    const payload = this.requireUnlocked();
    const items = payload.items.filter((item) => item.id !== id);
    if (items.length === payload.items.length) return false;
    await this.persistMutation({ ...payload, items, updatedAt: new Date().toISOString() });
    return true;
  }

  /** Trusted main-process operations only. Never bind this method to renderer IPC. */
  resolveSecretForTrustedOperation(id: string, kind: TrustedSecretKind): string {
    const item = this.requireUnlocked().items.find((candidate) => candidate.id === id);
    if (!item) throw new Error('Vault entry not found');
    if (kind === 'username') return item.username;
    if (kind === 'password' && item.password) return item.password;
    if (kind === 'totp-secret' && item.totp) return item.totp.secret;
    throw new Error('Requested secret is not available');
  }

  generateCredential(kind: GeneratedCredentialKind): string {
    this.requireUnlocked();
    if (kind === 'pin') return Array.from({ length: 8 }, () => randomInt(10)).join('');
    if (kind === 'passphrase') return Array.from({ length: 6 }, () => PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)]).join('-');
    const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*_-+='];
    const required = groups.map((group) => group[randomInt(group.length)]);
    const alphabet = groups.join('');
    const value = [...required, ...Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)])];
    for (let index = value.length - 1; index > 0; index -= 1) {
      const swap = randomInt(index + 1);
      [value[index], value[swap]] = [value[swap], value[index]];
    }
    return value.join('');
  }

  passkeysForRpId(rpId: string): readonly PasskeyCredential[] {
    return this.requireUnlocked().passkeys.filter((passkey) => passkey.rpId === rpId);
  }

  async appendImmutablePasskey(record: PasskeyCredential): Promise<void> {
    const payload = this.requireUnlocked();
    if (payload.passkeys.some((passkey) => passkey.id === record.id)) throw new Error('A passkey with this immutable id already exists');
    await this.persistMutation({ ...payload, passkeys: [...payload.passkeys, Object.freeze({ ...record })], updatedAt: new Date().toISOString() });
  }

  markConflict(): void {
    this.syncState = 'conflict';
    this.lifecycle = 'conflict';
    this.changed();
  }

  trustedSyncSnapshot(): { envelope: VaultEnvelope; connection: BrokerConnectionState } {
    if (!this.payload || !this.session || !this.envelope || !this.connection) throw new Error('MyVault is not connected and unlocked');
    return { envelope: this.envelope, connection: { ...this.connection } };
  }

  markSyncing(): void {
    if (!this.payload || !this.session) throw new Error('MyVault is locked');
    this.syncState = 'syncing';
    this.changed();
  }

  markSyncError(): void {
    if (this.lifecycle === 'unlocked') this.syncState = 'error';
    this.changed();
  }

  async acceptRemote(envelope: VaultEnvelope, version: number, syncedAt = new Date().toISOString()): Promise<void> {
    if (!this.session || !this.connection || !this.envelope) throw new Error('MyVault is locked');
    const payload = await decryptWithSession(envelope, this.session);
    const connection = { ...this.connection, remoteVersion: version, dirty: false, lastSyncAt: syncedAt };
    this.store.writeEnvelope(envelope);
    this.store.writeConnection(connection);
    this.envelope = envelope;
    this.payload = payload;
    this.connection = connection;
    this.lifecycle = 'unlocked';
    this.syncState = 'synced';
    this.conflictRemote = undefined;
    this.changed();
  }

  markPushSucceeded(pushedEnvelope: VaultEnvelope, version: number, syncedAt = new Date().toISOString()): void {
    if (!this.connection || !this.envelope) throw new Error('MyVault is not connected');
    const changedDuringSync = this.envelope.payload.ciphertext !== pushedEnvelope.payload.ciphertext;
    const connection = { ...this.connection, remoteVersion: version, dirty: changedDuringSync, lastSyncAt: syncedAt };
    this.store.writeConnection(connection);
    this.connection = connection;
    this.lifecycle = 'unlocked';
    this.syncState = changedDuringSync ? 'dirty' : 'synced';
    this.conflictRemote = undefined;
    this.changed();
  }

  setConflict(remote: { envelope: VaultEnvelope; version: number; updatedAt: string }): void {
    this.conflictRemote = remote;
    this.markConflict();
  }

  async conflictReview(): Promise<{ local: VaultEntryMetadata[]; cloud: VaultEntryMetadata[] }> {
    if (!this.conflictRemote || !this.session) throw new Error('No MyVault conflict is pending');
    const cloud = await decryptWithSession(this.conflictRemote.envelope, this.session);
    const local = this.payload;
    if (!local) throw new Error('MyVault is locked');
    return { local: local.items.map(metadata), cloud: cloud.items.map(metadata) };
  }

  pendingConflict() {
    if (!this.conflictRemote) throw new Error('No MyVault conflict is pending');
    return this.conflictRemote;
  }

  private async persistMutation(payload: VaultPayload): Promise<void> {
    if (!this.envelope || !this.session || !this.connection) throw new Error('MyVault is not connected and unlocked');
    const nextEnvelope = await encryptVaultPayload(payload, this.envelope, this.session);
    const nextConnection = { ...this.connection, dirty: true };
    this.store.writeEnvelope(nextEnvelope);
    this.store.writeConnection(nextConnection);
    this.payload = { ...payload, updatedAt: nextEnvelope.updatedAt };
    this.envelope = nextEnvelope;
    this.connection = nextConnection;
    this.syncState = 'dirty';
    this.changed();
  }

  private requireUnlocked(): VaultPayload {
    if (this.lifecycle !== 'unlocked' || !this.payload || !this.session) throw new Error('MyVault is locked');
    return this.payload;
  }

  private releaseSecrets(): void {
    this.payload = undefined;
    this.session = undefined;
  }

  private changed(): void {
    const snapshot = this.status();
    for (const listener of this.listeners) listener(snapshot);
  }
}
