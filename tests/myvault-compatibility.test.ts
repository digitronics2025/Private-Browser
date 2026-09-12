import { argon2id } from 'hash-wasm';
import { describe, expect, it } from 'vitest';
import { InvalidMasterPasswordError, unlockVault, UnsupportedVaultPayloadError } from '../electron/myvault/security/vault-crypto.js';
import type { VaultEnvelope } from '../electron/myvault/types.js';
import vectorFile from '../electron/myvault/security/vectors.json';

/**
 * The envelope format has more than one reader: this app, the two extensions, and
 * the Android keyboard's autofill provider, which is a separate implementation in
 * a different language. Until now every envelope in this suite was generated at
 * run time by the same code that read it back, so nothing pinned the format
 * itself - a change to an AAD string, the salt encoding or the KDF parameters
 * would have been round-tripped happily by every test here and broken every other
 * reader silently.
 *
 * `vectors.json` is committed ciphertext with the answers written down. These
 * tests prove the production path still opens it; the Android repository runs the
 * same file through its own implementation
 * (`app/src/test/resources/myvault-vectors.json`). If a change here needs the
 * vectors regenerated, that is the signal to go and change the other reader too.
 */

const encoder = new TextEncoder();

interface Vector {
  name: string;
  description: string;
  masterPassword: string;
  argon2idOutputHex: string;
  dataKeyHex: string;
  expectedPayloadJson: string;
  envelope: VaultEnvelope;
}

const vectors = vectorFile.vectors as unknown as Vector[];
const byName = (name: string): Vector => {
  const found = vectors.find((vector) => vector.name === name);
  if (!found) throw new Error(`no vector named ${name}`);
  return found;
};

const base64ToBytes = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

/** A structured clone, so mutating a vector in one test cannot reach another. */
const copy = (envelope: VaultEnvelope): VaultEnvelope =>
  JSON.parse(JSON.stringify(envelope)) as VaultEnvelope;

describe('cross-language envelope vectors', () => {
  it('ships the vectors the other readers are pinned to', () => {
    expect(vectorFile.aad.wrappedKey).toBe('myvault:v1:<vaultId>:wrapped-key');
    expect(vectorFile.aad.payload).toBe('myvault:v1:<vaultId>:payload');
    expect(vectors.map((vector) => vector.name)).toEqual([
      'schema-2-reduced-cost',
      'schema-1-needs-migration',
      'nfkc-password',
      'schema-3-from-the-future',
      'production-cost',
    ]);
  });

  /**
   * The step that makes a failure legible. `unlockVault` collapses every error
   * except an unsupported schema into `InvalidMasterPasswordError`, so without an
   * assertion on the derived key itself, a port with a KDF bug and a port with an
   * AAD bug produce the identical, useless message.
   */
  it.each(['schema-2-reduced-cost', 'nfkc-password'])(
    'derives exactly the recorded Argon2id output for %s',
    async (name) => {
      const vector = byName(name);
      const derived = await argon2id({
        password: encoder.encode(vector.masterPassword.normalize('NFKC')),
        salt: base64ToBytes(vector.envelope.kdf.salt),
        parallelism: vector.envelope.kdf.parallelism,
        iterations: vector.envelope.kdf.iterations,
        memorySize: vector.envelope.kdf.memorySizeKiB,
        hashLength: vector.envelope.kdf.hashLength,
        outputType: 'binary',
      });
      expect(toHex(derived)).toBe(vector.argon2idOutputHex);
    },
  );

  /**
   * Byte equality, not object equality: this is the assertion the Android port
   * makes too, and it is the only one that catches a JSON serialisation
   * difference between the two languages.
   */
  it('decrypts to exactly the recorded payload bytes', async () => {
    const vector = byName('schema-2-reduced-cost');
    const dataKey = await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(vector.dataKeyHex.match(/../g)!.map((pair) => parseInt(pair, 16))),
      { name: 'AES-GCM' },
      false,
      ['decrypt'],
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: base64ToBytes(vector.envelope.payload.iv),
        additionalData: encoder.encode(`myvault:v1:${vector.envelope.vaultId}:payload`),
        tagLength: 128,
      },
      dataKey,
      base64ToBytes(vector.envelope.payload.ciphertext),
    );
    expect(new TextDecoder().decode(plaintext)).toBe(vector.expectedPayloadJson);
  });

  it('opens the ordinary vector through the production unlock path', async () => {
    const vector = byName('schema-2-reduced-cost');
    const { payload, session } = await unlockVault(vector.masterPassword, vector.envelope);

    expect(session.vaultId).toBe(vector.envelope.vaultId);
    expect(payload.schemaVersion).toBe(2);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].username).toBe('youssef');
    expect(payload.items[0].password).toBe('Tr0ub4dor&3xK');
    expect(payload.items[0].totp?.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(payload.tokens).toHaveLength(1);
    expect(payload.preferences.clipboardClearSeconds).toBe(30);
  });

  it('migrates a schema 1 payload instead of refusing it', async () => {
    const vector = byName('schema-1-needs-migration');
    const { payload } = await unlockVault(vector.masterPassword, vector.envelope);
    expect(payload.schemaVersion).toBe(2);
    expect(payload.passkeys).toEqual([]);
    expect(payload.items[0].username).toBe('youssef');
  });

  /**
   * The ligature in this password is one code point that NFKC turns into two. A
   * reader that encodes the raw string derives a different key and fails, which
   * is exactly what must not be discovered on someone's phone.
   */
  it('normalises the master password to NFKC before deriving', async () => {
    const vector = byName('nfkc-password');
    expect(vector.masterPassword).not.toBe(vector.masterPassword.normalize('NFKC'));

    const { payload } = await unlockVault(vector.masterPassword, vector.envelope);
    expect(payload.items[0].username).toBe('youssef');

    await expect(
      unlockVault(vector.masterPassword.normalize('NFKC') + ' ', vector.envelope),
    ).rejects.toBeInstanceOf(InvalidMasterPasswordError);
  });

  it('refuses a schema version from the future rather than guessing at it', async () => {
    const vector = byName('schema-3-from-the-future');
    await expect(unlockVault(vector.masterPassword, vector.envelope)).rejects.toBeInstanceOf(
      UnsupportedVaultPayloadError,
    );
  });

  it('refuses a wrong master password', async () => {
    const vector = byName('schema-2-reduced-cost');
    await expect(unlockVault('not the master password', vector.envelope)).rejects.toBeInstanceOf(
      InvalidMasterPasswordError,
    );
  });

  /**
   * The vault id is additional authenticated data on both layers, so moving
   * ciphertext to another envelope must fail rather than decrypt. A port that
   * builds the AAD from a constant instead of the envelope passes every other
   * test here and fails this one.
   */
  it('binds the ciphertext to its vault id', async () => {
    const vector = byName('schema-2-reduced-cost');
    const tampered = copy(vector.envelope);
    tampered.vaultId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    await expect(unlockVault(vector.masterPassword, tampered)).rejects.toBeInstanceOf(
      InvalidMasterPasswordError,
    );
  });

  it('refuses ciphertext that has been altered', async () => {
    const vector = byName('schema-2-reduced-cost');
    const tampered = copy(vector.envelope);
    const bytes = base64ToBytes(tampered.payload.ciphertext);
    bytes[0] ^= 0xff;
    tampered.payload.ciphertext = btoa(String.fromCharCode(...bytes));
    await expect(unlockVault(vector.masterPassword, tampered)).rejects.toBeInstanceOf(
      InvalidMasterPasswordError,
    );
  });

  /**
   * Slow on purpose. Every other vector runs at 8 MiB so the suite stays quick,
   * which means nothing else here has ever exercised the parameters a real vault
   * actually uses.
   */
  it('opens a vector at the real 64 MiB cost', { timeout: 30_000 }, async () => {
    const vector = byName('production-cost');
    expect(vector.envelope.kdf.memorySizeKiB).toBe(65536);
    expect(vector.envelope.kdf.iterations).toBe(3);
    const { payload } = await unlockVault(vector.masterPassword, vector.envelope);
    expect(payload.items[0].password).toBe('Tr0ub4dor&3xK');
  });
});
