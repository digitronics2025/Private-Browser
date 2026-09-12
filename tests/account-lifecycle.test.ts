import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore, type SafeStorageAdapter } from '../electron/account-store';
import { clearAndVerifyAccountSession } from '../electron/account-session';
import { AccountSpaceStateStore } from '../electron/account-space-state';
import { RuntimeStateStore } from '../electron/runtime-state-store';
import type { AccountSpaceId } from '../electron/types';

class TestEncryption implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer { return Buffer.from(value).reverse(); }
  decryptString(value: Buffer): string { return Buffer.from(value).reverse().toString(); }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'account-lifecycle-'));
  const accounts = new AccountStore(join(root, 'accounts'), new TestEncryption());
  const persisted = new AccountSpaceStateStore({
    paths: {
      legacyFilePath: join(root, 'browser-state.json'),
      manifestFilePath: join(root, 'browser-state-v2.json'),
      accountStateDirectory: join(root, 'account-browsing'),
      migrationJournalPath: join(root, 'migration.json'),
    },
    accountStore: accounts,
  });
  const initialized = persisted.initialize();
  if (initialized.status !== 'ready') throw new Error('fixture did not initialize');
  return { accounts, runtime: new RuntimeStateStore(persisted, accounts, initialized) };
}

describe('Account Space lifecycle', () => {
  it('adds an opaque isolated account and refuses to delete the sole workspace account', () => {
    const { accounts, runtime } = fixture();
    const original = runtime.get().accountSpaces.find((account) => account.workspaceId === 'digitronics')!;
    expect(() => runtime.removeAccount(original.id)).toThrow(/replacement/);

    const added = accounts.createLocal({ workspaceId: 'digitronics', label: 'Marketing', color: 'sky', order: 1 });
    runtime.addAccount(added);
    expect(runtime.get().activeAccountSpaceByWorkspace.digitronics).toBe(added.id);
    expect(runtime.partitionFor(added.id)).toBe(`persist:private-browser-account-${added.id}`);
  });

  it('removes only the selected account browsing and encrypted metadata', () => {
    const { accounts, runtime } = fixture();
    const original = runtime.get().accountSpaces.find((account) => account.workspaceId === 'personal')!;
    const added = accounts.createLocal({ workspaceId: 'personal', label: 'Second', color: 'emerald', order: 1 });
    runtime.addAccount(added);
    runtime.update((state) => {
      state.bookmarks.push({ id: 'removed-bookmark', workspaceId: 'personal', accountSpaceId: added.id, title: 'Removed', url: 'https://example.com/', createdAt: new Date().toISOString(), location: 'bar', folderPath: [], order: 0, orderPath: [0] });
      state.bookmarks.push({ id: 'kept-bookmark', workspaceId: 'personal', accountSpaceId: original.id, title: 'Kept', url: 'https://example.org/', createdAt: new Date().toISOString(), location: 'bar', folderPath: [], order: 0, orderPath: [0] });
    });

    runtime.removeAccount(added.id);
    const state = runtime.get();
    expect(state.accountSpaces.some((account) => account.id === added.id)).toBe(false);
    expect(state.tabs.some((tab) => tab.accountSpaceId === added.id)).toBe(false);
    expect(state.bookmarks.map((bookmark) => bookmark.id)).toEqual(['kept-bookmark']);
    expect(accounts.load(added.id).status).toBe('missing');
    expect(accounts.load(original.id).status).toBe('ok');
  });

  it('requires a complete same-workspace reorder set', () => {
    const { accounts, runtime } = fixture();
    const first = runtime.get().accountSpaces.find((account) => account.workspaceId === 'tenten')!;
    const second = accounts.createLocal({ workspaceId: 'tenten', label: 'Second', color: 'amber', order: 1 });
    runtime.addAccount(second);
    expect(() => runtime.reorder('tenten', [first.id])).toThrow(/every Account Space/);
    runtime.reorder('tenten', [second.id, first.id]);
    expect(accounts.require(second.id).order).toBe(0);
    expect(accounts.require(first.id).order).toBe(1);
  });

  it('clears and verifies only the supplied session, retrying observable residue once', async () => {
    const cookies = vi.fn<() => Promise<unknown[]>>().mockResolvedValueOnce([{}]).mockResolvedValueOnce([]);
    const cache = vi.fn<() => Promise<number>>().mockResolvedValueOnce(128).mockResolvedValueOnce(0);
    const target = {
      closeAllConnections: vi.fn(async () => undefined),
      clearData: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      clearAuthCache: vi.fn(async () => undefined),
      clearHostResolverCache: vi.fn(async () => undefined),
      cookies: { get: cookies },
      getCacheSize: cache,
    };
    await clearAndVerifyAccountSession(target);
    expect(target.clearData).toHaveBeenCalledTimes(2);
    expect(target.clearData).toHaveBeenCalledWith();
    expect(target.clearStorageData).toHaveBeenCalledTimes(2);
  });

  it('fails closed if cookies or cache remain after clearing', async () => {
    const target = {
      closeAllConnections: vi.fn(async () => undefined),
      clearData: vi.fn(async () => undefined),
      clearStorageData: vi.fn(async () => undefined),
      clearCache: vi.fn(async () => undefined),
      clearAuthCache: vi.fn(async () => undefined),
      clearHostResolverCache: vi.fn(async () => undefined),
      cookies: { get: vi.fn(async () => [{}]) },
      getCacheSize: vi.fn(async () => 1),
    };
    await expect(clearAndVerifyAccountSession(target)).rejects.toThrow(/could not be completely verified/);
  });
});
