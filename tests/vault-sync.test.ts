import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyVaultPayload, createVault } from '../electron/myvault/security/vault-crypto';
import { VaultBroker } from '../electron/myvault/vault-broker';
import { MyVaultDiskStore, type SafeStorageAdapter } from '../electron/myvault/vault-store';
import { VaultSyncController } from '../electron/myvault/sync-controller';
import { MyVaultSyncClient, VaultSyncConflictError, VaultSyncUnauthorizedError } from '../electron/myvault/vault-sync';
import type { VaultEnvelope } from '../electron/myvault/types';

const PASSWORD = 'correct horse battery staple';
const TOKEN = `mvd_33333333-3333-4333-8333-333333333333_${'q'.repeat(43)}`;
const storage: SafeStorageAdapter = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };

async function brokerSetup(dirty = false) {
  const broker = new VaultBroker(new MyVaultDiskStore(mkdtempSync(join(tmpdir(), 'pb-sync-')), storage));
  broker.initialize();
  const { envelope } = await createVault(PASSWORD, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
  broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: TOKEN, remoteVersion: 1, dirty });
  await broker.unlock(PASSWORD);
  return { broker, envelope };
}

describe('MyVaultSyncClient contract', () => {
  it('redeems once and sends the device credential only in Authorization', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const client = new MyVaultSyncClient(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ token: TOKEN, device: { id: 'device', label: 'Browser', scope: 'read-write' } }), { status: 201 });
    });
    await expect(client.redeem('https://vault.example.test', `mve_44444444-4444-4444-8444-444444444444_${'e'.repeat(43)}`)).resolves.toMatchObject({ token: TOKEN });
    expect(calls[0].url).toBe('https://vault.example.test/api/v1/devices/redeem');
    expect(new Headers(calls[0].init?.headers).has('authorization')).toBe(false);
  });

  it('maps wrong, revoked, and read-only write credentials to one unauthorized type', async () => {
    const client = new MyVaultSyncClient(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    const { envelope } = await brokerSetup();
    await expect(client.fetchVault('https://vault.example.test', TOKEN)).rejects.toBeInstanceOf(VaultSyncUnauthorizedError);
    await expect(client.pushVault('https://vault.example.test', TOKEN, envelope, 1)).rejects.toBeInstanceOf(VaultSyncUnauthorizedError);
  });
});

describe('VaultSyncController', () => {
  it('preserves a newer local edit made while a push is in flight', async () => {
    const { broker } = await brokerSetup();
    await broker.saveLogin({ title: 'First', username: 'a', password: 'one', url: 'https://one.example' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = new MyVaultSyncClient(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { envelope: VaultEnvelope };
      await gate;
      return new Response(JSON.stringify({ envelope: body.envelope, version: 2, updatedAt: new Date().toISOString() }), { status: 200 });
    });
    const syncing = new VaultSyncController(broker, client).syncNow();
    await broker.saveLogin({ title: 'Second', username: 'b', password: 'two', url: 'https://two.example' });
    release();
    await syncing;
    expect(broker.status()).toMatchObject({ remoteVersion: 2, dirty: true, sync: 'dirty' });
    expect(broker.searchMetadata()).toHaveLength(2);
  });

  it('enters an explicit conflict and never overwrites automatically', async () => {
    const { broker, envelope } = await brokerSetup();
    await broker.saveLogin({ title: 'Local', username: 'a', password: 'one', url: 'https://local.example' });
    const client = new MyVaultSyncClient(async () => new Response(JSON.stringify({ envelope, version: 2, updatedAt: new Date().toISOString() }), { status: 409 }));
    await expect(new VaultSyncController(broker, client).syncNow()).rejects.toBeInstanceOf(VaultSyncConflictError);
    expect(broker.status()).toMatchObject({ lifecycle: 'conflict', sync: 'conflict', dirty: true });
    expect((await broker.conflictReview()).local).toHaveLength(1);
  });

  it('refuses a pulled envelope from a different vault identity', async () => {
    const { broker } = await brokerSetup();
    const other = await createVault(PASSWORD, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
    const client = new MyVaultSyncClient(async () => new Response(JSON.stringify({ envelope: other.envelope, version: 2, updatedAt: new Date().toISOString() }), { status: 200 }));
    await expect(new VaultSyncController(broker, client).syncNow()).rejects.toThrow('different vault');
    expect(broker.status().sync).toBe('error');
  });
});
