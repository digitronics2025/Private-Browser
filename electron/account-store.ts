import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type {
  AccountSpaceColor,
  AccountSpaceId,
  AccountSpaceKind,
  AccountSpaceSummary,
  GoogleConnectionStatus,
  GoogleModule,
  PermissionCapability,
  WorkspaceId,
} from './types.js';
import {
  isAccountSpaceId,
  requireAccountColor,
  requireAccountLabel,
  requireExactWebOrigin,
  requireGoogleModules,
  requirePermissionCapability,
  requireWorkspaceId,
} from './account-space-validation.js';

const ACCOUNT_RECORD_VERSION = 1;
const MAX_AVATAR_BYTES = 512 * 1024;
const MAX_SCOPES = 64;
const MAX_SCOPE_LENGTH = 300;

export interface SafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface StoredAvatar {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  bytesBase64: string;
}

export interface PersistedPermissionGrant {
  origin: string;
  capability: PermissionCapability;
}

export interface AccountBackupConfiguration {
  enabled: boolean;
  wrappedRecoveryKey?: string;
  remoteEtag?: string;
  remoteFileId?: string;
  includeOpenTabs: boolean;
  includeHistory: boolean;
}

export interface GoogleIdentityRecord {
  sub: string;
  email: string;
  displayName?: string;
  emailVerified: true;
  avatar?: StoredAvatar;
}

export interface AccountSpaceRecord {
  schemaVersion: 1;
  id: AccountSpaceId;
  workspaceId: WorkspaceId;
  label: string;
  color: AccountSpaceColor;
  order: number;
  kind: AccountSpaceKind;
  partitionKey: string;
  sourceFingerprint?: string;
  googleIdentity?: GoogleIdentityRecord;
  refreshToken?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string;
  locked: boolean;
  googleConnection: GoogleConnectionStatus;
  websiteStatus: AccountSpaceSummary['websiteStatus'];
  enabledModules: GoogleModule[];
  grantedScopes: string[];
  permissionGrants: PersistedPermissionGrant[];
  backup: AccountBackupConfiguration;
}

export type AccountRecordLoadResult =
  | { status: 'ok'; record: AccountSpaceRecord }
  | { status: 'missing' }
  | { status: 'corrupt'; backupPath: string };

export interface CreateAccountSpaceInput {
  id?: AccountSpaceId;
  workspaceId: WorkspaceId;
  label: string;
  color: AccountSpaceColor;
  order: number;
  partitionKey?: string;
  sourceFingerprint?: string;
}

export class AccountStore {
  private readonly corruptRecords = new Map<AccountSpaceId, string>();

  constructor(
    private readonly directoryPath: string,
    private readonly encryption: SafeStorageAdapter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  isEncryptionAvailable(): boolean {
    return this.encryption.isEncryptionAvailable();
  }

  createLocal(input: CreateAccountSpaceInput): AccountSpaceRecord {
    this.requireEncryption();
    const id = input.id ?? (randomUUID() as AccountSpaceId);
    const workspaceId = requireWorkspaceId(input.workspaceId);
    const createdAt = this.now().toISOString();
    const record: AccountSpaceRecord = {
      schemaVersion: ACCOUNT_RECORD_VERSION,
      id,
      workspaceId,
      label: requireAccountLabel(input.label),
      color: requireAccountColor(input.color),
      order: requireOrder(input.order),
      kind: 'local',
      partitionKey: input.partitionKey ? requirePartitionKey(input.partitionKey, workspaceId, id) : newPartitionKey(id),
      sourceFingerprint: input.sourceFingerprint ? requireFingerprint(input.sourceFingerprint) : undefined,
      createdAt,
      updatedAt: createdAt,
      lastUsedAt: createdAt,
      locked: false,
      googleConnection: 'disconnected',
      websiteStatus: 'not-visited',
      enabledModules: [],
      grantedScopes: [],
      permissionGrants: [],
      backup: { enabled: false, includeOpenTabs: false, includeHistory: false },
    };
    this.write(record);
    return structuredClone(record);
  }

  replaceCorrupt(input: CreateAccountSpaceInput): AccountSpaceRecord {
    const id = input.id;
    if (!id || !this.corruptRecords.has(id)) throw new Error('Account Space is not in corruption recovery');
    const filePath = this.recordPath(id);
    if (existsSync(filePath)) rmSync(filePath, { force: true });
    this.corruptRecords.delete(id);
    return this.createLocal(input);
  }

  load(id: AccountSpaceId): AccountRecordLoadResult {
    if (!isAccountSpaceId(id)) throw new Error('Invalid Account Space identifier');
    const knownBackup = this.corruptRecords.get(id);
    if (knownBackup) return { status: 'corrupt', backupPath: knownBackup };
    const filePath = this.recordPath(id);
    if (!existsSync(filePath)) return { status: 'missing' };
    try {
      this.requireEncryption();
      const ciphertext = Buffer.from(readFileSync(filePath, 'utf8'), 'base64');
      const plaintext = this.encryption.decryptString(ciphertext);
      const record = validateRecord(JSON.parse(plaintext), id);
      return { status: 'ok', record };
    } catch {
      const backupPath = `${filePath}.corrupt-${this.now().getTime()}`;
      if (!existsSync(backupPath)) copyFileSync(filePath, backupPath);
      this.corruptRecords.set(id, backupPath);
      return { status: 'corrupt', backupPath };
    }
  }

  require(id: AccountSpaceId): AccountSpaceRecord {
    const result = this.load(id);
    if (result.status === 'missing') throw new Error('Account Space was not found');
    if (result.status === 'corrupt') throw new Error('Account Space record is unreadable; writes are disabled for this account');
    return structuredClone(result.record);
  }

  update(id: AccountSpaceId, mutator: (record: AccountSpaceRecord) => void): AccountSpaceRecord {
    if (this.corruptRecords.has(id)) throw new Error('Account Space record is unreadable; writes are disabled for this account');
    const record = this.require(id);
    mutator(record);
    record.updatedAt = this.now().toISOString();
    const validated = validateRecord(record, id);
    this.write(validated);
    return structuredClone(validated);
  }

  saveGoogleGrant(
    id: AccountSpaceId,
    identity: GoogleIdentityRecord,
    refreshToken: string,
    modules: GoogleModule[],
    grantedScopes: string[],
    allAccountIds: AccountSpaceId[],
  ): AccountSpaceRecord {
    const validatedIdentity = validateGoogleIdentity(identity);
    if (typeof refreshToken !== 'string' || refreshToken.length < 8 || refreshToken.length > 8192) {
      throw new Error('Invalid Google refresh token');
    }
    for (const candidateId of allAccountIds) {
      if (candidateId === id) continue;
      const candidate = this.load(candidateId);
      if (candidate.status === 'ok' && candidate.record.googleIdentity?.sub === validatedIdentity.sub) {
        throw new Error('This Google account is already connected to another Account Space');
      }
    }
    return this.update(id, (record) => {
      record.kind = 'google';
      record.googleIdentity = validatedIdentity;
      record.refreshToken = refreshToken;
      record.enabledModules = requireGoogleModules(modules);
      record.grantedScopes = validateScopes(grantedScopes);
      record.googleConnection = 'connected';
    });
  }

  disconnectGoogle(id: AccountSpaceId): AccountSpaceRecord {
    return this.update(id, (record) => {
      record.refreshToken = undefined;
      record.grantedScopes = [];
      record.enabledModules = [];
      record.googleConnection = 'disconnected';
    });
  }

  toSummary(record: AccountSpaceRecord): AccountSpaceSummary {
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

  remove(id: AccountSpaceId): boolean {
    if (!isAccountSpaceId(id)) throw new Error('Invalid Account Space identifier');
    const filePath = this.recordPath(id);
    if (!existsSync(filePath)) return false;
    rmSync(filePath, { force: true });
    this.corruptRecords.delete(id);
    return true;
  }

  resetCorrupt(id: AccountSpaceId): boolean {
    const backupPath = this.corruptRecords.get(id);
    if (!backupPath) return false;
    const filePath = this.recordPath(id);
    if (existsSync(filePath)) renameSync(filePath, `${filePath}.replaced-${this.now().getTime()}`);
    this.corruptRecords.delete(id);
    return true;
  }

  private recordPath(id: AccountSpaceId): string {
    return join(this.directoryPath, `${id}.account.enc`);
  }

  private requireEncryption(): void {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
  }

  private write(record: AccountSpaceRecord): void {
    this.requireEncryption();
    if (this.corruptRecords.has(record.id)) throw new Error('Account Space record is unreadable; writes are disabled for this account');
    mkdirSync(this.directoryPath, { recursive: true });
    const ciphertext = this.encryption.encryptString(JSON.stringify(record));
    const filePath = this.recordPath(record.id);
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    writeFileSync(temporaryPath, ciphertext.toString('base64'), { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, filePath);
  }
}

export function newPartitionKey(id: AccountSpaceId): string {
  if (!isAccountSpaceId(id)) throw new Error('Invalid Account Space identifier');
  return `persist:private-browser-account-${id}`;
}

export function validateAvatar(mimeType: string, bytes: Buffer): StoredAvatar {
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) throw new Error('Avatar image exceeds its allowed size');
  const isPng = mimeType === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = mimeType === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  const isWebp = mimeType === 'image/webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!isPng && !isJpeg && !isWebp) throw new Error('Avatar image content does not match an allowed format');
  return { mimeType: mimeType as StoredAvatar['mimeType'], bytesBase64: bytes.toString('base64') };
}

function validateRecord(value: unknown, expectedId: AccountSpaceId): AccountSpaceRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid Account Space record');
  const input = value as Partial<AccountSpaceRecord>;
  if (input.schemaVersion !== ACCOUNT_RECORD_VERSION || input.id !== expectedId) throw new Error('Unsupported Account Space record');
  const workspaceId = requireWorkspaceId(input.workspaceId);
  const kind = input.kind === 'local' || input.kind === 'google' ? input.kind : invalidKind();
  const createdAt = requireIsoDate(input.createdAt, 'createdAt');
  const updatedAt = requireIsoDate(input.updatedAt, 'updatedAt');
  const lastUsedAt = requireIsoDate(input.lastUsedAt, 'lastUsedAt');
  const googleConnection = requireGoogleConnection(input.googleConnection);
  const websiteStatus = requireWebsiteStatus(input.websiteStatus);
  const permissionGrants = validatePermissionGrants(input.permissionGrants);
  const backup = validateBackup(input.backup);
  const record: AccountSpaceRecord = {
    schemaVersion: ACCOUNT_RECORD_VERSION,
    id: expectedId,
    workspaceId,
    label: requireAccountLabel(input.label),
    color: requireAccountColor(input.color),
    order: requireOrder(input.order),
    kind,
    partitionKey: requirePartitionKey(input.partitionKey, workspaceId, expectedId),
    sourceFingerprint: input.sourceFingerprint ? requireFingerprint(input.sourceFingerprint) : undefined,
    googleIdentity: input.googleIdentity ? validateGoogleIdentity(input.googleIdentity) : undefined,
    refreshToken: typeof input.refreshToken === 'string' && input.refreshToken.length <= 8192 ? input.refreshToken : undefined,
    createdAt,
    updatedAt,
    lastUsedAt,
    locked: input.locked === true,
    googleConnection,
    websiteStatus,
    enabledModules: requireGoogleModules(input.enabledModules ?? []),
    grantedScopes: validateScopes(input.grantedScopes ?? []),
    permissionGrants,
    backup,
  };
  if (record.kind === 'google' && !record.googleIdentity) throw new Error('Google Account Space is missing identity data');
  return record;
}

function validateGoogleIdentity(value: GoogleIdentityRecord): GoogleIdentityRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid Google identity');
  const sub = requireShortText(value.sub, 'Google subject', 255);
  const email = requireShortText(value.email, 'Google email', 320);
  if (!/^\S+@\S+\.\S+$/.test(email) || value.emailVerified !== true) throw new Error('Google email is not verified');
  const displayName = value.displayName ? requireShortText(value.displayName, 'Google display name', 200) : undefined;
  if (value.avatar) {
    const avatarBytes = Buffer.from(value.avatar.bytesBase64, 'base64');
    validateAvatar(value.avatar.mimeType, avatarBytes);
  }
  return { sub, email, displayName, emailVerified: true, avatar: value.avatar };
}

function validatePermissionGrants(value: unknown): PersistedPermissionGrant[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid permission grants');
  return value.map((grant) => {
    if (!grant || typeof grant !== 'object') throw new Error('Invalid permission grant');
    const candidate = grant as Partial<PersistedPermissionGrant>;
    return { origin: requireExactWebOrigin(candidate.origin), capability: requirePermissionCapability(candidate.capability) };
  });
}

function validateBackup(value: unknown): AccountBackupConfiguration {
  if (!value || typeof value !== 'object') throw new Error('Invalid backup configuration');
  const input = value as Partial<AccountBackupConfiguration>;
  return {
    enabled: input.enabled === true,
    wrappedRecoveryKey: input.wrappedRecoveryKey ? requireShortText(input.wrappedRecoveryKey, 'Wrapped recovery key', 4096) : undefined,
    remoteEtag: input.remoteEtag ? requireShortText(input.remoteEtag, 'Remote ETag', 512) : undefined,
    remoteFileId: input.remoteFileId ? requireShortText(input.remoteFileId, 'Remote backup file ID', 512) : undefined,
    includeOpenTabs: input.includeOpenTabs === true,
    includeHistory: input.includeHistory === true,
  };
}

function validateScopes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SCOPES) throw new Error('Invalid Google scopes');
  return [...new Set(value.map((scope) => requireShortText(scope, 'Google scope', MAX_SCOPE_LENGTH)))];
}

function requirePartitionKey(value: unknown, workspaceId: WorkspaceId, id: AccountSpaceId): string {
  if (typeof value !== 'string' || value.length > 200) throw new Error('Invalid Account Space partition');
  const legacy = `persist:private-browser-${workspaceId}`;
  const current = newPartitionKey(id);
  if (value !== legacy && value !== current) throw new Error('Account Space partition is not bound to its owner');
  return value;
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('Invalid migration fingerprint');
  return value.toLowerCase();
}

function requireOrder(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) throw new Error('Invalid Account Space order');
  return value as number;
}

function requireIsoDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || value.length > 40) throw new Error(`Invalid ${field}`);
  return value;
}

function requireShortText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`Invalid ${field}`);
  return normalized;
}

function requireGoogleConnection(value: unknown): GoogleConnectionStatus {
  const statuses = new Set<GoogleConnectionStatus>([
    'not-configured', 'disconnected', 'connecting', 'connected', 'partial-scopes', 'offline',
    'quota-limited', 'revocation-pending', 'reconnect-required', 'locked', 'account-corrupt',
  ]);
  if (typeof value !== 'string' || !statuses.has(value as GoogleConnectionStatus)) throw new Error('Invalid Google connection status');
  return value as GoogleConnectionStatus;
}

function requireWebsiteStatus(value: unknown): AccountSpaceSummary['websiteStatus'] {
  if (value === 'not-visited' || value === 'session-data-present' || value === 'sign-in-blocked' || value === 'unknown') return value;
  throw new Error('Invalid website connection status');
}

function invalidKind(): never {
  throw new Error('Invalid Account Space kind');
}
