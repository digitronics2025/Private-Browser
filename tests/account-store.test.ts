import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccountStore, newPartitionKey, validateAvatar, type SafeStorageAdapter } from '../electron/account-store';
import type { AccountSpaceId } from '../electron/types';

class TestEncryption implements SafeStorageAdapter {
  private readonly key = randomBytes(32);
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }
  decryptString(value: Buffer): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  }
}

const FIRST_ID = '122b503d-a1b3-497a-a610-e193af8d0702' as AccountSpaceId;
const SECOND_ID = '6ba2c705-9ba8-4f4a-9af2-46f8a36f9fc4' as AccountSpaceId;

function makeStore(now = new Date('2026-09-12T10:00:00.000Z')) {
  const directory = mkdtempSync(join(tmpdir(), 'private-browser-accounts-'));
  return { directory, store: new AccountStore(directory, new TestEncryption(), () => now) };
}

describe('encrypted Account Space store', () => {
  it('writes one opaque encrypted file per account and exposes only sanitized summaries', () => {
    const { directory, store } = makeStore();
    store.createLocal({ id: FIRST_ID, workspaceId: 'digitronics', label: 'Sales', color: 'indigo', order: 0 });
    store.saveGoogleGrant(
      FIRST_ID,
      { sub: 'google-subject-1', email: 'sales@example.test', displayName: 'Sales team', emailVerified: true },
      'refresh-token-private',
      ['identity', 'gmail-metadata'],
      ['openid', 'email'],
      [FIRST_ID],
    );

    const raw = readFileSync(join(directory, `${FIRST_ID}.account.enc`), 'utf8');
    expect(raw).not.toContain('sales@example.test');
    expect(raw).not.toContain('refresh-token-private');
    const record = store.require(FIRST_ID);
    expect(record.partitionKey).toBe(newPartitionKey(FIRST_ID));
    expect(store.toSummary(record)).not.toHaveProperty('refreshToken');
    expect(store.toSummary(record)).not.toHaveProperty('partitionKey');
  });

  it('preserves the exact legacy partition during migration-created local accounts', () => {
    const { store } = makeStore();
    const record = store.createLocal({
      id: FIRST_ID,
      workspaceId: 'digitronics',
      label: 'Digitronics',
      color: 'indigo',
      order: 0,
      partitionKey: 'persist:private-browser-digitronics',
      sourceFingerprint: 'a'.repeat(64),
    });
    expect(record.partitionKey).toBe('persist:private-browser-digitronics');
  });

  it('quarantines one corrupt record without disabling readable accounts', () => {
    const { directory, store } = makeStore();
    store.createLocal({ id: FIRST_ID, workspaceId: 'digitronics', label: 'Sales', color: 'indigo', order: 0 });
    store.createLocal({ id: SECOND_ID, workspaceId: 'digitronics', label: 'Admin', color: 'sky', order: 1 });
    writeFileSync(join(directory, `${FIRST_ID}.account.enc`), 'not-ciphertext');

    const corrupt = store.load(FIRST_ID);
    expect(corrupt.status).toBe('corrupt');
    if (corrupt.status === 'corrupt') expect(readFileSync(corrupt.backupPath, 'utf8')).toBe('not-ciphertext');
    expect(store.load(SECOND_ID).status).toBe('ok');
    expect(() => store.update(FIRST_ID, () => undefined)).toThrow(/writes are disabled/);
    expect(store.update(SECOND_ID, (record) => { record.label = 'Operations'; }).label).toBe('Operations');
  });

  it('prevents connecting the same stable Google subject twice', () => {
    const { store } = makeStore();
    for (const [id, order] of [[FIRST_ID, 0], [SECOND_ID, 1]] as const) {
      store.createLocal({ id, workspaceId: 'personal', label: `Personal ${order + 1}`, color: 'emerald', order });
    }
    const identity = { sub: 'stable-sub', email: 'person@example.test', emailVerified: true as const };
    store.saveGoogleGrant(FIRST_ID, identity, 'refresh-token-one', ['identity'], ['openid'], [FIRST_ID, SECOND_ID]);
    expect(() => store.saveGoogleGrant(SECOND_ID, identity, 'refresh-token-two', ['identity'], ['openid'], [FIRST_ID, SECOND_ID])).toThrow(/already connected/);
  });

  it('validates avatar bytes rather than trusting the declared MIME type', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
    expect(validateAvatar('image/png', png).mimeType).toBe('image/png');
    expect(() => validateAvatar('image/png', Buffer.from('<svg>'))).toThrow(/does not match/);
    expect(() => validateAvatar('image/svg+xml', Buffer.from('<svg>'))).toThrow(/does not match/);
  });
});
