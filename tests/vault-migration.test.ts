import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyVaultPayload, createVault } from '../electron/myvault/security/vault-crypto';
import { VaultBroker } from '../electron/myvault/vault-broker';
import { VaultMigrationService } from '../electron/myvault/vault-migration';
import { MyVaultDiskStore, type SafeStorageAdapter } from '../electron/myvault/vault-store';

const PASSWORD = 'correct horse battery staple';
const TOKEN = `mvd_55555555-5555-4555-8555-555555555555_${'m'.repeat(43)}`;
const storage: SafeStorageAdapter = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };

async function setup(items: object[]) {
  const root = mkdtempSync(join(tmpdir(), 'pb-migration-'));
  const legacyPath = join(root, 'vault.enc');
  const journalPath = join(root, 'myvault', 'migration-journal.enc');
  writeFileSync(legacyPath, storage.encryptString(JSON.stringify(items)).toString('base64'), 'utf8');
  const broker = new VaultBroker(new MyVaultDiskStore(root, storage));
  broker.initialize();
  const { envelope } = await createVault(PASSWORD, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
  broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: TOKEN, remoteVersion: 1, dirty: false });
  await broker.unlock(PASSWORD);
  return { root, legacyPath, journalPath, broker, migration: new VaultMigrationService(legacyPath, journalPath, storage, broker, () => new Date('2026-09-12T12:00:00Z')) };
}

const legacy = (id: string, url = 'https://example.test/login', password = 'legacy-value') => ({ id, label: `Login ${id}`, url, username: 'alice', password, totpSecret: 'MOCKTOTPSEED', updatedAt: '2026-08-01T10:00:00.000Z' });

describe('legacy vault migration', () => {
  it('hash-verifies a ciphertext backup, imports secrets only through the broker, and is idempotent', async () => {
    const { legacyPath, journalPath, broker, migration } = await setup([legacy('old-1')]);
    const report = await migration.migrateLegacy();
    expect(report).toMatchObject({ sourceCount: 1, importedCount: 1, validatedCount: 1, journalPhase: 'validated', conflicts: [] });
    expect(existsSync(legacyPath)).toBe(true);
    expect(readFileSync(report.backupPath, 'utf8')).toBe(readFileSync(legacyPath, 'utf8'));
    expect(readFileSync(journalPath, 'utf8')).not.toContain('legacy-value');
    expect(JSON.stringify(report)).not.toContain('legacy-value');
    expect(broker.searchMetadata()).toHaveLength(1);
    expect((await migration.migrateLegacy()).importedCount).toBe(1);
    expect(broker.searchMetadata()).toHaveLength(1);
  });

  it('resumes after interruption without duplicating confirmed records', async () => {
    const { broker, migration } = await setup([legacy('old-1', 'https://one.example'), legacy('old-2', 'https://two.example')]);
    const original = broker.saveLogin.bind(broker);
    let calls = 0;
    broker.saveLogin = async (input) => { calls += 1; if (calls === 2) throw new Error('simulated interruption'); return original(input); };
    await expect(migration.migrateLegacy()).rejects.toThrow('simulated interruption');
    broker.saveLogin = original;
    const report = await migration.migrateLegacy();
    expect(report).toMatchObject({ importedCount: 2, validatedCount: 2, journalPhase: 'validated' });
    expect(broker.searchMetadata()).toHaveLength(2);
  });

  it('requires a choice before replacing a changed matching login and never auto-deletes', async () => {
    const { legacyPath, broker, migration } = await setup([legacy('old-1', 'https://example.test', 'legacy')]);
    await broker.saveLogin({ title: 'Current', url: 'https://example.test', username: 'alice', password: 'current' });
    const pending = await migration.migrateLegacy();
    expect(pending.conflicts).toHaveLength(1);
    expect(broker.resolveSecretForTrustedOperation(pending.conflicts[0].targetId, 'password')).toBe('current');
    expect(migration.cleanupLegacyAfterConfirmation(true)).toBe(false);
    const resolved = await migration.migrateLegacy({ 'old-1': 'replace' });
    expect(resolved.journalPhase).toBe('validated');
    expect(migration.cleanupLegacyAfterConfirmation(false)).toBe(false);
    expect(existsSync(legacyPath)).toBe(true);
    expect(migration.cleanupLegacyAfterConfirmation(true)).toBe(true);
  });
});
