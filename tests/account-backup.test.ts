import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AccountBackupManager,
  decodeRecoveryCode,
  decryptBackupEnvelope,
  encryptBackupPayload,
  type AccountBackupPayload,
  type EncryptedBackupTransport,
  type RemoteEncryptedBackup,
} from '../electron/account-backup';
import { AccountStore, type SafeStorageAdapter } from '../electron/account-store';
import type { AccountSpaceId } from '../electron/types';

class TestEncryption implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer { return Buffer.from(value).reverse(); }
  decryptString(value: Buffer): string { return Buffer.from(value).reverse().toString(); }
}

class MemoryTransport implements EncryptedBackupTransport {
  remote?: RemoteEncryptedBackup;
  writes: Uint8Array[] = [];
  async read(): Promise<RemoteEncryptedBackup | undefined> { return this.remote; }
  async write(_id: AccountSpaceId, bytes: Uint8Array, expectedEtag?: string): Promise<{ etag: string; fileId: string }> {
    if (expectedEtag && expectedEtag !== this.remote?.etag) throw new Error('conflict');
    this.writes.push(bytes);
    const etag = `etag-${this.writes.length}`;
    this.remote = { bytes, etag, fileId: 'backup-file' };
    return { etag, fileId: 'backup-file' };
  }
}

const ID = '122b503d-a1b3-497a-a610-e193af8d0702' as AccountSpaceId;

function fixture() {
  const encryption = new TestEncryption();
  const accounts = new AccountStore(mkdtempSync(join(tmpdir(), 'backup-accounts-')), encryption, () => new Date('2026-09-12T10:00:00Z'));
  accounts.createLocal({ id: ID, workspaceId: 'personal', label: 'Personal', color: 'emerald', order: 0 });
  accounts.update(ID, (account) => { account.enabledModules = ['identity', 'encrypted-backup']; });
  const transport = new MemoryTransport();
  const manager = new AccountBackupManager(accounts, encryption, transport, () => new Date('2026-09-12T10:00:00Z'));
  return { accounts, transport, manager };
}

describe('encrypted Account Space backup', () => {
  it('uses AES-256-GCM and rejects tampering or the wrong recovery key', () => {
    const key = randomBytes(32);
    const payload: AccountBackupPayload = { version: 1, createdAt: '2026-09-12T10:00:00Z', bookmarks: [], bookmarkFolders: [], settings: { trackerBlocking: true } };
    const envelope = encryptBackupPayload(payload, key);
    expect(decryptBackupEnvelope(envelope, key)).toEqual(payload);
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext[0] === 'A' ? 'B' : 'A'}${envelope.ciphertext.slice(1)}` };
    expect(() => decryptBackupEnvelope(tampered, key)).toThrow(/authentication/);
    expect(() => decryptBackupEnvelope(envelope, randomBytes(32))).toThrow(/authentication/);
  });

  it('shows a recovery code once and enables only after exact verification', () => {
    const { accounts, manager } = fixture();
    const code = manager.createRecoveryCode(ID);
    expect(code).toMatch(/^PB1-[A-Za-z0-9_-]{43}$/);
    expect(() => manager.verifyAndEnable(ID, 'PB1-wrong', true, false)).toThrow(/did not match/);
    manager.verifyAndEnable(ID, code, true, false);
    const backup = accounts.require(ID).backup;
    expect(backup).toMatchObject({ enabled: true, includeOpenTabs: true, includeHistory: false });
    expect(backup.wrappedRecoveryKey).not.toContain(code.slice(4));
    expect(() => manager.verifyAndEnable(ID, code, true, false)).toThrow(/did not match/);
  });

  it('builds an explicit allowlist payload and keeps history opt-in', () => {
    const { manager } = fixture();
    const code = manager.createRecoveryCode(ID);
    manager.verifyAndEnable(ID, code, true, false);
    const payload = manager.buildPayload(ID, {
      bookmarks: [{ id: 'b1', accountSpaceId: ID, workspaceId: 'personal', title: 'Safe', url: 'https://example.com/', createdAt: '2026-09-12T10:00:00Z' }],
      trackerBlocking: true,
      openTabs: [{ id: 't1', accountSpaceId: ID, workspaceId: 'personal', title: 'Tab', url: 'https://example.com/', isHome: false, loading: false, canGoBack: false, canGoForward: false, developerToolsAllowed: false, developerToolsOpen: false }],
      history: [{ id: 'h1', accountSpaceId: ID, workspaceId: 'personal', title: 'History', url: 'https://example.com/', visitedAt: '2026-09-12T10:00:00Z' }],
    });
    expect(payload.openTabs).toHaveLength(1);
    expect(payload).not.toHaveProperty('history');
    expect(payload).not.toHaveProperty('cookies');
    expect(payload).not.toHaveProperty('tokens');
    expect(payload).not.toHaveProperty('vault');
    expect(payload).not.toHaveProperty('privacyLog');
  });

  it('uploads only ciphertext and detects an ETag conflict before writing', async () => {
    const { accounts, transport, manager } = fixture();
    const code = manager.createRecoveryCode(ID);
    manager.verifyAndEnable(ID, code, false, false);
    const payload = manager.buildPayload(ID, { bookmarks: [], trackerBlocking: true, openTabs: [], history: [] });
    await expect(manager.upload(ID, payload)).resolves.toMatchObject({ status: 'uploaded', etag: 'etag-1' });
    const uploaded = Buffer.from(transport.writes[0]).toString();
    expect(uploaded).not.toContain('trackerBlocking');
    expect(uploaded).toContain('AES-256-GCM');
    transport.remote = { ...transport.remote!, etag: 'other-device' };
    await expect(manager.upload(ID, { ...payload, bookmarks: [{ id: 'local', accountSpaceId: ID, workspaceId: 'personal', title: 'Local', url: 'https://local.example/', createdAt: payload.createdAt }] })).resolves.toEqual({ status: 'conflict', localEtag: 'etag-1', remoteEtag: 'other-device' });
    expect(transport.writes).toHaveLength(1);
    expect(accounts.require(ID).backup.remoteEtag).toBe('etag-1');
  });

  it('merges explicitly and restores across devices with only the recovery code', async () => {
    const first = fixture();
    const code = first.manager.createRecoveryCode(ID);
    first.manager.verifyAndEnable(ID, code, false, false);
    const remotePayload = first.manager.buildPayload(ID, { bookmarks: [{ id: 'remote', accountSpaceId: ID, workspaceId: 'personal', title: 'Remote', url: 'https://remote.example/', createdAt: '2026-09-12T10:00:00Z' }], trackerBlocking: true, openTabs: [], history: [] });
    await first.manager.upload(ID, remotePayload);
    first.transport.remote = { ...first.transport.remote!, etag: 'changed' };
    const localPayload = first.manager.buildPayload(ID, { bookmarks: [{ id: 'local', accountSpaceId: ID, workspaceId: 'personal', title: 'Local', url: 'https://local.example/', createdAt: '2026-09-12T10:00:00Z' }], trackerBlocking: false, openTabs: [], history: [] });
    await expect(first.manager.upload(ID, localPayload, 'merge')).resolves.toMatchObject({ status: 'uploaded' });

    const second = fixture();
    second.transport.remote = first.transport.remote;
    const restored = await second.manager.restore(ID, code);
    expect(restored.bookmarks.map((bookmark) => bookmark.id).sort()).toEqual(['local', 'remote']);
    expect(decodeRecoveryCode(code)).toHaveLength(32);
  });

  it('disables restore when local recovery material is missing', async () => {
    const { manager } = fixture();
    await expect(manager.restore(ID)).rejects.toThrow(/recovery material is unavailable/);
  });
});
