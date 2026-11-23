import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore, type SafeStorageAdapter } from '../electron/account-store';
import { AccountSpaceStateStore } from '../electron/account-space-state';
import { DEFAULT_BROWSER_SETTINGS } from '../electron/browser-settings';
import { RuntimeStateStore } from '../electron/runtime-state-store';
import { externalLinkAccounts, preferredExternalLinkAccount } from '../electron/external-link-routing';

class TestEncryption implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer { return Buffer.from(`protected:${Buffer.from(value).toString('base64')}`); }
  decryptString(value: Buffer): string {
    const encoded = value.toString();
    if (!encoded.startsWith('protected:')) throw new Error('unreadable');
    return Buffer.from(encoded.slice(10), 'base64').toString();
  }
}

const NOW = new Date('2026-09-12T10:00:00.000Z');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'private-browser-migration-'));
  const legacyFilePath = join(root, 'browser-state.json');
  const manifestFilePath = join(root, 'browser-state-v2.json');
  const accountStateDirectory = join(root, 'account-state');
  const migrationJournalPath = join(root, 'browser-state-v2.migration.json');
  const accounts = join(root, 'accounts');
  const v1 = {
    version: 1,
    activeWorkspaceId: 'personal',
    tabs: [
      { id: 'd-home', workspaceId: 'digitronics', title: 'D', url: 'private://home', isHome: true },
      { id: 't-home', workspaceId: 'tenten', title: 'T', url: 'private://home', isHome: true },
      { id: 'dev-home', workspaceId: 'development', title: 'Dev', url: 'https://localhost.test/', isHome: false },
      { id: 'p-home', workspaceId: 'personal', title: 'Inbox', url: 'https://mail.google.com/', isHome: false },
      { id: 'p-second', workspaceId: 'personal', title: 'Calendar', url: 'https://calendar.google.com/', isHome: false },
      { id: 'b-home', workspaceId: 'banking', title: 'Bank', url: 'private://home', isHome: true },
    ],
    activeTabByWorkspace: { digitronics: 'd-home', tenten: 't-home', development: 'dev-home', personal: 'p-second', banking: 'b-home' },
    bookmarks: [{ id: 'bookmark-1', title: 'Mail', url: 'https://mail.google.com/', workspaceId: 'personal', createdAt: NOW.toISOString() }],
    history: [{ id: 'history-1', title: 'Calendar', url: 'https://calendar.google.com/', workspaceId: 'personal', visitedAt: NOW.toISOString() }],
    privacyLog: [],
    trackerBlocking: true,
    bookmarkBarVisible: false,
  };
  const original = Buffer.from(JSON.stringify(v1, null, 2));
  writeFileSync(legacyFilePath, original);
  const options = {
    paths: { legacyFilePath, manifestFilePath, accountStateDirectory, migrationJournalPath },
    accountStore: new AccountStore(accounts, new TestEncryption(), () => NOW),
    now: () => NOW,
  };
  return { root, original, options };
}

describe('v1 to Account Spaces v2 migration', () => {
  it('minimizes previously stored sensitive tab and history addresses on restart', () => {
    const { root, options } = fixture();
    const origin = 'https://example.test';
    const live = origin + '/password-reset/fixture-link';
    try {
      const disk = new AccountSpaceStateStore(options);
      const initialized = disk.initialize();
      if (initialized.status !== 'ready') throw new Error('Fixture did not migrate');
      const personal = initialized.accountStates.find(account => account.workspaceId === 'personal')!;
      const path = disk.recoveryTargetPath(personal.accountSpaceId);
      writeFileSync(path, JSON.stringify({
        ...personal,
        tabs: personal.tabs.map(tab => tab.id === 'p-home' ? { ...tab, url: live, title: 'Reset fixture' } : tab),
        history: [{ ...personal.history[0], url: live }, ...personal.history],
      }));
      const restored = new AccountSpaceStateStore(options).initialize();
      if (restored.status !== 'ready') throw new Error('Fixture did not restore');
      const state = restored.accountStates.find(account => account.accountSpaceId === personal.accountSpaceId)!;
      expect(state.tabs.find(tab => tab.id === 'p-home')?.url).toBe(origin + '/');
      expect(state.history.map(entry => entry.url)).toEqual(personal.history.map(entry => entry.url));
      expect(readFileSync(path, 'utf8')).not.toContain('fixture-link');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('coalesces routine writes and saves only the changed account while intentional changes flush immediately', () => {
    vi.useFakeTimers();
    try {
      const { options } = fixture();
      const disk = new AccountSpaceStateStore(options);
      const store = new RuntimeStateStore(disk, options.accountStore, disk.initialize());
      store.update(() => undefined);
      const account = vi.spyOn(disk, 'saveAccountState');
      const manifest = vi.spyOn(disk, 'saveManifest');
      const personal = store.get().activeAccountSpaceByWorkspace.personal;
      const title = (value: string) => store.update((state) => {
        state.tabs.find((tab) => tab.id === 'p-home')!.title = value;
      }, 'routine');
      title('First');
      vi.advanceTimersByTime(200);
      title('Last');
      expect(account).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50);
      expect(account).toHaveBeenCalledTimes(1);
      expect(account.mock.calls[0][0]).toMatchObject({ accountSpaceId: personal, tabs: expect.arrayContaining([expect.objectContaining({ title: 'Last' })]) });
      expect(manifest).not.toHaveBeenCalled();
      title('Keep this through shutdown');
      store.flushPendingWrites();
      expect(account).toHaveBeenCalledTimes(2);
      store.update((next) => { next.trackerBlocking = !next.trackerBlocking; });
      expect(manifest).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2000);
      expect(account).toHaveBeenCalledTimes(2);
      const restored = new RuntimeStateStore(disk, options.accountStore, disk.initialize()).get();
      expect(restored.tabs.find((tab) => tab.id === 'p-home')?.title).toBe('Keep this through shutdown');
      expect(restored.trackerBlocking).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores the last accepted account state if a later write rejects an immediate change', () => {
    vi.useFakeTimers();
    try {
      const { options } = fixture();
      const disk = new AccountSpaceStateStore(options);
      const store = new RuntimeStateStore(disk, options.accountStore, disk.initialize());
      store.update(() => undefined);
      vi.spyOn(disk, 'saveManifest').mockImplementationOnce(() => { throw new Error('fixture write failure'); });
      expect(() => store.update((next) => {
        next.tabs.find((tab) => tab.id === 'p-home')!.title = 'Unaccepted title';
        next.trackerBlocking = false;
      })).toThrow('fixture write failure');
      expect(store.get().trackerBlocking).toBe(true);
      vi.advanceTimersByTime(1000);
      const restored = new RuntimeStateStore(disk, options.accountStore, disk.initialize()).get();
      expect(restored.tabs.find((tab) => tab.id === 'p-home')?.title).toBe('Inbox');
      expect(restored.trackerBlocking).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remembers a regular external-link destination through a restart in Banking', () => {
    const { options } = fixture();
    const disk = new AccountSpaceStateStore(options);
    const store = new RuntimeStateStore(disk, options.accountStore, disk.initialize());
    const state = store.get();
    const personal = state.activeAccountSpaceByWorkspace.personal!;
    store.update((next) => { next.activeWorkspaceId = 'banking'; });
    const restarted = new RuntimeStateStore(disk, options.accountStore, disk.initialize()).get();
    expect(preferredExternalLinkAccount(restarted)).toBe(personal);
    const blocked = restarted.accountSpaces.find((item) => item.id === personal)!;
    blocked.locked = true;
    expect(externalLinkAccounts(restarted).map((item) => item.id)).not.toContain(personal);
    expect(externalLinkAccounts(restarted).map((item) => item.workspaceId)).not.toContain('banking');
    expect(preferredExternalLinkAccount(restarted)).toBeUndefined();
  });

  it('searches older retained history only within the expected active space and excludes Banking history', () => {
    const { options } = fixture();
    const disk = new AccountSpaceStateStore(options);
    const store = new RuntimeStateStore(disk, options.accountStore, disk.initialize());
    const { activeAccountSpaceByWorkspace } = store.get();
    const personal = activeAccountSpaceByWorkspace.personal!;
    const banking = activeAccountSpaceByWorkspace.banking!;
    const history = Array.from({ length: 101 }, (_, index) => ({
      id: 'visit-' + index, workspaceId: 'personal' as const, accountSpaceId: personal,
      title: 'Newer page', url: 'https://example.test/' + index, visitedAt: NOW.toISOString(),
    }));
    const old = { ...history[0], id: 'older', title: 'Older ledger', url: 'https://example.test/ledger' };
    store.update((state) => {
      state.history = [...history, old, { ...old, id: 'banking', accountSpaceId: banking, workspaceId: 'banking' }];
    });
    expect(store.addressMatches(personal, 'older ledger')).toEqual([{ id: old.id, source: 'history', title: old.title, url: old.url }]);
    const lookup = { text: 'older ledger', site: 'example.test', from: null, until: null, page: 0 };
    expect(store.retainedHistory(personal, lookup).entries).toEqual([{ id: old.id, title: old.title, url: old.url, visitedAt: old.visitedAt, visits: 1 }]);
    expect(store.retainedHistory(banking, lookup).entries).toEqual([]);
    expect(store.addressMatchTarget(personal, 'history', 'banking')).toBeUndefined();
    expect(store.addressMatches(banking, 'older ledger')).toEqual([]);
    store.update((state) => { state.activeWorkspaceId = 'banking'; });
    expect(store.addressMatchTarget(banking, 'history', 'banking')).toBeUndefined();
    expect(store.addressMatches(banking, 'older ledger')).toEqual([]);
    expect(store.retainedHistory(banking, lookup).entries).toEqual([]);
    expect(store.addressMatches(personal, 'older ledger')).toEqual([]);
  });

  it('records history trimming for the affected account across a restart', () => {
    const { options } = fixture();
    const disk = new AccountSpaceStateStore(options);
    const store = new RuntimeStateStore(disk, options.accountStore, disk.initialize());
    const personal = store.get().activeAccountSpaceByWorkspace.personal!;
    const history = Array.from({ length: 10_001 }, (_, index) => ({
      id: 'retained-' + index, workspaceId: 'personal' as const, accountSpaceId: personal,
      title: 'Sample', url: 'https://example.test/' + index, visitedAt: NOW.toISOString(),
    }));
    store.update((state) => { state.history = history; });
    const restarted = new RuntimeStateStore(disk, options.accountStore, disk.initialize());
    const result = restarted.retainedHistory(personal, { text: '', site: 'example.test', from: null, until: null, page: 250 });
    expect(result).toMatchObject({ trimmed: true, total: 10_000, page: 249, pages: 250 });
    expect(result.entries).toHaveLength(40);
    expect(result.entries.some((entry) => entry.id === 'retained-10000')).toBe(false);
  });

  it('preserves data, active selections and the exact legacy partitions', () => {
    const { original, options } = fixture();
    const result = new AccountSpaceStateStore(options).initialize();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.manifest.activeWorkspaceId).toBe('personal');
    expect(result.manifest.bookmarkBarVisible).toBe(false);
    const personal = result.accounts.find((account) => account.workspaceId === 'personal')!;
    expect(personal.partitionKey).toBe('persist:private-browser-personal');
    const personalState = result.accountStates.find((state) => state.workspaceId === 'personal')!;
    expect(personalState.tabs.map((tab) => tab.id)).toEqual(['p-home', 'p-second']);
    expect(personalState.activeTabId).toBe('p-second');
    expect(personalState.bookmarks[0].accountSpaceId).toBe(personal.id);
    expect(personalState.history[0].accountSpaceId).toBe(personal.id);
    expect(readFileSync(options.paths.legacyFilePath)).toEqual(original);
    const journal = JSON.parse(readFileSync(options.paths.migrationJournalPath, 'utf8')) as { backupPath: string };
    expect(readFileSync(journal.backupPath)).toEqual(original);
    const plaintextManifest = readFileSync(options.paths.manifestFilePath, 'utf8');
    expect(plaintextManifest).not.toContain('mail.google.com');
    expect(plaintextManifest).not.toContain('persist:');
  });

  it('reuses the same opaque IDs after an interrupted migration', () => {
    const first = fixture();
    let interrupted = false;
    const withInterruption = new AccountSpaceStateStore({
      ...first.options,
      onMigrationPhase: (phase) => {
        if (phase === 'accounts' && !interrupted) {
          interrupted = true;
          throw new Error('simulated interruption');
        }
      },
    }).initialize();
    expect(withInterruption.status).toBe('recovery');
    const journalBefore = readFileSync(first.options.paths.migrationJournalPath, 'utf8');
    const retried = new AccountSpaceStateStore(first.options).initialize();
    expect(retried.status).toBe('ready');
    if (retried.status !== 'ready') return;
    expect(readFileSync(first.options.paths.migrationJournalPath, 'utf8')).toBe(journalBefore);
    const journal = JSON.parse(journalBefore) as { accountIdsByWorkspace: Record<string, string> };
    expect(retried.manifest.accountSpaceIds).toEqual(Object.values(journal.accountIdsByWorkspace));
  });

  it('enters read-only recovery and preserves unknown or corrupt state', () => {
    const unknown = fixture();
    writeFileSync(unknown.options.paths.manifestFilePath, '{"version":99,"private":"unchanged"}');
    const originalUnknown = readFileSync(unknown.options.paths.manifestFilePath);
    const result = new AccountSpaceStateStore(unknown.options).initialize();
    expect(result).toMatchObject({ status: 'recovery', recovery: { readOnly: true, reason: 'unsupported-version' } });
    expect(readFileSync(unknown.options.paths.manifestFilePath)).toEqual(originalUnknown);

    const corrupt = fixture();
    writeFileSync(corrupt.options.paths.manifestFilePath, '{not-json');
    const corruptBytes = readFileSync(corrupt.options.paths.manifestFilePath);
    const corruptResult = new AccountSpaceStateStore(corrupt.options).initialize();
    expect(corruptResult).toMatchObject({ status: 'recovery', recovery: { readOnly: true, reason: 'invalid-state' } });
    expect(readFileSync(corrupt.options.paths.manifestFilePath)).toEqual(corruptBytes);
  });

  it('quarantines a corrupt individual account while other account files remain readable', () => {
    const created = fixture();
    const initial = new AccountSpaceStateStore(created.options).initialize();
    expect(initial.status).toBe('ready');
    if (initial.status !== 'ready') return;
    const personal = initial.accounts.find((account) => account.workspaceId === 'personal')!;
    writeFileSync(join(created.root, 'accounts', `${personal.id}.account.enc`), 'broken');
    const loaded = new AccountSpaceStateStore(created.options).initialize();
    expect(loaded.status).toBe('ready');
    if (loaded.status === 'ready') {
      expect(loaded.accountRecoveries).toEqual([
        expect.objectContaining({ accountSpaceId: personal.id, readOnly: true, scope: 'account-space' }),
      ]);
    }
    const digitronics = initial.accounts.find((account) => account.workspaceId === 'digitronics')!;
    expect(created.options.accountStore.load(digitronics.id).status).toBe('ok');
  });

  it('preserves unreadable v2 bytes before restoring the original v1 state', () => {
    const created = fixture();
    expect(new AccountSpaceStateStore(created.options).initialize().status).toBe('ready');
    const unreadable = Buffer.from('{"version":99,"doNotLose":"original-v2-bytes"}');
    writeFileSync(created.options.paths.manifestFilePath, unreadable);
    const store = new AccountSpaceStateStore(created.options);
    expect(store.initialize()).toMatchObject({ status: 'recovery' });
    store.prepareRestoreV1();
    expect(existsSync(created.options.paths.manifestFilePath)).toBe(false);
    const preserved = readdirSync(created.root).find((name) => name.includes('browser-state-v2.json.before-restore-v1'));
    expect(preserved).toBeDefined();
    expect(readFileSync(join(created.root, preserved!))).toEqual(unreadable);
    expect(store.initialize().status).toBe('ready');
    expect(readFileSync(created.options.paths.legacyFilePath)).toEqual(created.original);
  });

  it('replaces only a corrupt account after explicitly selected fresh recovery', () => {
    const created = fixture();
    const first = new AccountSpaceStateStore(created.options).initialize();
    expect(first.status).toBe('ready');
    if (first.status !== 'ready') return;
    const personal = first.accounts.find((account) => account.workspaceId === 'personal')!;
    const digitronics = first.accounts.find((account) => account.workspaceId === 'digitronics')!;
    const corruptPath = join(created.root, 'accounts', `${personal.id}.account.enc`);
    writeFileSync(corruptPath, 'broken');
    const store = new AccountSpaceStateStore(created.options);
    expect(store.initialize()).toMatchObject({ status: 'ready', accountRecoveries: [expect.objectContaining({ accountSpaceId: personal.id })] });
    store.prepareFreshStart(personal.id);
    const recovered = store.initialize();
    expect(recovered).toMatchObject({ status: 'ready', accountRecoveries: [] });
    expect(created.options.accountStore.require(personal.id)).toMatchObject({ workspaceId: 'personal', locked: false, kind: 'local' });
    expect(created.options.accountStore.require(digitronics.id)).toEqual(first.accounts.find((account) => account.id === digitronics.id));
  });
});

describe('browser settings in the v2 manifest', () => {
  function migrated() {
    const created = fixture();
    const result = new AccountSpaceStateStore(created.options).initialize();
    if (result.status !== 'ready') throw new Error('migration did not complete');
    return { ...created, manifest: result.manifest };
  }
  function reload(options: ReturnType<typeof fixture>['options']) {
    const result = new AccountSpaceStateStore(options).initialize();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('state did not load');
    return result.manifest;
  }

  it('writes defaults when migrating from v1', () => {
    expect(migrated().manifest.settings).toEqual(DEFAULT_BROWSER_SETTINGS);
  });

  it('loads a manifest without settings, as older builds write it, with defaults', () => {
    const { options } = migrated();
    const saved = JSON.parse(readFileSync(options.paths.manifestFilePath, 'utf8')) as Record<string, unknown>;
    delete saved.settings;
    writeFileSync(options.paths.manifestFilePath, JSON.stringify(saved));
    expect(reload(options).settings).toEqual(DEFAULT_BROWSER_SETTINGS);
  });

  it('keeps the rest of the state and never enters recovery for garbage settings', () => {
    const { options, manifest } = migrated();
    const saved = JSON.parse(readFileSync(options.paths.manifestFilePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(options.paths.manifestFilePath, JSON.stringify({ ...saved, settings: { searchEngine: 'custom', customSearchTemplate: 'javascript:%s', homePage: 42, startup: 'home' } }));
    const loaded = reload(options);
    expect(loaded.settings).toEqual({ ...DEFAULT_BROWSER_SETTINGS, startupHome: true });
    expect(loaded.accountSpaceIds).toEqual(manifest.accountSpaceIds);
    expect(loaded.activeWorkspaceId).toBe(manifest.activeWorkspaceId);
  });

  it('round-trips the chosen settings', () => {
    const { options, manifest } = migrated();
    const settings = { searchEngine: 'custom' as const, customSearchTemplate: 'https://search.example.com/?q=%s', homePage: 'url' as const, homePageUrl: 'https://tenten.ma/', newTab: 'start' as const, startup: 'automatic' as const, startupHome: true };
    new AccountSpaceStateStore(options).saveManifest({ ...manifest, settings });
    expect(reload(options).settings).toEqual(settings);
  });

  it('persists deferred startup tabs only inside their owning Account Space file', () => {
    const { options } = migrated();
    const disk = new AccountSpaceStateStore(options);
    const store = new RuntimeStateStore(disk, options.accountStore, disk.initialize());
    const state = store.get();
    const accountSpaceId = state.activeAccountSpaceByWorkspace.personal!;
    store.update((next) => {
      next.deferredSessionsByAccountSpace = { [accountSpaceId]: {
        version: 1, savedAt: NOW.toISOString(), activeTabId: 'p-second', tabs: [
          { id: 'p-home', workspaceId: 'personal', accountSpaceId, title: 'Inbox', url: 'https://mail.google.com/', isHome: false },
          { id: 'p-second', workspaceId: 'personal', accountSpaceId, title: 'Calendar', url: 'https://calendar.google.com/', isHome: false },
        ],
      } };
    });
    const loaded = new RuntimeStateStore(disk, options.accountStore, disk.initialize()).get();
    expect(loaded.deferredSessionsByAccountSpace?.[accountSpaceId]).toMatchObject({ activeTabId: 'p-second', tabs: expect.arrayContaining([expect.objectContaining({ id: 'p-home' })]) });
    expect(loaded.deferredSessionsByAccountSpace?.[state.activeAccountSpaceByWorkspace.tenten!]).toBeUndefined();
  });
});
