import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStore, type SafeStorageAdapter } from '../electron/account-store';
import { AccountSpaceStateStore } from '../electron/account-space-state';
import { RuntimeStateStore } from '../electron/runtime-state-store';
import type { AccountBrowsingStateV2, AccountSpaceId, BrowserStateManifestV2, WorkspaceId } from '../electron/types';

class TestEncryption implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer { return Buffer.from(value).reverse(); }
  decryptString(value: Buffer): string { return Buffer.from(value).reverse().toString(); }
}

const IDS = {
  digitronics: '122b503d-a1b3-497a-a610-e193af8d0702',
  digitronicsSecond: '6ba2c705-9ba8-4f4a-9af2-46f8a36f9fc4',
  tenten: 'e42a64d9-9193-47a2-a442-b820660966a1',
  development: 'a04aeaa5-497d-4d5f-9da0-8d00331fa7ee',
  personal: '0c29cc4b-accc-448f-a7f3-8e985a83a38e',
  banking: '6ef65669-2112-4cf2-a5e0-dfd4b3f45034',
} as const;

function accountId(value: string): AccountSpaceId { return value as AccountSpaceId; }

function browsingState(workspaceId: WorkspaceId, id: AccountSpaceId, suffix: string): AccountBrowsingStateV2 {
  return {
    version: 2,
    accountSpaceId: id,
    workspaceId,
    tabs: [{ id: `tab-${suffix}`, workspaceId, accountSpaceId: id, title: suffix, url: 'private://home', isHome: true }],
    activeTabId: `tab-${suffix}`,
    bookmarks: [],
    history: [],
  };
}

function runtimeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'private-browser-runtime-'));
  const accountStore = new AccountStore(join(root, 'accounts'), new TestEncryption(), () => new Date('2026-09-12T10:00:00Z'));
  const definitions: Array<[WorkspaceId, AccountSpaceId, string, number]> = [
    ['digitronics', accountId(IDS.digitronics), 'Sales', 0],
    ['digitronics', accountId(IDS.digitronicsSecond), 'Admin', 1],
    ['tenten', accountId(IDS.tenten), 'TenTen', 0],
    ['development', accountId(IDS.development), 'Development', 0],
    ['personal', accountId(IDS.personal), 'Personal', 0],
    ['banking', accountId(IDS.banking), 'Banking', 0],
  ];
  const records = definitions.map(([workspaceId, id, label, order]) => accountStore.createLocal({ workspaceId, id, label, color: 'indigo', order }));
  const states = definitions.map(([workspaceId, id, , order]) => browsingState(workspaceId, id, `${workspaceId}-${order}`));
  const manifest: BrowserStateManifestV2 = {
    version: 2,
    activeWorkspaceId: 'digitronics',
    accountSpaceIds: records.map((record) => record.id),
    activeAccountSpaceByWorkspace: {
      digitronics: accountId(IDS.digitronics),
      tenten: accountId(IDS.tenten),
      development: accountId(IDS.development),
      personal: accountId(IDS.personal),
      banking: accountId(IDS.banking),
    },
    privacyLog: [],
    trackerBlocking: true,
  };
  const persistence = new AccountSpaceStateStore({
    paths: {
      legacyFilePath: join(root, 'legacy-state.json'),
      manifestFilePath: join(root, 'browser-state-v2.json'),
      accountStateDirectory: join(root, 'account-browsing'),
      migrationJournalPath: join(root, 'migration.json'),
    },
    accountStore,
  });
  return new RuntimeStateStore(persistence, accountStore, { status: 'ready', manifest, accounts: records, accountStates: states, accountRecoveries: [] });
}

describe('Account Space runtime isolation', () => {
  it('shares a partition within one account and never across accounts', () => {
    const store = runtimeFixture();
    const first = accountId(IDS.digitronics);
    const second = accountId(IDS.digitronicsSecond);
    expect(store.partitionFor(first)).toBe(store.partitionFor(first));
    expect(store.partitionFor(first)).not.toBe(store.partitionFor(second));
    expect(store.partitionFor(first)).not.toContain('Sales');
  });

  it('keeps tabs, bookmarks and history owned by the same workspace and account', () => {
    const store = runtimeFixture();
    const first = accountId(IDS.digitronics);
    const second = accountId(IDS.digitronicsSecond);
    store.update((state) => {
      state.tabs.push({ ...state.tabs[0], id: 'second-sales-tab' });
      state.bookmarks.push({ id: 'sales-bookmark', workspaceId: 'digitronics', accountSpaceId: first, title: 'Sales', url: 'https://example.com/', createdAt: new Date().toISOString() });
      state.history.push({ id: 'admin-history', workspaceId: 'digitronics', accountSpaceId: second, title: 'Admin', url: 'https://example.test/', visitedAt: new Date().toISOString() });
      state.history.push({ id: 'crossed', workspaceId: 'personal', accountSpaceId: first, title: 'Invalid', url: 'https://invalid.example/', visitedAt: new Date().toISOString() });
    });
    const state = store.get();
    expect(state.tabs.filter((tab) => tab.accountSpaceId === first)).toHaveLength(2);
    expect(state.bookmarks.filter((bookmark) => bookmark.accountSpaceId === first)).toHaveLength(1);
    expect(state.history.filter((entry) => entry.accountSpaceId === second)).toHaveLength(1);
    expect(state.history.some((entry) => entry.id === 'crossed')).toBe(false);
  });

  it('refuses to cross a workspace when selecting an active account', () => {
    const store = runtimeFixture();
    store.update((state) => {
      state.activeAccountSpaceByWorkspace.banking = accountId(IDS.digitronics);
    });
    expect(store.get().activeAccountSpaceByWorkspace.banking).toBe(accountId(IDS.banking));
  });

  it('binds popup, favicon and download handling to the originating Account Space', () => {
    const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    expect(source).toContain('this.store.partitionFor(tab.accountSpaceId)');
    expect(source).toContain('this.newTab(tab.workspaceId, stripTrackingParameters(url), tab.accountSpaceId)');
    expect(source).toContain('const cacheKey = `${tab.accountSpaceId}:${url}`');
    expect(source).toContain('accountSpaceId,\n        filename: item.getFilename()');
    expect(source).not.toContain('const partition = `persist:private-browser-${tab.workspaceId}`');
  });
});
