import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isEncryptedField, isVaultEnvelope, serializeVaultArchive } from './security/vault-crypto.js';
import type { EncryptedField, VaultEnvelope } from './types.js';

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface BrokerConnectionState {
  endpoint: string;
  deviceToken: string;
  remoteVersion: number;
  dirty: boolean;
  lastSyncAt?: string;
}

/**
 * The data key wrapped a second time under a Windows Hello-derived key. It is a
 * convenience copy: the master-password wrap in the envelope stays authoritative,
 * so an unreadable record is discarded rather than blocking the vault.
 */
export interface PlatformUnlockRecord {
  version: 1;
  vaultId: string;
  keyName: string;
  challenge: string;
  hkdfSalt: string;
  wrappedKey: EncryptedField;
  createdAt: string;
}

export type StoreBlockReason = 'envelope-corrupt' | 'envelope-unsupported' | 'connection-corrupt';

export interface StoreSnapshot {
  envelope?: VaultEnvelope;
  connection?: BrokerConnectionState;
  blocked?: StoreBlockReason;
  recoveryPath?: string;
}

function timestampForPath(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

export function atomicWrite(filePath: string, value: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, value, { encoding: 'utf8', mode: 0o600 });
  const descriptor = openSync(temporaryPath, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, filePath);
}

function isConnectionState(value: unknown): value is BrokerConnectionState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<BrokerConnectionState>;
  return typeof state.endpoint === 'string'
    && /^https:\/\//.test(state.endpoint)
    && typeof state.deviceToken === 'string'
    && /^mvd_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/.test(state.deviceToken)
    && Number.isSafeInteger(state.remoteVersion)
    && Number(state.remoteVersion) >= 0
    && typeof state.dirty === 'boolean'
    && (state.lastSyncAt === undefined || typeof state.lastSyncAt === 'string');
}

const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

function isPlatformUnlockRecord(value: unknown): value is PlatformUnlockRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<PlatformUnlockRecord>;
  return record.version === 1
    && typeof record.vaultId === 'string'
    && typeof record.keyName === 'string'
    && typeof record.challenge === 'string' && BASE64_32_BYTES.test(record.challenge)
    && typeof record.hkdfSalt === 'string' && BASE64_32_BYTES.test(record.hkdfSalt)
    && isEncryptedField(record.wrappedKey)
    && typeof record.createdAt === 'string';
}

/** Owns only ciphertext and OS-protected connection state; it never sees plaintext vault data. */
export class MyVaultDiskStore {
  readonly envelopePath: string;
  readonly connectionPath: string;
  readonly platformUnlockPath: string;
  private blocked?: StoreBlockReason;
  private recoveryPath?: string;

  constructor(
    rootDirectory: string,
    private readonly safeStorage: SafeStorageAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {
    const directory = join(rootDirectory, 'myvault');
    this.envelopePath = join(directory, 'envelope.myvault');
    this.connectionPath = join(directory, 'connection.enc');
    this.platformUnlockPath = join(directory, 'platform-unlock.enc');
  }

  load(): StoreSnapshot {
    const envelope = this.loadEnvelope();
    const connection = this.loadConnection();
    return { envelope, connection, blocked: this.blocked, recoveryPath: this.recoveryPath };
  }

  isCredentialPersistenceAvailable(): boolean {
    return this.safeStorage.isEncryptionAvailable();
  }

  writeEnvelope(envelope: VaultEnvelope): void {
    this.assertWritable();
    if (!isVaultEnvelope(envelope)) throw new Error('Unsupported MyVault envelope');
    atomicWrite(this.envelopePath, serializeVaultArchive(envelope));
  }

  writeConnection(connection: BrokerConnectionState): void {
    this.assertWritable();
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure operating-system credential storage is unavailable');
    }
    if (!isConnectionState(connection)) throw new Error('Invalid MyVault connection state');
    const encrypted = this.safeStorage.encryptString(JSON.stringify(connection));
    atomicWrite(this.connectionPath, encrypted.toString('base64'));
  }

  readPlatformUnlock(): PlatformUnlockRecord | undefined {
    if (!existsSync(this.platformUnlockPath) || !this.safeStorage.isEncryptionAvailable()) return undefined;
    try {
      const encoded = readFileSync(this.platformUnlockPath, 'utf8');
      const parsed: unknown = JSON.parse(this.safeStorage.decryptString(Buffer.from(encoded, 'base64')));
      if (isPlatformUnlockRecord(parsed)) return parsed;
    } catch {
      // Unreadable: fall through and discard it. The password path is unaffected.
    }
    this.deletePlatformUnlock();
    return undefined;
  }

  writePlatformUnlock(record: PlatformUnlockRecord): void {
    this.assertWritable();
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure operating-system credential storage is unavailable');
    }
    if (!isPlatformUnlockRecord(record)) throw new Error('Invalid Windows Hello unlock record');
    atomicWrite(this.platformUnlockPath, this.safeStorage.encryptString(JSON.stringify(record)).toString('base64'));
  }

  deletePlatformUnlock(): void {
    rmSync(this.platformUnlockPath, { force: true });
  }

  /** The caller must have shown and confirmed the recovery consequence first. */
  acknowledgeRecovery(): void {
    this.blocked = undefined;
    this.recoveryPath = undefined;
  }

  private loadEnvelope(): VaultEnvelope | undefined {
    if (!existsSync(this.envelopePath)) return undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.envelopePath, 'utf8'));
      if (!isVaultEnvelope(parsed)) {
        this.preserveAndBlock(this.envelopePath, 'envelope-unsupported');
        return undefined;
      }
      return parsed;
    } catch {
      this.preserveAndBlock(this.envelopePath, 'envelope-corrupt');
      return undefined;
    }
  }

  private loadConnection(): BrokerConnectionState | undefined {
    if (!existsSync(this.connectionPath)) return undefined;
    if (!this.safeStorage.isEncryptionAvailable()) return undefined;
    try {
      const encoded = readFileSync(this.connectionPath, 'utf8');
      const parsed: unknown = JSON.parse(this.safeStorage.decryptString(Buffer.from(encoded, 'base64')));
      if (!isConnectionState(parsed)) throw new Error('Invalid connection state');
      return parsed;
    } catch {
      this.preserveAndBlock(this.connectionPath, 'connection-corrupt');
      return undefined;
    }
  }

  private preserveAndBlock(filePath: string, reason: StoreBlockReason): void {
    if (this.blocked) return;
    const recoveryPath = `${filePath}.recovery-${timestampForPath(this.now())}`;
    renameSync(filePath, recoveryPath);
    this.blocked = reason;
    this.recoveryPath = recoveryPath;
  }

  private assertWritable(): void {
    if (this.blocked) throw new Error(`MyVault writes are blocked: ${this.blocked}`);
  }
}
