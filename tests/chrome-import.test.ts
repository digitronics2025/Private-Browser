import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEmptyVaultPayload, createVault } from '../electron/myvault/security/vault-crypto';
import { VaultBroker } from '../electron/myvault/vault-broker';
import { VaultMigrationService } from '../electron/myvault/vault-migration';
import { MyVaultDiskStore, type SafeStorageAdapter } from '../electron/myvault/vault-store';

const storage: SafeStorageAdapter = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };

describe('Chrome password CSV import', () => {
  it('routes rows directly into MyVault, handles quoted fields and retains plaintext CSV', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-chrome-'));
    const csvPath = join(root, 'Chrome Passwords.csv');
    writeFileSync(csvPath, 'name,url,username,password,note\n"Example, Inc",https://example.test/path,alice,"commas, work",memo\nDuplicate,https://example.test,alice,other,\nInvalid,,bob,value,\n', 'utf8');
    const broker = new VaultBroker(new MyVaultDiskStore(root, storage));
    broker.initialize();
    const { envelope } = await createVault('correct horse battery staple', createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
    const token = `mvd_66666666-6666-4666-8666-666666666666_${'n'.repeat(43)}`;
    broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: token, remoteVersion: 1, dirty: false });
    await broker.unlock('correct horse battery staple');
    const migration = new VaultMigrationService(join(root, 'vault.enc'), join(root, 'journal.enc'), storage, broker);
    const report = await migration.importChromeCsv(csvPath);
    expect(report).toMatchObject({ sourceCount: 3, importedCount: 1, skippedCount: 2, validatedCount: 3 });
    expect(broker.resolveSecretForTrustedOperation(broker.searchMetadata()[0].id, 'password')).toBe('commas, work');
    expect(existsSync(csvPath)).toBe(true);
  });
});
