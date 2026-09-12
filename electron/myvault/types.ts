import type { PasskeyCredential } from './security/passkeys/types.js';

/**
 * MyVault's visual icon registry is deliberately not part of the portable
 * encrypted-envelope contract. The browser preserves the stored identifier
 * as opaque metadata and maps known values in its own trusted UI.
 */
export type IconName = string;

export interface CustomField {
  id: string;
  type: 'text' | 'hidden';
  key: string;
  value: string;
}

export interface TotpConfig {
  secret: string;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
  digits: number;
  period: number;
  issuer?: string;
  account?: string;
}

export interface VaultItem {
  id: string;
  title: string;
  type: 'login' | 'note' | 'api' | 'identity';
  username: string;
  password?: string;
  url?: string;
  folder: string;
  vault: string;
  favorite: boolean;
  /**
   * Character-pool strength estimate for `password`, recorded at save time.
   * The UI recomputes it on render rather than trusting this, so an entry
   * written by an older build cannot show a stale or invented figure.
   */
  entropy?: number;
  entropyGrade?: string;
  tags: string[];
  updatedAt: string;
  icon?: IconName;
  iconBg?: string;
  iconColor?: string;
  totp?: TotpConfig;
  customFields?: CustomField[];
  notes?: string;
}

export interface TotpToken {
  id: string;
  issuer: string;
  account: string;
  secret: string;
  digits: number;
  period: number;
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512';
  badge?: string;
  badgeType?: 'primary' | 'secondary' | 'tertiary' | 'warning' | 'neutral';
  favorite?: boolean;
  category: 'Infrastructure' | 'Financial' | 'Personal';
  icon: IconName;
  compliance?: string;
}

export interface SecurityIssue {
  id: string;
  itemId: string;
  title: string;
  category: 'Critical' | 'Warning' | 'Recommendation';
  description: string;
  reusedWith?: string;
  actionLabel: string;
  icon: IconName;
}

export interface SecurityKeyDevice {
  id: string;
  name: string;
  type: 'NFC' | 'Platform' | 'USB';
  regDate: string;
  aaguid: string;
  isPrimary?: boolean;
  details: string;
}

export interface VaultPreferences {
  autoLockSeconds: number;
  lockOnHidden: boolean;
  clipboardClearSeconds: number;
  syncToken?: string;
  /**
   * ISO timestamp of the last successful `.myvault` export. There is no
   * recovery backdoor, so the app tracks this to warn when the only copy of the
   * vault is the one on this device.
   */
  lastBackupAt?: string;
}

/**
 * The current payload version.
 *
 * Version 2 added `passkeys`. The bump is not ceremony: `mergeVaultPayloads`
 * builds its result as an explicit literal spreading `...local`, so a field a
 * build does not know about is **dropped when it exists only on the remote
 * side** — silently, with the merge reporting success. Adding `passkeys` without
 * a version bump would have appeared to work and then eaten a passkey created
 * on the user's other machine.
 *
 * With the bump, a build that predates the field refuses the vault at unlock
 * (`parsePayload` below) and writes nothing at all. Failing closed beats losing
 * a credential.
 */
export const CURRENT_SCHEMA_VERSION = 2;

export interface VaultPayload {
  schemaVersion: 2;
  items: VaultItem[];
  tokens: TotpToken[];
  securityKeys: SecurityKeyDevice[];
  /**
   * Passkeys MyVault holds as a software authenticator. Immutable after
   * creation — see `src/security/passkeys/types.ts` for why that is required
   * rather than tidy.
   */
  passkeys: PasskeyCredential[];
  /**
   * How many stored passkey records this build could not read, if any.
   *
   * Set by the decrypt path, never written by a caller. A malformed record is
   * set aside rather than signed with, and a private key has no copy anywhere
   * else — so the count exists to make that loss visible instead of silent.
   */
  unreadablePasskeys?: number;
  preferences: VaultPreferences;
  updatedAt: string;
}

export interface Argon2idParameters {
  algorithm: 'argon2id';
  salt: string;
  memorySizeKiB: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

export interface EncryptedField {
  algorithm: 'AES-256-GCM';
  iv: string;
  ciphertext: string;
}

export interface VaultEnvelope {
  format: 'myvault';
  version: 1;
  vaultId: string;
  createdAt: string;
  updatedAt: string;
  kdf: Argon2idParameters;
  wrappedKey: EncryptedField;
  payload: EncryptedField;
}

export type VaultLifecycle = 'loading' | 'setup' | 'locked' | 'unlocked';
/**
 * Encrypted storage did not answer ('stalled') or answered with an error
 * ('failed'). Neither means the vault is absent, so neither may lead to the
 * setup screen.
 */
export type StorageProblem = 'stalled' | 'failed' | null;
export type SyncState = 'disabled' | 'idle' | 'syncing' | 'synced' | 'conflict' | 'error';

export type ActiveTab =
  | 'vault'
  | 'authenticator'
  | 'passkeys'
  | 'security-checkup'
  | 'extension'
  | 'settings-sync';

/**
 * Device-local biometric unlock enrollment.
 *
 * This record never leaves the device: it is not part of `VaultEnvelope`, so it
 * is never exported to a `.myvault` archive and never synchronized to D1. It is
 * useless anywhere else anyway — `wrappedKey` can only be opened by a secret
 * that the platform authenticator on this device will release, and only after a
 * successful user-verification gesture.
 */
export interface BiometricUnlockRecord {
  id: 'primary';
  /** Binds the enrollment to one vault identity; a different vault must re-enroll. */
  vaultId: string;
  /** Base64url credential ID of the platform passkey that holds the PRF secret. */
  credentialId: string;
  /** Base64 input to the WebAuthn PRF evaluation. Random, per enrollment. */
  prfSalt: string;
  /** Base64 HKDF salt applied to the PRF output before it becomes an AES key. */
  hkdfSalt: string;
  /** The vault data key, wrapped under the key derived from the PRF output. */
  wrappedKey: EncryptedField;
  createdAt: string;
  lastUsedAt?: string;
}
