import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyVaultPayload, createVault } from '../electron/myvault/security/vault-crypto';
import { VaultBroker } from '../electron/myvault/vault-broker';
import { MyVaultDiskStore, type SafeStorageAdapter } from '../electron/myvault/vault-store';

const PASSWORD = 'correct horse battery staple';
const DEVICE_TOKEN = `mvd_11111111-1111-4111-8111-111111111111_${'a'.repeat(43)}`;

function safeStorage(): SafeStorageAdapter {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8'),
  };
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pb-myvault-'));
  const store = new MyVaultDiskStore(root, safeStorage());
  const broker = new VaultBroker(store);
  broker.initialize();
  const { envelope } = await createVault(PASSWORD, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
  broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: DEVICE_TOKEN, remoteVersion: 3, dirty: false });
  return { store, broker, envelope };
}

describe('VaultBroker', () => {
  it('keeps decrypted state unavailable until unlock and releases it on lock', async () => {
    const { broker } = await setup();
    expect(() => broker.searchMetadata()).toThrow('locked');
    await broker.unlock(PASSWORD);
    expect(broker.searchMetadata()).toEqual([]);
    const generation = broker.status().generation;
    broker.lock();
    expect(broker.status().generation).toBe(generation + 1);
    expect(() => broker.searchMetadata()).toThrow('locked');
  });

  it('re-encrypts and atomically persists each accepted mutation', async () => {
    const { broker, store, envelope } = await setup();
    await broker.unlock(PASSWORD);
    const saved = await broker.saveLogin({ title: 'Example', username: 'person@example.test', password: 'secret-value', url: 'https://example.test/login' });
    expect(saved).toMatchObject({ title: 'Example', url: 'https://example.test', hasPassword: true });
    expect(broker.status()).toMatchObject({ dirty: true, sync: 'dirty' });
    const diskText = readFileSync(store.envelopePath, 'utf8');
    expect(diskText).not.toContain('secret-value');
    expect(diskText).not.toContain('person@example.test');
    expect(JSON.parse(diskText).payload.ciphertext).not.toBe(envelope.payload.ciphertext);
  });

  it('projects metadata only and exact-matches normalized origins', async () => {
    const { broker } = await setup();
    await broker.unlock(PASSWORD);
    const saved = await broker.saveLogin({ title: 'Console', username: 'alice', password: 'not-renderer-data', url: 'https://example.test/path' });
    expect(broker.searchMetadata('', 'https://example.test/elsewhere')).toEqual([saved]);
    expect(broker.searchMetadata('', 'http://example.test')).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain('not-renderer-data');
    expect(broker.resolveSecretForTrustedOperation(saved.id, 'password')).toBe('not-renderer-data');
  });

  it('enters explicit conflict state without modifying ciphertext', async () => {
    const { broker, store } = await setup();
    const before = readFileSync(store.envelopePath, 'utf8');
    broker.markConflict();
    expect(broker.status()).toMatchObject({ lifecycle: 'conflict', sync: 'conflict' });
    expect(readFileSync(store.envelopePath, 'utf8')).toBe(before);
  });

  it('unlocks and edits from local ciphertext without network access', async () => {
    const { store } = await setup();
    const restarted = new VaultBroker(new MyVaultDiskStore(dirname(dirname(store.envelopePath)), safeStorage()));
    expect(restarted.initialize()).toMatchObject({ lifecycle: 'locked', remoteVersion: 3 });
    await restarted.unlock(PASSWORD);
    await restarted.saveLogin({ title: 'Offline', username: 'local', password: 'offline-secret', url: 'https://offline.example' });
    expect(restarted.searchMetadata()).toHaveLength(1);
    expect(restarted.status()).toMatchObject({ dirty: true, sync: 'dirty' });
  });
});

describe('MyVaultDiskStore recovery', () => {
  it('preserves corrupt ciphertext and blocks writes until acknowledgement', () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-myvault-corrupt-'));
    const store = new MyVaultDiskStore(root, safeStorage(), () => new Date('2026-09-12T12:00:00Z'));
    mkdirSync(dirname(store.envelopePath), { recursive: true });
    writeFileSync(store.envelopePath, '{broken', 'utf8');
    const snapshot = store.load();
    expect(snapshot.blocked).toBe('envelope-corrupt');
    expect(snapshot.recoveryPath).toContain('.recovery-2026-09-12T12-00-00-000Z');
    expect(readFileSync(snapshot.recoveryPath!, 'utf8')).toBe('{broken');
    expect(() => store.writeConnection({ endpoint: 'https://vault.example.test', deviceToken: DEVICE_TOKEN, remoteVersion: 0, dirty: false })).toThrow('blocked');
    store.acknowledgeRecovery();
  });

  it('refuses credential persistence when OS encryption is unavailable', async () => {
    const unavailable: SafeStorageAdapter = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unreachable'); }, decryptString: () => { throw new Error('unreachable'); } };
    const store = new MyVaultDiskStore(mkdtempSync(join(tmpdir(), 'pb-myvault-no-os-')), unavailable);
    const broker = new VaultBroker(store);
    broker.initialize();
    const { envelope } = await createVault(PASSWORD, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
    expect(() => broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: DEVICE_TOKEN, remoteVersion: 0, dirty: false })).toThrow('operating-system');
  });
});
