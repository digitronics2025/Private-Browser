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

  it('exposes only skip metadata and rechecks the selected file and vault before import', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-chrome-review-'));
    const csvPath = join(root, 'fixture.csv');
    const csv = 'name,url,username,password,note\nShop,https://shop.example.test/path,alex,fixture-value,fixture-note\nAgain,https://shop.example.test,alex,duplicate-value,\nApp,android://ignored,alex,app-value,\n';
    writeFileSync(csvPath, csv, 'utf8');
    const broker = new VaultBroker(new MyVaultDiskStore(root, storage));
    broker.initialize();
    const password = 'correct horse battery staple';
    const { envelope } = await createVault(password, createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
    broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: `mvd_66666666-6666-4666-8666-666666666666_${'n'.repeat(43)}`, remoteVersion: 1, dirty: false });
    await broker.unlock(password);
    const migration = new VaultMigrationService(join(root, 'vault.enc'), join(root, 'journal.enc'), storage, broker);
    const selected = migration.reviewChromeCsv(csvPath);
    expect(selected.review).toEqual({
      sourceCount: 3, toImport: 1, skipped: { 'unsupported-site': 1, 'duplicate-in-file': 1 },
      issues: [{ entry: 2, reason: 'duplicate-in-file', origin: 'https://shop.example.test', username: 'alex' }, { entry: 3, reason: 'unsupported-site' }],
    });
    expect(broker.searchMetadata()).toEqual([]);
    writeFileSync(csvPath, csv.replace('fixture-value', 'changed-value'), 'utf8');
    await expect(migration.importReviewedChromeCsv(csvPath, selected.digest, selected.revision)).rejects.toThrow(/CSV changed/i);
    writeFileSync(csvPath, csv, 'utf8');
    await broker.saveLogin({ title: 'Unrelated', url: 'https://stock.example.test', username: 'alex' });
    await expect(migration.importReviewedChromeCsv(csvPath, selected.digest, selected.revision)).rejects.toThrow(/MyVault changed/i);
    const current = migration.reviewChromeCsv(csvPath);
    await expect(migration.importReviewedChromeCsv(csvPath, current.digest, current.revision)).resolves.toMatchObject({ imported: 1 });
    expect(migration.reviewChromeCsv(csvPath).review).toMatchObject({ toImport: 0, skipped: { 'already-saved': 2, 'unsupported-site': 1 } });
  });

  // F-33: Chrome exports app logins as android:// rows; one used to abort the
  // import and leave every later row unimportable.
  it('skips Android and unparsable rows and still imports every web login after them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pb-chrome-android-'));
    const csvPath = join(root, 'Chrome Passwords.csv');
    writeFileSync(csvPath, '﻿name,url,username,password,note\nFirst,https://first.example/,a,one,\nBank app,android://hash@com.bank.app/,b,two,\nBroken,https://,c,three,\nNo user,https://nouser.example/,,four,\nLast,https://last.example/login,d,  spaced  ,note\n', 'utf8');
    const broker = new VaultBroker(new MyVaultDiskStore(root, storage));
    broker.initialize();
    const { envelope } = await createVault('correct horse battery staple', createEmptyVaultPayload(), { memorySizeKiB: 8 * 1024, iterations: 1 });
    broker.installEncryptedVault(envelope, { endpoint: 'https://vault.example.test', deviceToken: `mvd_66666666-6666-4666-8666-666666666666_${'n'.repeat(43)}`, remoteVersion: 1, dirty: false });
    await broker.unlock('correct horse battery staple');
    const migration = new VaultMigrationService(join(root, 'vault.enc'), join(root, 'journal.enc'), storage, broker);
    const report = await migration.importChromeCsv(csvPath);
    expect(report).toMatchObject({ sourceCount: 5, importedCount: 3, skippedCount: 2 });
    const byTitle = new Map(broker.searchMetadata().map((item) => [item.title, item]));
    expect([...byTitle.keys()].sort()).toEqual(['First', 'Last', 'No user']);
    expect(broker.resolveSecretForTrustedOperation(byTitle.get('Last')!.id, 'password')).toBe('  spaced  ');
    // A second run imports nothing new and does not throw.
    await expect(migration.importChromeCsv(csvPath)).resolves.toMatchObject({ importedCount: 0 });
  });
});
