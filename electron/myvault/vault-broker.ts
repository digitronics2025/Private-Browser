import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto';
import { isAllowedRemoteUrl } from '../security.js';
import type { VaultHealthFinding, VaultHealthIssue, VaultHealthReport } from '../types.js';
import { BiometricUnlockRejectedError, isVaultEnvelope, base64ToBytes, bytesToBase64, decryptWithSession, deriveBiometricUnlockKey, encryptVaultPayload, prepareBiometricWrap, randomBytes, unlockVault, unlockVaultWithBiometricKey, type VaultSession } from './security/vault-crypto.js';
import type { TotpConfig, VaultEnvelope, VaultItem, VaultPayload } from './types.js';
import type { PasskeyCredential } from './security/passkeys/types.js';
import { isConnectionState, MyVaultDiskStore, type BrokerConnectionState, type StoreBlockReason } from './vault-store.js';
import { PlatformUnlockError, platformUnlockKeyName, type PlatformUnlockSigner } from './windows-hello.js';
import { planVaultEntrySelection, reconcileVaultItems, type VaultEntryDecision, type VaultEntryDifference } from './conflict-items.js';

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

interface ConflictEntryMetadata extends Omit<VaultEntryMetadata, 'type' | 'hasPassword' | 'hasTotp'> {
  type: VaultItem['type'] | 'passkey';
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
  platformUnlockEnrolled: boolean;
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

export interface RemoteVaultSnapshot { envelope: VaultEnvelope; version: number; updatedAt: string }

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

function markCollision(seen: Map<string, VaultHealthFinding>, key: string, finding: VaultHealthFinding, issue: VaultHealthIssue): void {
  const earlier = seen.get(key);
  if (!earlier) {
    seen.set(key, finding);
    return;
  }
  if (!earlier.issues.includes(issue)) earlier.issues.push(issue);
  finding.issues.push(issue);
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
  private platformEnrolled = false;
  private conflictRemote?: { envelope: VaultEnvelope; version: number; updatedAt: string };
  private readonly listeners = new Set<(status: BrokerStatus) => void>();
  /**
   * Mutations and accepted pulls run one at a time. Each reads the current
   * payload and envelope and writes the next ones, so two of them interleaving
   * across an encryption await would silently drop one side's change.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly store: MyVaultDiskStore) {}

  initialize(): BrokerStatus {
    const snapshot = this.store.load();
    this.envelope = snapshot.envelope;
    this.connection = snapshot.connection;
    this.blockedReason = snapshot.blocked;
    this.recoveryPath = snapshot.recoveryPath;
    this.lifecycle = snapshot.blocked ? 'recovery-required' : snapshot.envelope ? 'locked' : 'unconfigured';
    this.syncState = snapshot.connection ? snapshot.connection.dirty ? 'dirty' : 'idle' : 'disabled';
    this.refreshPlatformUnlock();
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
      platformUnlockEnrolled: this.platformEnrolled,
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
    // Validate both halves before writing either, so a bad connection can never
    // leave a replaced envelope on disk with nothing to sync it.
    if (!isVaultEnvelope(envelope) || !isConnectionState(connection)) throw new Error('Invalid MyVault installation');
    this.store.writeEnvelope(envelope);
    this.store.writeConnection(connection);
    if (this.envelope?.vaultId !== envelope.vaultId) this.store.deletePlatformUnlock();
    this.envelope = envelope;
    this.connection = connection;
    this.refreshPlatformUnlock();
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

  /**
   * Windows Hello unlock. Enrollment takes the master password even though the
   * vault is already open: binding a device gesture to the vault is an
   * authorization decision for whoever knows the password, not for whoever sits
   * at an unlocked session. The password is checked before the Hello prompt, so
   * a typo costs no gesture and leaves no orphan key.
   */
  async enrollPlatformUnlock(masterPassword: string, signer: PlatformUnlockSigner): Promise<BrokerStatus> {
    this.requireUnlocked();
    if (!this.envelope) throw new Error('MyVault is not configured');
    const envelope = this.envelope;
    const keyName = platformUnlockKeyName(envelope.vaultId);
    const challenge = randomBytes(32);
    const hkdfSalt = randomBytes(32);
    const prepared = await prepareBiometricWrap(masterPassword, envelope);
    let wrappedKey;
    try {
      const signature = await signer.enroll(keyName, challenge);
      wrappedKey = await prepared.wrap(await deriveBiometricUnlockKey(signature, hkdfSalt, envelope.vaultId));
    } catch (error) {
      prepared.dispose();
      throw error;
    }
    this.store.writePlatformUnlock({
      version: 1,
      vaultId: envelope.vaultId,
      keyName,
      challenge: bytesToBase64(challenge),
      hkdfSalt: bytesToBase64(hkdfSalt),
      wrappedKey,
      createdAt: new Date().toISOString(),
    });
    this.refreshPlatformUnlock();
    this.changed();
    return this.status();
  }

  async unlockWithPlatform(signer: PlatformUnlockSigner): Promise<BrokerStatus> {
    if (this.lifecycle === 'recovery-required') throw new Error('Recovery acknowledgement is required');
    if (!this.envelope) throw new Error('MyVault is not configured');
    const record = this.store.readPlatformUnlock();
    if (!record || record.vaultId !== this.envelope.vaultId) {
      if (record) this.store.deletePlatformUnlock();
      this.refreshPlatformUnlock();
      this.changed();
      throw new Error('Windows Hello is not set up for this vault. Unlock with the master password.');
    }
    const envelope = this.envelope;
    try {
      const signature = await signer.sign(record.keyName, base64ToBytes(record.challenge));
      const key = await deriveBiometricUnlockKey(signature, base64ToBytes(record.hkdfSalt), envelope.vaultId);
      const unlocked = await unlockVaultWithBiometricKey(record.wrappedKey, key, envelope);
      if (this.envelope !== envelope) throw new Error('MyVault changed while Windows Hello was open. Try again.');
      this.payload = unlocked.payload;
      this.session = unlocked.session;
      this.lifecycle = 'unlocked';
      this.changed();
      return this.status();
    } catch (error) {
      // A stale enrollment can never succeed again; drop it so the panel stops offering it.
      if (error instanceof BiometricUnlockRejectedError || (error instanceof PlatformUnlockError && error.status === 'NotFound')) {
        this.store.deletePlatformUnlock();
        this.refreshPlatformUnlock();
        this.changed();
      }
      throw error;
    }
  }

  async removePlatformUnlock(signer: PlatformUnlockSigner): Promise<BrokerStatus> {
    const record = this.store.readPlatformUnlock();
    this.store.deletePlatformUnlock();
    this.refreshPlatformUnlock();
    if (record) await signer.remove(record.keyName);
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

  checkLoginHealth(): VaultHealthReport {
    const logins = this.requireUnlocked().items.filter((item) => item.type === 'login');
    const byLogin = new Map<string, VaultHealthFinding>();
    const byPassword = new Map<string, VaultHealthFinding>();
    const key = randomBytes(32);
    try {
      const findings = logins.map((item): VaultHealthFinding => {
        const finding: VaultHealthFinding = { id: item.id, issues: [] };
        const origin = item.url && isAllowedRemoteUrl(item.url) ? exactOrigin(item.url) : undefined;
        if (!origin) finding.issues.push('missing-origin');
        if (origin && item.username.trim()) {
          const username = item.username.normalize('NFKC').trim();
          markCollision(byLogin, JSON.stringify([origin, username]), finding, 'duplicate-login');
        }
        if (item.password) {
          const characters = [...item.password];
          if (characters.length < 15 || characters.every((character) => character === characters[0])) finding.issues.push('weak-password');
          const digest = createHmac('sha256', key).update(item.password, 'utf16le').digest('base64url');
          markCollision(byPassword, digest, finding, 'reused-password');
        }
        return finding;
      }).filter((finding) => finding.issues.length > 0);
      return { checked: logins.length, findings };
    } finally {
      key.fill(0);
    }
  }

  beginLoginEdit(id: string) {
    const original = this.requireUnlocked().items.find((item) => item.id === id && item.type === 'login');
    if (!original) throw new Error('This login is no longer available.');
    const session = this.session;
    return {
      metadata: metadata(original),
      save: (input: Omit<BrokerItemInput, 'id'>) => this.exclusive(() => {
        if (this.session !== session || !this.requireUnlocked().items.includes(original)) {
          throw new Error('This login changed. Reopen it before saving.');
        }
        return this.saveLoginNow({ ...input, id });
      }),
    };
  }

  loginRevision(): string {
    const logins = this.requireUnlocked().items.filter((item) => item.type === 'login')
      .map(({ id, url, username, updatedAt }) => ({ id, url, username, updatedAt }))
      .sort((a, b) => a.id.localeCompare(b.id));
    return createHash('sha256').update(JSON.stringify([this.envelope?.vaultId, this.generation, logins])).digest('hex');
  }

  saveLogin(input: BrokerItemInput): Promise<VaultEntryMetadata> {
    return this.exclusive(() => this.saveLoginNow(input));
  }

  /**
   * Adds many new logins in one encrypted write. An import of thousands of rows
   * would otherwise re-encrypt and fsync the whole vault once per row.
   */
  importLogins(inputs: readonly BrokerItemInput[], expectedRevision?: string): Promise<VaultEntryMetadata[]> {
    return this.exclusive(async () => {
      if (expectedRevision !== undefined && this.loginRevision() !== expectedRevision) {
        throw new Error('MyVault changed. Review the password file again.');
      }
      const payload = this.requireUnlocked();
      const timestamp = new Date().toISOString();
      const added = inputs.map((input): VaultItem => ({
        id: randomUUID(),
        title: input.title.normalize('NFKC').trim(),
        type: 'login',
        username: input.username.normalize('NFKC').trim(),
        password: input.password,
        url: exactOrigin(input.url),
        folder: '',
        vault: 'Personal',
        favorite: false,
        tags: [],
        updatedAt: input.updatedAt && Number.isFinite(Date.parse(input.updatedAt)) ? input.updatedAt : timestamp,
        totp: input.totp,
        notes: input.notes,
      }));
      if (added.some((item) => !item.title || !item.url)) throw new Error('A title and valid HTTP(S) origin are required');
      if (!added.length) return [];
      await this.persistMutation({ ...payload, items: [...added, ...payload.items], updatedAt: timestamp });
      return added.map(metadata);
    });
  }

  private async saveLoginNow(input: BrokerItemInput): Promise<VaultEntryMetadata> {
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

  deleteEntry(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      const payload = this.requireUnlocked();
      const items = payload.items.filter((item) => item.id !== id);
      if (items.length === payload.items.length) return false;
      await this.persistMutation({ ...payload, items, updatedAt: new Date().toISOString() });
      return true;
    });
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

  generateCredential(kind: GeneratedCredentialKind, options: { length?: 8 | 16 | 24 | 36; symbols?: boolean } = {}): string {
    this.requireUnlocked();
    if (kind === 'pin') return Array.from({ length: 8 }, () => randomInt(10)).join('');
    if (kind === 'passphrase') return Array.from({ length: options.length === 16 ? 16 : 6 }, () => PASSPHRASE_WORDS[randomInt(PASSPHRASE_WORDS.length)]).join('-');
    const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*_-+='];
    if (options.symbols === false) groups.pop();
    const required = groups.map((group) => group[randomInt(group.length)]);
    const alphabet = groups.join('');
    const length = options.length === 36 ? 36 : 24;
    const value = [...required, ...Array.from({ length: length - required.length }, () => alphabet[randomInt(alphabet.length)])];
    for (let index = value.length - 1; index > 0; index -= 1) {
      const swap = randomInt(index + 1);
      [value[index], value[swap]] = [value[swap], value[index]];
    }
    return value.join('');
  }

  passkeysForRpId(rpId: string): readonly PasskeyCredential[] {
    return this.requireUnlocked().passkeys.filter((passkey) => passkey.rpId === rpId);
  }

  appendImmutablePasskey(record: PasskeyCredential): Promise<void> {
    return this.exclusive(async () => {
      const payload = this.requireUnlocked();
      if (payload.passkeys.some((passkey) => passkey.id === record.id)) throw new Error('A passkey with this immutable id already exists');
      await this.persistMutation({ ...payload, passkeys: [...payload.passkeys, Object.freeze({ ...record })], updatedAt: new Date().toISOString() });
    });
  }

  /** A conflict found while locked is recorded but never re-opens the vault. */
  markConflict(): void {
    this.syncState = 'conflict';
    if (this.session) this.lifecycle = 'conflict';
    this.changed();
  }

  trustedSyncSnapshot(): { envelope: VaultEnvelope; connection: BrokerConnectionState; generation: number } {
    if (!this.payload || !this.session || !this.envelope || !this.connection) throw new Error('MyVault is not connected and unlocked');
    return { envelope: this.envelope, connection: { ...this.connection }, generation: this.generation };
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

  /**
   * Replaces the local vault with a pulled one.
   *
   * `basis` is the local envelope the pull started from. If a mutation landed
   * since, replacing it would erase that change, so the pull becomes an explicit
   * conflict instead (vault.md invariant 3). A lock during decrypt wins.
   */
  acceptRemote(remote: RemoteVaultSnapshot, options: { basis?: VaultEnvelope; syncedAt?: string; assertOwner?: () => void } = {}): Promise<'accepted' | 'conflict'> {
    return this.exclusive(async () => {
      const session = this.session;
      if (!session || !this.connection || !this.envelope) throw new Error('MyVault is locked');
      if (options.basis && this.envelope !== options.basis) {
        this.setConflict(remote);
        return 'conflict';
      }
      const payload = await decryptWithSession(remote.envelope, session);
      if (this.session !== session) throw new Error('MyVault is locked');
      options.assertOwner?.();
      const connection = { ...this.connection, remoteVersion: remote.version, dirty: false, lastSyncAt: options.syncedAt ?? new Date().toISOString() };
      this.store.writeEnvelope(remote.envelope);
      try { this.store.writeConnection(connection); }
      catch (error) {
        this.store.writeEnvelope(this.envelope);
        throw error;
      }
      this.envelope = remote.envelope;
      this.payload = payload;
      this.connection = connection;
      this.lifecycle = 'unlocked';
      this.syncState = 'synced';
      this.conflictRemote = undefined;
      this.changed();
      return 'accepted';
    });
  }

  /** Records a successful push. It updates sync metadata only; a lock that happened meanwhile stays in force. */
  markPushSucceeded(pushedEnvelope: VaultEnvelope, version: number, syncedAt = new Date().toISOString()): void {
    if (!this.connection || !this.envelope) throw new Error('MyVault is not connected');
    const changedDuringSync = this.envelope.payload.ciphertext !== pushedEnvelope.payload.ciphertext;
    const connection = { ...this.connection, remoteVersion: version, dirty: changedDuringSync, lastSyncAt: syncedAt };
    this.store.writeConnection(connection);
    this.connection = connection;
    if (this.lifecycle === 'conflict' && this.session) this.lifecycle = 'unlocked';
    this.syncState = changedDuringSync ? 'dirty' : 'synced';
    this.conflictRemote = undefined;
    this.changed();
  }

  setConflict(remote: RemoteVaultSnapshot): void {
    this.conflictRemote = remote;
    this.markConflict();
  }

  async conflictReview(): Promise<{ local: ConflictEntryMetadata[]; cloud: ConflictEntryMetadata[]; localUpdatedAt: string; cloudUpdatedAt: string; itemChoices?: VaultEntryDifference[] }> {
    const { session, conflictRemote, envelope, payload } = this;
    if (!conflictRemote || !session || !envelope || !payload) throw new Error('No MyVault conflict is pending');
    const cloud = await decryptWithSession(conflictRemote.envelope, session);
    if (this.session !== session || this.envelope !== envelope || this.conflictRemote !== conflictRemote) throw new Error('The conflict changed. Review it again.');
    const review = (copy: VaultPayload): ConflictEntryMetadata[] => [
      ...copy.items.map(({ id, title, type, username, url, favorite, updatedAt }) => ({ id, title, type, username, url, favorite, updatedAt })),
      ...copy.passkeys.map((passkey): ConflictEntryMetadata => ({ id: 'passkey-' + createHash('sha256').update(passkey.id).digest('hex'),
        title: 'Passkey for ' + passkey.rpId, type: 'passkey', username: passkey.userName, favorite: false, updatedAt: passkey.createdAt })),
    ];
    return { local: review(payload), cloud: review(cloud),
      localUpdatedAt: envelope.updatedAt, cloudUpdatedAt: conflictRemote.updatedAt,
      itemChoices: planVaultEntrySelection(payload, cloud)?.choices.map(({ metadata }) => metadata) };
  }

  async prepareVaultEntryResolution(basis: VaultEnvelope, cloud: VaultEnvelope, choices: VaultEntryDecision[]): Promise<VaultEnvelope> {
    const { session, envelope, payload } = this;
    if (!session || !payload || envelope !== basis || !this.conflictRemote) throw new Error('The conflict changed. Review it again.');
    const remote = await decryptWithSession(cloud, session);
    if (this.session !== session || this.envelope !== envelope || this.payload !== payload) throw new Error('The conflict changed. Review it again.');
    const result = reconcileVaultItems(payload, remote, choices);
    const encrypted = await encryptVaultPayload(result, envelope, session);
    if (this.session !== session || this.envelope !== envelope || this.payload !== payload) throw new Error('The conflict changed. Review it again.');
    return encrypted;
  }

  saveConflictRecovery(local: VaultEnvelope, cloud: VaultEnvelope): void {
    if (!this.session || this.envelope !== local || !this.conflictRemote) throw new Error('The conflict changed. Review it again.');
    this.store.saveConflictRecovery(local, cloud);
  }

  conflictRecoveryFolder(): string | undefined {
    return this.store.hasConflictRecovery() ? this.store.conflictRecoveryPath : undefined;
  }

  pendingConflict() {
    if (!this.conflictRemote) throw new Error('No MyVault conflict is pending');
    return this.conflictRemote;
  }

  /** Callers hold the write queue, so the envelope read here is still current when the result is written. */
  private async persistMutation(payload: VaultPayload): Promise<void> {
    const session = this.session;
    if (!this.envelope || !session || !this.connection) throw new Error('MyVault is not connected and unlocked');
    const nextEnvelope = await encryptVaultPayload(payload, this.envelope, session);
    const nextConnection = { ...this.connection, dirty: true };
    this.store.writeEnvelope(nextEnvelope);
    this.store.writeConnection(nextConnection);
    // The save was asked for before any lock, so it is kept on disk; a lock that
    // landed during the encryption keeps the decrypted payload released.
    if (this.session === session) this.payload = { ...payload, updatedAt: nextEnvelope.updatedAt };
    this.envelope = nextEnvelope;
    this.connection = nextConnection;
    this.syncState = 'dirty';
    this.changed();
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private requireUnlocked(): VaultPayload {
    if (this.lifecycle !== 'unlocked' || !this.payload || !this.session) throw new Error('MyVault is locked');
    return this.payload;
  }

  private refreshPlatformUnlock(): void {
    this.platformEnrolled = Boolean(this.envelope && this.store.readPlatformUnlock()?.vaultId === this.envelope.vaultId);
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
