import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyVaultPayload, createVault } from '../electron/myvault/security/vault-crypto';
import { VaultBroker } from '../electron/myvault/vault-broker';
import { MyVaultDiskStore, type SafeStorageAdapter } from '../electron/myvault/vault-store';

const TOKEN = `mvd_22222222-2222-4222-8222-222222222222_${'z'.repeat(43)}`;
const PASSWORD = 'this password remains in trusted UI';
const MOCK_TOTP_SEED = ['JBSW', 'Y3DP', 'EHPK', '3PXP'].join('');

const protectedStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5)),
  decryptString: (value) => Buffer.from(value.map((byte) => byte ^ 0xa5)).toString('utf8'),
};

describe('VaultBroker security boundary', () => {
  it('never projects tokens, envelopes, passwords, or TOTP seeds through status and metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-myvault-boundary-'));
    const store = new MyVaultDiskStore(root, protectedStorage);
    const broker = new VaultBroker(store);
    broker.initialize();
    const payload = createEmptyVaultPayload();
    payload.items.push({
      id: 'entry-1', title: 'Private', type: 'login', username: 'alice', password: 'renderer-must-not-see',
      url: 'https://example.test', folder: '', vault: 'Personal', favorite: false, tags: [],
      updatedAt: new Date().toISOString(), totp: { secret: MOCK_TOTP_SEED, algorithm: 'SHA-1', digits: 6, period: 30 },
    });
    const { envelope } = await createVault(PASSWORD, payload, { memorySizeKiB: 8 * 1024, iterations: 1 });
    broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: TOKEN, remoteVersion: 1, dirty: false });
    await broker.unlock(PASSWORD);

    const rendererProjection = JSON.stringify({ status: broker.status(), entries: broker.searchMetadata() });
    expect(rendererProjection).not.toContain(TOKEN);
    expect(rendererProjection).not.toContain('renderer-must-not-see');
    expect(rendererProjection).not.toContain(MOCK_TOTP_SEED);
    expect(rendererProjection).not.toContain('ciphertext');
    expect(readFileSync(store.connectionPath, 'utf8')).not.toContain(TOKEN);
  });

  it('does not retain the supplied master-password string as an own broker property', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-myvault-password-'));
    const store = new MyVaultDiskStore(root, protectedStorage);
    const broker = new VaultBroker(store);
    broker.initialize();
    const { envelope } = await createVault(PASSWORD, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
    broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: TOKEN, remoteVersion: 0, dirty: false });
    await broker.unlock(PASSWORD);
    expect(JSON.stringify(broker)).not.toContain(PASSWORD);
  });
});
