import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BiometricUnlockRejectedError, createEmptyVaultPayload, createVault, InvalidMasterPasswordError } from '../electron/myvault/security/vault-crypto';
import { parseSecureDialogValue } from '../electron/myvault/secure-dialog-contract';
import { VaultBroker } from '../electron/myvault/vault-broker';
import { MyVaultDiskStore, type SafeStorageAdapter } from '../electron/myvault/vault-store';
import { PlatformUnlockError, platformUnlockKeyName, WindowsHelloSigner, type PlatformUnlockSigner } from '../electron/myvault/windows-hello';

const PASSWORD = 'correct horse battery staple';
const DEVICE_TOKEN = `mvd_11111111-1111-4111-8111-111111111111_${'a'.repeat(43)}`;

function safeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8'),
  };
}

/** Stands in for a Hello key: a deterministic 256-byte "signature" that depends on a per-device secret. */
function fakeSigner(deviceSecret: string, failure?: PlatformUnlockError) {
  const calls = { enroll: 0, sign: 0, removed: [] as string[] };
  const signature = (keyName: string, challenge: Uint8Array) => {
    const block = createHmac('sha256', deviceSecret).update(keyName).update(challenge).digest();
    return new Uint8Array(Buffer.concat(Array.from({ length: 8 }, () => block)));
  };
  const signer: PlatformUnlockSigner = {
    isAvailable: async () => true,
    enroll: async (keyName, challenge) => { calls.enroll += 1; if (failure) throw failure; return signature(keyName, challenge); },
    sign: async (keyName, challenge) => { calls.sign += 1; if (failure) throw failure; return signature(keyName, challenge); },
    remove: async (keyName) => { calls.removed.push(keyName); },
  };
  return { signer, calls };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pb-hello-'));
  const store = new MyVaultDiskStore(root, safeStorage());
  const broker = new VaultBroker(store);
  broker.initialize();
  const { envelope } = await createVault(PASSWORD, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
  broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: DEVICE_TOKEN, remoteVersion: 3, dirty: false });
  return { root, store, broker, envelope };
}

async function enrolled(deviceSecret = 'this-device') {
  const context = await setup();
  const device = fakeSigner(deviceSecret);
  await context.broker.unlock(PASSWORD);
  await context.broker.enrollPlatformUnlock(PASSWORD, device.signer);
  context.broker.lock();
  return { ...context, device };
}

describe('Windows Hello unlock', () => {
  it('opens the vault from the Hello signature after enrollment', async () => {
    const { broker, store, device } = await enrolled();
    expect(broker.status()).toMatchObject({ lifecycle: 'locked', platformUnlockEnrolled: true });
    expect(existsSync(store.platformUnlockPath)).toBe(true);
    await broker.unlockWithPlatform(device.signer);
    expect(broker.status().lifecycle).toBe('unlocked');
    expect(broker.searchMetadata()).toEqual([]);
  });

  it('survives a restart: the record is read back from disk', async () => {
    const { root, device } = await enrolled();
    const reopened = new VaultBroker(new MyVaultDiskStore(root, safeStorage()));
    expect(reopened.initialize()).toMatchObject({ lifecycle: 'locked', platformUnlockEnrolled: true });
    await reopened.unlockWithPlatform(device.signer);
    expect(reopened.status().lifecycle).toBe('unlocked');
  });

  it('checks the master password before raising any Hello prompt', async () => {
    const { broker } = await setup();
    const device = fakeSigner('this-device');
    await broker.unlock(PASSWORD);
    await expect(broker.enrollPlatformUnlock('wrong password entirely', device.signer)).rejects.toBeInstanceOf(InvalidMasterPasswordError);
    expect(device.calls.enroll).toBe(0);
    expect(broker.status().platformUnlockEnrolled).toBe(false);
  });

  it('refuses enrollment while the vault is locked', async () => {
    const { broker } = await setup();
    await expect(broker.enrollPlatformUnlock(PASSWORD, fakeSigner('x').signer)).rejects.toThrow('locked');
  });

  it('rejects a signature from another Hello key and drops the stale enrollment', async () => {
    const { broker, store } = await enrolled('this-device');
    await expect(broker.unlockWithPlatform(fakeSigner('another-device').signer)).rejects.toBeInstanceOf(BiometricUnlockRejectedError);
    expect(broker.status()).toMatchObject({ lifecycle: 'locked', platformUnlockEnrolled: false });
    expect(existsSync(store.platformUnlockPath)).toBe(false);
  });

  it('drops the enrollment when Windows no longer has the key', async () => {
    const { broker } = await enrolled();
    await expect(broker.unlockWithPlatform(fakeSigner('x', new PlatformUnlockError('NotFound')).signer)).rejects.toMatchObject({ status: 'NotFound' });
    expect(broker.status().platformUnlockEnrolled).toBe(false);
  });

  it('keeps the enrollment when the person cancels the prompt', async () => {
    const { broker } = await enrolled();
    await expect(broker.unlockWithPlatform(fakeSigner('x', new PlatformUnlockError('UserCanceled')).signer)).rejects.toMatchObject({ status: 'UserCanceled' });
    expect(broker.status()).toMatchObject({ lifecycle: 'locked', platformUnlockEnrolled: true });
  });

  it('turning it off deletes the record and the Hello key', async () => {
    const { broker, store, envelope, device } = await enrolled();
    await broker.removePlatformUnlock(device.signer);
    expect(existsSync(store.platformUnlockPath)).toBe(false);
    expect(device.calls.removed).toEqual([platformUnlockKeyName(envelope.vaultId)]);
    await expect(broker.unlockWithPlatform(device.signer)).rejects.toThrow('not set up');
  });

  it('forgets the enrollment when a different vault is installed', async () => {
    const { broker } = await enrolled();
    const { envelope: other } = await createVault(PASSWORD, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
    broker.installEncryptedVault(other, { endpoint: 'https://vault.example.test', deviceToken: DEVICE_TOKEN, remoteVersion: 1, dirty: false });
    expect(broker.status().platformUnlockEnrolled).toBe(false);
  });

  it('discards an unreadable record instead of blocking the vault', async () => {
    const { root, store } = await enrolled();
    writeFileSync(store.platformUnlockPath, 'not ciphertext');
    const reopened = new VaultBroker(new MyVaultDiskStore(root, safeStorage()));
    expect(reopened.initialize()).toMatchObject({ lifecycle: 'locked', platformUnlockEnrolled: false });
    expect(existsSync(store.platformUnlockPath)).toBe(false);
    await reopened.unlock(PASSWORD);
    expect(reopened.status().lifecycle).toBe('unlocked');
  });
});

describe('WindowsHelloSigner', () => {
  const keyName = platformUnlockKeyName('vault-0123456789abcdef');

  it('is unavailable off Windows without starting a process', async () => {
    let ran = false;
    const signer = new WindowsHelloSigner(async () => { ran = true; return { ok: true, available: true }; }, 'linux');
    expect(await signer.isAvailable()).toBe(false);
    await expect(signer.sign(keyName, new Uint8Array(32))).rejects.toMatchObject({ status: 'Unsupported' });
    expect(ran).toBe(false);
  });

  it('returns the signature and sends the challenge as base64', async () => {
    const seen: unknown[] = [];
    const signature = Buffer.alloc(256, 7).toString('base64');
    const signer = new WindowsHelloSigner(async (request) => { seen.push(request); return { ok: true, signature }; }, 'win32');
    expect(Buffer.from(await signer.sign(keyName, new Uint8Array(32).fill(1))).toString('base64')).toBe(signature);
    expect(seen).toEqual([{ op: 'sign', keyName, challenge: Buffer.alloc(32, 1).toString('base64') }]);
  });

  it('maps Windows statuses and refuses short or unknown answers', async () => {
    const answer = (reply: object) => new WindowsHelloSigner(async () => reply, 'win32').sign(keyName, new Uint8Array(32));
    await expect(answer({ ok: false, status: 'UserCanceled' })).rejects.toMatchObject({ status: 'UserCanceled' });
    await expect(answer({ ok: false, status: 'SomethingNew' })).rejects.toMatchObject({ status: 'Error' });
    await expect(answer({ ok: true, signature: Buffer.alloc(16).toString('base64') })).rejects.toMatchObject({ status: 'Error' });
  });

  it('only accepts key names it minted', async () => {
    const signer = new WindowsHelloSigner(async () => ({ ok: true }), 'win32');
    await expect(signer.sign('Someone-Else-Key', new Uint8Array(32))).rejects.toThrow('Invalid Windows Hello key name');
    expect(() => platformUnlockKeyName('short')).toThrow();
  });
});

describe('enroll-hello secure dialog', () => {
  it('accepts only a bounded password', () => {
    expect(parseSecureDialogValue('enroll-hello', { password: 'value' })).toEqual({ password: 'value' });
    expect(() => parseSecureDialogValue('enroll-hello', { password: '' })).toThrow();
    expect(() => parseSecureDialogValue('enroll-hello', { password: 'x'.repeat(1025) })).toThrow();
  });
});
