import { argon2id } from 'hash-wasm';
import type {
  Argon2idParameters,
  EncryptedField,
  VaultEnvelope,
  VaultPayload,
} from '../types';
import { CURRENT_SCHEMA_VERSION } from '../types';
import { isPasskeyCredential } from './passkeys/types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
/**
 * Narrows bytes to the `ArrayBuffer`-backed view every Web Crypto call takes.
 *
 * `BufferSource` is `ArrayBufferView<ArrayBuffer>`, but a bare `Uint8Array`
 * types as `Uint8Array<ArrayBufferLike>` — which admits `SharedArrayBuffer` and
 * so does not satisfy it. Newer lib definitions enforce that; older ones did
 * not, which is why `typescript@7` and `@types/node@26` are each clean alone and
 * reject exactly these call sites together.
 *
 * The assertion is safe here as a fact about this application, not as a hope:
 * `SharedArrayBuffer` exists only in a cross-origin-isolated context, which
 * needs both `Cross-Origin-Opener-Policy: same-origin` **and**
 * `Cross-Origin-Embedder-Policy: require-corp`. The Worker sends the first and
 * deliberately not the second ([worker/index.ts](../../worker/index.ts)), so the
 * constructor is not even defined in the page — and nothing in this repository
 * names it. It is a compile-time narrowing with no runtime cost: no copy, and
 * no bytes moved.
 */
export function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

function wrapAad(vaultId: string): Uint8Array {
  return encoder.encode(`myvault:v1:${vaultId}:wrapped-key`);
}

function payloadAad(vaultId: string): Uint8Array {
  return encoder.encode(`myvault:v1:${vaultId}:payload`);
}

export const DEFAULT_KDF: Omit<Argon2idParameters, 'salt'> = {
  algorithm: 'argon2id',
  memorySizeKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
};

export class InvalidMasterPasswordError extends Error {
  constructor() {
    super('The master password is incorrect or the vault is damaged.');
    this.name = 'InvalidMasterPasswordError';
  }
}

/**
 * The biometric gesture succeeded but the key it released did not open this
 * vault. Distinct from a wrong master password because the remedy is different:
 * the enrollment is stale and has to be removed, not retyped.
 */
export class BiometricUnlockRejectedError extends Error {
  constructor() {
    super('This device’s biometric enrollment no longer matches the stored vault.');
    this.name = 'BiometricUnlockRejectedError';
  }
}

export interface VaultSession {
  readonly vaultId: string;
  readonly dataKey: CryptoKey;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/** Salts are 16 raw bytes; anything far outside that is malformed or hostile. */
function isBase64Salt(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 128 &&
    BASE64_PATTERN.test(value)
  );
}

function assertKdfIsSafe(kdf: Argon2idParameters): void {
  const valid =
    kdf.algorithm === 'argon2id' &&
    isBase64Salt(kdf.salt) &&
    Number.isInteger(kdf.memorySizeKiB) &&
    kdf.memorySizeKiB >= 8 * 1024 &&
    kdf.memorySizeKiB <= 256 * 1024 &&
    Number.isInteger(kdf.iterations) &&
    kdf.iterations >= 1 &&
    kdf.iterations <= 10 &&
    Number.isInteger(kdf.parallelism) &&
    kdf.parallelism >= 1 &&
    kdf.parallelism <= 4 &&
    kdf.hashLength === 32;

  if (!valid) {
    throw new Error('The vault uses unsupported or unsafe key-derivation parameters.');
  }
}

async function deriveWrappingKey(password: string, kdf: Argon2idParameters): Promise<CryptoKey> {
  assertKdfIsSafe(kdf);
  const passwordBytes = encoder.encode(password.normalize('NFKC'));
  const saltBytes = base64ToBytes(kdf.salt);
  let derived: Uint8Array | undefined;

  try {
    derived = await argon2id({
      password: passwordBytes,
      salt: saltBytes,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
      memorySize: kdf.memorySizeKiB,
      hashLength: kdf.hashLength,
      outputType: 'binary',
    });
    return await crypto.subtle.importKey(
      'raw',
      asBufferSource(derived),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  } finally {
    passwordBytes.fill(0);
    saltBytes.fill(0);
    derived?.fill(0);
  }
}

async function encryptBytes(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<EncryptedField> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: asBufferSource(aad), tagLength: 128 },
    key,
    asBufferSource(plaintext),
  );

  return {
    algorithm: 'AES-256-GCM',
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

async function decryptBytes(key: CryptoKey, field: EncryptedField, aad: Uint8Array): Promise<Uint8Array> {
  if (field.algorithm !== 'AES-256-GCM') {
    throw new Error('Unsupported vault cipher.');
  }

  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(field.iv),
      additionalData: asBufferSource(aad),
      tagLength: 128,
    },
    key,
    base64ToBytes(field.ciphertext),
  );
  return new Uint8Array(plaintext);
}

async function importDataKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    asBufferSource(rawKey),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * An earlier build stored the literal string "Just now" in `item.updatedAt`.
 * Nothing can compare that: sync merges resolve a same-id collision by taking
 * the later timestamp and fell back to "keep local" every time, and the security
 * checkup's year-old-credential rule never fired. Repairing it here — the one
 * place every decrypt path passes through — means a vault written by that build
 * is fixed the first time it is opened rather than staying broken forever.
 *
 * The vault-level `updatedAt` is the closest defensible stand-in: the item was
 * last written no later than the payload that contains it.
 */
function repairItemTimestamps(payload: VaultPayload): VaultPayload {
  const fallback = Number.isFinite(Date.parse(payload.updatedAt))
    ? payload.updatedAt
    : new Date().toISOString();
  let changed = false;
  const items = payload.items.map((item) => {
    if (typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))) {
      return item;
    }
    changed = true;
    return { ...item, updatedAt: fallback };
  });
  return changed ? { ...payload, items } : payload;
}

/**
 * The vault opened, but this build cannot read what is inside it.
 *
 * Two very different situations reach this class and the message has to tell
 * them apart, because the remedies are opposite: a vault written by a *newer*
 * MyVault needs the user to update this device, and a damaged one needs a
 * restore. The old wording — "the decrypted vault has an unsupported
 * structure" — was correct for both and useful for neither.
 */
export class UnsupportedVaultPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedVaultPayloadError';
  }
}

/**
 * Reads a decrypted payload, migrating an older schema forward.
 *
 * Forward only, and deliberately: a newer payload is refused rather than
 * downgraded. Stripping a field this build does not understand would turn "this
 * device is out of date" into silent data loss the moment the payload was
 * written back.
 */
function parsePayload(bytes: Uint8Array): VaultPayload {
  // `schemaVersion` is widened to `number` deliberately: the field is a literal
  // type on `VaultPayload`, so an intersection would narrow it straight back and
  // make the version comparisons below unreachable to the type checker.
  const parsed = JSON.parse(decoder.decode(bytes)) as Omit<Partial<VaultPayload>, 'schemaVersion'> & {
    schemaVersion?: number;
  };

  if (typeof parsed.schemaVersion === 'number' && parsed.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedVaultPayloadError(
      'This vault was saved by a newer version of MyVault. Update this device, then open it again — nothing has been changed here.',
    );
  }

  if (
    (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
    !Array.isArray(parsed.items) ||
    !Array.isArray(parsed.tokens) ||
    !Array.isArray(parsed.securityKeys) ||
    typeof parsed.preferences !== 'object' ||
    parsed.preferences === null
  ) {
    throw new UnsupportedVaultPayloadError('The decrypted vault has an unsupported structure.');
  }

  /**
   * Version 1 → 2: the field simply did not exist.
   *
   * A record that is not well-formed is set aside here rather than at signing
   * time, so a corrupted entry cannot reach a key import — but it is **counted**
   * rather than silently discarded. A passkey private key has no copy anywhere:
   * not at the relying party, not on the Worker, not in the extension. Dropping
   * one quietly and writing the result back is the one place in this file where
   * "skip the malformed record" and "lose the account" are the same sentence,
   * and the user's only other signal would be a site that stops offering their
   * passkey.
   */
  const rawPasskeys = Array.isArray(parsed.passkeys) ? parsed.passkeys : [];
  const passkeys = rawPasskeys.filter(isPasskeyCredential);
  const unreadablePasskeys = rawPasskeys.length - passkeys.length;

  /**
   * The count is recomputed here every time, and the stored one is discarded.
   *
   * It used to be spread through from `parsed` and only overwritten when this
   * read found something, which made it permanent: the first save after a bad
   * record writes the field back alongside a `passkeys` array the record is no
   * longer in, so the next unlock recomputes 0, keeps the old number, and warns
   * about damage that is not there any more. A warning that cannot be cleared
   * is one the user learns to scroll past, on the screen where it matters most.
   */
  const { unreadablePasskeys: _staleCount, ...withoutStaleCount } = parsed as VaultPayload;
  const migrated: VaultPayload = {
    ...withoutStaleCount,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    passkeys,
    ...(unreadablePasskeys > 0 ? { unreadablePasskeys } : {}),
  };
  return repairItemTimestamps(migrated);
}

export function createEmptyVaultPayload(): VaultPayload {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    items: [],
    tokens: [],
    securityKeys: [],
    passkeys: [],
    preferences: {
      autoLockSeconds: 300,
      lockOnHidden: true,
      clipboardClearSeconds: 30,
    },
    updatedAt: new Date().toISOString(),
  };
}

function isEncryptedField(value: unknown): value is EncryptedField {
  if (!value || typeof value !== 'object') return false;
  const field = value as Partial<EncryptedField>;
  return (
    field.algorithm === 'AES-256-GCM' &&
    typeof field.iv === 'string' &&
    field.iv.length >= 16 &&
    field.iv.length <= 32 &&
    BASE64_PATTERN.test(field.iv) &&
    typeof field.ciphertext === 'string' &&
    field.ciphertext.length >= 24 &&
    BASE64_PATTERN.test(field.ciphertext)
  );
}

export function isVaultEnvelope(value: unknown): value is VaultEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as Partial<VaultEnvelope>;
  return (
    envelope.format === 'myvault' &&
    envelope.version === 1 &&
    typeof envelope.vaultId === 'string' &&
    typeof envelope.createdAt === 'string' &&
    typeof envelope.updatedAt === 'string' &&
    envelope.vaultId.length >= 16 &&
    envelope.vaultId.length <= 128 &&
    typeof envelope.kdf === 'object' &&
    envelope.kdf !== null &&
    envelope.kdf.algorithm === 'argon2id' &&
    isBase64Salt(envelope.kdf.salt) &&
    isEncryptedField(envelope.wrappedKey) &&
    isEncryptedField(envelope.payload)
  );
}

/** Single source of truth for the master-password floor used by the UI and the crypto layer. */
export const MIN_MASTER_PASSWORD_LENGTH = 14;

export async function createVault(
  masterPassword: string,
  payload: VaultPayload,
  kdfOverrides: Partial<Omit<Argon2idParameters, 'algorithm' | 'salt'>> = {},
): Promise<{ envelope: VaultEnvelope; session: VaultSession }> {
  if (masterPassword.normalize('NFKC').length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new Error(
      `Use a master password with at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`,
    );
  }

  const now = new Date().toISOString();
  const kdf: Argon2idParameters = {
    ...DEFAULT_KDF,
    ...kdfOverrides,
    algorithm: 'argon2id',
    salt: bytesToBase64(randomBytes(16)),
  };
  const wrappingKey = await deriveWrappingKey(masterPassword, kdf);
  const rawDataKey = randomBytes(32);
  const vaultId = crypto.randomUUID();

  try {
    const dataKey = await importDataKey(rawDataKey);
    const wrappedKey = await encryptBytes(wrappingKey, rawDataKey, wrapAad(vaultId));
    const normalizedPayload: VaultPayload = { ...payload, updatedAt: now };
    const encryptedPayload = await encryptBytes(
      dataKey,
      encoder.encode(JSON.stringify(normalizedPayload)),
      payloadAad(vaultId),
    );
    return {
      envelope: {
        format: 'myvault',
        version: 1,
        vaultId,
        createdAt: now,
        updatedAt: now,
        kdf,
        wrappedKey,
        payload: encryptedPayload,
      },
      session: { vaultId, dataKey },
    };
  } finally {
    rawDataKey.fill(0);
  }
}

export async function unlockVault(
  masterPassword: string,
  envelope: VaultEnvelope,
): Promise<{ payload: VaultPayload; session: VaultSession }> {
  if (!isVaultEnvelope(envelope)) {
    throw new Error('This is not a supported MyVault archive.');
  }

  const wrappingKey = await deriveWrappingKey(masterPassword, envelope.kdf);
  let rawDataKey: Uint8Array | undefined;
  try {
    rawDataKey = await decryptBytes(wrappingKey, envelope.wrappedKey, wrapAad(envelope.vaultId));
    const dataKey = await importDataKey(rawDataKey);
    const payloadBytes = await decryptBytes(dataKey, envelope.payload, payloadAad(envelope.vaultId));
    try {
      return {
        payload: parsePayload(payloadBytes),
        session: { vaultId: envelope.vaultId, dataKey },
      };
    } finally {
      payloadBytes.fill(0);
    }
  } catch (error) {
    if (error instanceof UnsupportedVaultPayloadError) throw error;
    throw new InvalidMasterPasswordError();
  } finally {
    rawDataKey?.fill(0);
  }
}

/**
 * Re-wraps the existing data key under a key derived from a new master password.
 *
 * The random data key is deliberately preserved so the vault identity, sync
 * lineage, and linked authenticator seeds survive the change. The payload is
 * re-encrypted with a fresh IV so the new envelope shares no ciphertext bytes
 * with the old one. Backups exported before the change stay openable with the
 * old master password — rotating this key would not retroactively protect them.
 */
export async function changeMasterPassword(
  currentPassword: string,
  newPassword: string,
  envelope: VaultEnvelope,
): Promise<{ envelope: VaultEnvelope; session: VaultSession; payload: VaultPayload }> {
  if (!isVaultEnvelope(envelope)) {
    throw new Error('This is not a supported MyVault archive.');
  }
  if (newPassword.normalize('NFKC').length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new Error(
      `Use a master password with at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`,
    );
  }
  if (currentPassword.normalize('NFKC') === newPassword.normalize('NFKC')) {
    throw new Error('The new master password must differ from the current one.');
  }

  const currentWrappingKey = await deriveWrappingKey(currentPassword, envelope.kdf);
  let rawDataKey: Uint8Array | undefined;
  try {
    rawDataKey = await decryptBytes(
      currentWrappingKey,
      envelope.wrappedKey,
      wrapAad(envelope.vaultId),
    );
  } catch {
    throw new InvalidMasterPasswordError();
  }

  try {
    const dataKey = await importDataKey(rawDataKey);
    // Prove the payload still opens before replacing the wrapping layer.
    const payloadBytes = await decryptBytes(
      dataKey,
      envelope.payload,
      payloadAad(envelope.vaultId),
    );
    let payload: VaultPayload;
    try {
      payload = parsePayload(payloadBytes);
    } finally {
      payloadBytes.fill(0);
    }

    const kdf: Argon2idParameters = {
      ...DEFAULT_KDF,
      algorithm: 'argon2id',
      salt: bytesToBase64(randomBytes(16)),
    };
    const nextWrappingKey = await deriveWrappingKey(newPassword, kdf);
    const wrappedKey = await encryptBytes(nextWrappingKey, rawDataKey, wrapAad(envelope.vaultId));
    const now = new Date().toISOString();
    const normalizedPayload: VaultPayload = { ...payload, updatedAt: now };
    const encryptedPayload = await encryptBytes(
      dataKey,
      encoder.encode(JSON.stringify(normalizedPayload)),
      payloadAad(envelope.vaultId),
    );

    return {
      envelope: {
        ...envelope,
        updatedAt: now,
        kdf,
        wrappedKey,
        payload: encryptedPayload,
      },
      session: { vaultId: envelope.vaultId, dataKey },
      payload: normalizedPayload,
    };
  } finally {
    rawDataKey.fill(0);
  }
}

export async function decryptWithSession(
  envelope: VaultEnvelope,
  session: VaultSession,
): Promise<VaultPayload> {
  if (envelope.vaultId !== session.vaultId) {
    throw new Error('The remote vault belongs to a different vault identity.');
  }
  const payloadBytes = await decryptBytes(
    session.dataKey,
    envelope.payload,
    payloadAad(envelope.vaultId),
  );
  try {
    return parsePayload(payloadBytes);
  } finally {
    payloadBytes.fill(0);
  }
}

export async function encryptVaultPayload(
  payload: VaultPayload,
  envelope: VaultEnvelope,
  session: VaultSession,
): Promise<VaultEnvelope> {
  if (envelope.vaultId !== session.vaultId) {
    throw new Error('The active key does not belong to this vault.');
  }
  const now = new Date().toISOString();
  const normalizedPayload: VaultPayload = { ...payload, updatedAt: now };
  const encryptedPayload = await encryptBytes(
    session.dataKey,
    encoder.encode(JSON.stringify(normalizedPayload)),
    payloadAad(envelope.vaultId),
  );
  return { ...envelope, updatedAt: now, payload: encryptedPayload };
}

export function serializeVaultArchive(envelope: VaultEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function parseVaultArchive(text: string): VaultEnvelope {
  const parsed: unknown = JSON.parse(text);
  if (!isVaultEnvelope(parsed)) {
    throw new Error('The selected file is not a supported encrypted MyVault archive.');
  }
  assertKdfIsSafe(parsed.kdf);
  return parsed;
}

/**
 * Biometric unlock, in one sentence: the vault's random data key is wrapped a
 * second time, under a key that only this device's platform authenticator can
 * reproduce, and only after the user passes a biometric or device-credential
 * check.
 *
 * The two functions below are deliberately the only way in and out of that
 * second wrapping. The raw data key is never returned to a caller — enrollment
 * takes the master password and gives back ciphertext, and unlock takes
 * ciphertext and gives back a `VaultSession` holding a non-extractable key,
 * exactly like the password path.
 *
 * Domain separation matters here: the biometric wrap uses its own AAD, so a
 * biometric blob can never be substituted for the password-wrapped key (or the
 * reverse) even by someone who can rewrite IndexedDB.
 */
function biometricWrapAad(vaultId: string): Uint8Array {
  return encoder.encode(`myvault:v1:${vaultId}:biometric-wrapped-key`);
}

/** Bytes the WebAuthn PRF hands back, stretched into an AES-256-GCM key. */
export async function deriveBiometricUnlockKey(
  prfOutput: Uint8Array,
  hkdfSalt: Uint8Array,
  vaultId: string,
): Promise<CryptoKey> {
  if (prfOutput.length < 32) {
    throw new Error('The authenticator returned too little key material.');
  }
  const material = await crypto.subtle.importKey(
    'raw',
    asBufferSource(prfOutput),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asBufferSource(hkdfSalt),
      info: encoder.encode(`myvault:v1:${vaultId}:biometric-unlock`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Enrollment requires the master password. That is the point: binding a
 * fingerprint to the vault is an authorization decision, so it has to be made
 * by someone who can already open the vault, not by whoever happens to be
 * holding an unlocked phone.
 */
/**
 * Checks the master password and holds the unwrapped data key ready to wrap.
 *
 * Enrollment used to ask the operating system for a passkey first and check the
 * password afterwards, so every wrong attempt cost one or two biometric
 * gestures and left an orphan credential in Windows Hello or the Android
 * keystore that nothing here would ever use again. Splitting the step lets the
 * caller prove the password first and only then raise the gesture.
 *
 * The raw key never leaves this module. `dispose` exists for the path where the
 * gesture is cancelled and `wrap` is never called.
 */
export async function prepareBiometricWrap(
  masterPassword: string,
  envelope: VaultEnvelope,
): Promise<{
  wrap: (unlockKey: CryptoKey) => Promise<EncryptedField>;
  dispose: () => void;
}> {
  if (!isVaultEnvelope(envelope)) {
    throw new Error('This is not a supported MyVault archive.');
  }

  const wrappingKey = await deriveWrappingKey(masterPassword, envelope.kdf);
  let rawDataKey: Uint8Array | undefined;
  try {
    rawDataKey = await decryptBytes(wrappingKey, envelope.wrappedKey, wrapAad(envelope.vaultId));
  } catch {
    throw new InvalidMasterPasswordError();
  }

  const held = rawDataKey;
  return {
    wrap: async (unlockKey: CryptoKey) => {
      try {
        return await encryptBytes(unlockKey, held, biometricWrapAad(envelope.vaultId));
      } finally {
        held.fill(0);
      }
    },
    dispose: () => held.fill(0),
  };
}

export async function wrapDataKeyForBiometrics(
  masterPassword: string,
  envelope: VaultEnvelope,
  unlockKey: CryptoKey,
): Promise<EncryptedField> {
  const prepared = await prepareBiometricWrap(masterPassword, envelope);
  try {
    return await prepared.wrap(unlockKey);
  } catch (error) {
    prepared.dispose();
    throw error;
  }
}

/**
 * Opens the vault from the biometric wrap. AES-GCM authenticates the wrap, so a
 * record that was tampered with, copied from another vault, or left behind by a
 * vault that has since been replaced fails here rather than producing a key that
 * silently decrypts nothing.
 */
export async function unlockVaultWithBiometricKey(
  wrappedKey: EncryptedField,
  unlockKey: CryptoKey,
  envelope: VaultEnvelope,
): Promise<{ payload: VaultPayload; session: VaultSession }> {
  if (!isVaultEnvelope(envelope)) {
    throw new Error('This is not a supported MyVault archive.');
  }

  let rawDataKey: Uint8Array | undefined;
  try {
    rawDataKey = await decryptBytes(unlockKey, wrappedKey, biometricWrapAad(envelope.vaultId));
    const dataKey = await importDataKey(rawDataKey);
    const payloadBytes = await decryptBytes(dataKey, envelope.payload, payloadAad(envelope.vaultId));
    try {
      return {
        payload: parsePayload(payloadBytes),
        session: { vaultId: envelope.vaultId, dataKey },
      };
    } finally {
      payloadBytes.fill(0);
    }
  } catch (error) {
    if (error instanceof UnsupportedVaultPayloadError) throw error;
    throw new BiometricUnlockRejectedError();
  } finally {
    rawDataKey?.fill(0);
  }
}

