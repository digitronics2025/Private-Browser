import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyVaultPayload, createVault, encryptVaultPayload, parseVaultArchive, unlockVault } from '../electron/myvault/security/vault-crypto';
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

  it.each([401, 403])('maps a %i (wrong, revoked or read-only credential) to one unauthorized type', async (status) => {
    const client = new MyVaultSyncClient(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status }));
    const { envelope } = await brokerSetup();
    await expect(client.fetchVault('https://vault.example.test', TOKEN)).rejects.toBeInstanceOf(VaultSyncUnauthorizedError);
    await expect(client.pushVault('https://vault.example.test', TOKEN, envelope, 1)).rejects.toBeInstanceOf(VaultSyncUnauthorizedError);
  });

  it('sends the device token only as a bearer header and refuses redirects', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const { envelope } = await brokerSetup();
    const client = new MyVaultSyncClient(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ envelope, version: 2, updatedAt: new Date().toISOString() }), { status: 200 });
    });
    await client.fetchVault('https://vault.example.test', TOKEN);
    await client.pushVault('https://vault.example.test', TOKEN, envelope, 1);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(call.url).not.toContain(TOKEN);
      expect(call.init?.redirect).toBe('error');
    }
  });

  it('refuses an enrollment token the store could never persist, before anything is installed', async () => {
    const client = new MyVaultSyncClient(async () => new Response(JSON.stringify({ token: 'mvd_short', device: { id: 'd', label: 'B', scope: 'read-write' } }), { status: 201 }));
    await expect(client.redeem('https://vault.example.test', `mve_44444444-4444-4444-8444-444444444444_${'e'.repeat(43)}`)).rejects.toThrow('Invalid MyVault enrollment response');
  });

  it('refuses an oversized response', async () => {
    const client = new MyVaultSyncClient(async () => new Response('x', { status: 200, headers: { 'content-length': String(64 * 1024 * 1024) } }));
    await expect(client.fetchVault('https://vault.example.test', TOKEN)).rejects.toThrow('too large');
  });
});

describe('VaultSyncController', () => {
  it('keeps both reviewed ciphertext copies recoverable before applying a cloud choice', async () => {
    const { broker, envelope } = await brokerSetup();
    const login = await broker.saveLogin({ title: 'Local only entry', username: 'fixture-user', password: 'local copy synthetic password', url: 'https://local.example.test' });
    const updatedAt = new Date().toISOString();
    const cloud = { envelope, version: 4, updatedAt };
    broker.setConflict(cloud);
    const methods: Array<string | undefined> = [];
    const client = new MyVaultSyncClient(async (_url, init) => {
      methods.push(init?.method);
      return new Response(JSON.stringify(cloud), { status: 200 });
    });
    const resolver = new VaultSyncController(broker, client);
    const review = await resolver.reviewConflict();
    expect(review).toMatchObject({ cloudVersion: 4, cloudUpdatedAt: updatedAt, local: [{ title: login.title }], cloud: [] });
    expect(JSON.stringify(review)).not.toContain('local copy synthetic password');
    await resolver.resolveConflict('cloud', review.id);
    expect(methods).toEqual(['GET']);
    expect(broker.searchMetadata()).toHaveLength(0);
    const root = broker.conflictRecoveryFolder()!;
    const folders = readdirSync(root);
    expect(folders).toHaveLength(1);
    const localCopy = readFileSync(join(root, folders[0]!, 'local.myvault'), 'utf8');
    const cloudCopy = readFileSync(join(root, folders[0]!, 'cloud.myvault'), 'utf8');
    expect(localCopy).not.toContain('local copy synthetic password');
    expect((await unlockVault(PASSWORD, parseVaultArchive(localCopy))).payload.items[0]).toMatchObject({ id: login.id });
    expect(parseVaultArchive(cloudCopy)).toEqual(envelope);
    expect(() => resolver.resolveConflict('cloud', review.id)).toThrow(/Review the current/);
  });

  it('requires a fresh review when another device updates the vault after inspection', async () => {
    const { broker, envelope } = await brokerSetup();
    await broker.saveLogin({ title: 'Local draft', username: 'fixture-user', password: 'fixture-secret', url: 'https://local.example.test' });
    const cloud = { envelope, version: 2, updatedAt: new Date().toISOString() };
    broker.setConflict(cloud);
    let version = 3;
    let writes = 0;
    const client = new MyVaultSyncClient(async (_url, init) => {
      if (init?.method === 'PUT') { writes++; version = 4; return new Response(JSON.stringify({ ...cloud, version }), { status: 409 }); }
      return new Response(JSON.stringify({ ...cloud, version }), { status: 200 });
    });
    const resolver = new VaultSyncController(broker, client);
    const first = await resolver.reviewConflict();
    await expect(resolver.resolveConflict('local', first.id)).rejects.toThrow(/cloud vault changed/i);
    expect(writes).toBe(0);
    expect(broker.conflictRecoveryFolder()).toBeUndefined();
    const updated = await resolver.reviewConflict();
    expect(updated.cloudVersion).toBe(3);
    await expect(resolver.resolveConflict('local', updated.id)).rejects.toBeInstanceOf(VaultSyncConflictError);
    expect(writes).toBe(1);
    expect((await resolver.reviewConflict()).cloudVersion).toBe(4);
    expect(broker.status()).toMatchObject({ lifecycle: 'conflict', dirty: true, remoteVersion: 1 });
    expect(broker.conflictRecoveryFolder()).toBeDefined();
  });

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

  // F-27: unlock always starts a pull; a login saved while it is in flight used
  // to be overwritten by the pulled envelope and reported as "synced".
  it('keeps a login saved while a pull is in flight and asks instead of overwriting', async () => {
    const { broker, envelope } = await brokerSetup();
    const remoteSession = await unlockVault(PASSWORD, envelope);
    const remotePayload = { ...createEmptyVaultPayload(), items: [{ id: 'remote', title: 'Remote', type: 'login' as const, username: 'r', password: 'r', url: 'https://remote.example', folder: '', vault: 'Personal', favorite: false, tags: [], updatedAt: new Date().toISOString() }] };
    const remoteEnvelope = await encryptVaultPayload(remotePayload, envelope, remoteSession.session);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = new MyVaultSyncClient(async () => {
      await gate;
      return new Response(JSON.stringify({ envelope: remoteEnvelope, version: 2, updatedAt: new Date().toISOString() }), { status: 200 });
    });
    const syncing = new VaultSyncController(broker, client).syncNow();
    await broker.saveLogin({ title: 'Local', username: 'l', password: 'l', url: 'https://local.example' });
    release();
    await expect(syncing).rejects.toBeInstanceOf(VaultSyncConflictError);
    expect(broker.status()).toMatchObject({ lifecycle: 'conflict', sync: 'conflict', dirty: true });
    const review = await broker.conflictReview();
    expect(review.local.map((item) => item.title)).toEqual(['Local']);
    expect(review.cloud.map((item) => item.title)).toEqual(['Remote']);
  });

  // F-29: a sync finishing after the user locked used to report "unlocked" again.
  it('leaves the vault locked when a push completes after lock', async () => {
    const { broker } = await brokerSetup(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = new MyVaultSyncClient(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { envelope: VaultEnvelope };
      await gate;
      return new Response(JSON.stringify({ envelope: body.envelope, version: 2, updatedAt: new Date().toISOString() }), { status: 200 });
    });
    const syncing = new VaultSyncController(broker, client).syncNow();
    broker.lock();
    release();
    await syncing;
    expect(broker.status()).toMatchObject({ lifecycle: 'locked', remoteVersion: 2, dirty: false });
    expect(() => broker.searchMetadata()).toThrow('locked');
  });

  it('does not re-open the vault when a pull completes after lock', async () => {
    const { broker, envelope } = await brokerSetup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const client = new MyVaultSyncClient(async () => {
      await gate;
      return new Response(JSON.stringify({ envelope, version: 5, updatedAt: new Date().toISOString() }), { status: 200 });
    });
    const syncing = new VaultSyncController(broker, client).syncNow();
    broker.lock();
    release();
    await expect(syncing).rejects.toThrow('locked');
    expect(broker.status().lifecycle).toBe('locked');
  });

  it('refuses a pulled envelope from a different vault identity', async () => {
    const { broker } = await brokerSetup();
    const other = await createVault(PASSWORD, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
    const client = new MyVaultSyncClient(async () => new Response(JSON.stringify({ envelope: other.envelope, version: 2, updatedAt: new Date().toISOString() }), { status: 200 }));
    await expect(new VaultSyncController(broker, client).syncNow()).rejects.toThrow('different vault');
    expect(broker.status().sync).toBe('error');
  });
});
