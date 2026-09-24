import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  return { root, accounts, persisted, runtime: new RuntimeStateStore(persisted, accounts, initialized) };
}

function reopen(root: string, accounts: AccountStore) {
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
  if (initialized.status !== 'ready') throw new Error('reopen did not initialize');
  return { persisted, initialized, runtime: new RuntimeStateStore(persisted, accounts, initialized) };
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

  // F-39: deletion used to leave the account's plaintext history/tabs/bookmarks file.
  it("deletes the removed account's plaintext browsing file", () => {
    const { root, accounts, runtime } = fixture();
    const added = accounts.createLocal({ workspaceId: 'personal', label: 'Second', color: 'emerald', order: 1 });
    runtime.addAccount(added);
    const statePath = join(root, 'account-browsing', `${added.id}.json`);
    expect(existsSync(statePath)).toBe(true);
    runtime.removeAccount(added.id);
    expect(existsSync(statePath)).toBe(false);
  });

  // F-37: an unreadable account used to drop out of the manifest at the first save.
  it('keeps an account with an unreadable record in the manifest until recovery is resolved', () => {
    const { root, accounts, runtime } = fixture();
    const extra = accounts.createLocal({ workspaceId: 'personal', label: 'Second', color: 'emerald', order: 1 });
    runtime.addAccount(extra);
    const statePath = join(root, 'account-browsing', `${extra.id}.json`);
    writeFileSync(join(root, 'accounts', `${extra.id}.account.enc`), 'broken');
    const reopened = reopen(root, accounts);
    expect(reopened.initialized.accountRecoveries.map((recovery) => recovery.accountSpaceId)).toEqual([extra.id]);
    const stateBefore = readFileSync(statePath, 'utf8');
    reopened.runtime.update((state) => { state.trackerBlocking = !state.trackerBlocking; });
    const manifest = JSON.parse(readFileSync(join(root, 'browser-state-v2.json'), 'utf8')) as { accountSpaceIds: string[] };
    expect(manifest.accountSpaceIds).toContain(extra.id);
    expect(readFileSync(statePath, 'utf8')).toBe(stateBefore);
    // And recovery is still offered on the next launch.
    expect(reopen(root, accounts).initialized.accountRecoveries.map((recovery) => recovery.accountSpaceId)).toEqual([extra.id]);
  });

  it("keeps saving when a workspace's only account is in recovery", () => {
    const { root, accounts, runtime } = fixture();
    const only = runtime.get().accountSpaces.find((account) => account.workspaceId === 'tenten')!;
    writeFileSync(join(root, 'accounts', `${only.id}.account.enc`), 'broken');
    const reopened = reopen(root, accounts);
    expect(() => reopened.runtime.update((state) => { state.trackerBlocking = !state.trackerBlocking; })).not.toThrow();
  });

  it('fresh-starts an account whose browsing file is corrupt, keeping its intact record', () => {
    const { root, accounts, runtime } = fixture();
    const target = runtime.get().accountSpaces.find((account) => account.workspaceId === 'digitronics')!;
    const statePath = join(root, 'account-browsing', `${target.id}.json`);
    writeFileSync(statePath, '{broken');
    const reopened = reopen(root, accounts);
    expect(reopened.initialized.accountRecoveries.map((recovery) => recovery.accountSpaceId)).toEqual([target.id]);
    reopened.persisted.prepareFreshStart(target.id);
    expect(reopen(root, accounts).initialized.accountRecoveries).toEqual([]);
    expect(accounts.require(target.id).label).toBe(target.label);
    expect(readdirSync(join(root, 'account-browsing')).some((name) => name.startsWith(`${target.id}.json.corrupt-`))).toBe(true);
  });

  // F-38: "restore version 1" re-migrates over the live per-account files.
  it('preserves every per-account file before restoring version 1', () => {
    const { root, persisted } = fixture();
    writeFileSync(join(root, 'browser-state.json'), '{"version":1}');
    persisted.prepareRestoreV1();
    const preserved = readdirSync(join(root, 'account-browsing')).filter((name) => name.includes('.json.before-restore-v1'));
    const live = readdirSync(join(root, 'account-browsing')).filter((name) => name.endsWith('.json'));
    expect(preserved.length).toBe(live.length);
    expect(live.length).toBeGreaterThan(0);
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

describe('orphaned legacy partitions', () => {
  it('reports none while every workspace still owns its partition or any account is in recovery', () => {
    const { root, accounts, runtime } = fixture();
    expect(runtime.orphanedLegacyPartitions().every((key) => key.startsWith('persist:private-browser-'))).toBe(true);
    const personal = runtime.get().accountSpaces.find((account) => account.workspaceId === 'personal')!;
    writeFileSync(join(root, 'accounts', `${personal.id}.account.enc`), 'broken');
    expect(reopen(root, accounts).runtime.orphanedLegacyPartitions()).toEqual([]);
  });
});
