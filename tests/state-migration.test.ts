import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountStore, type SafeStorageAdapter } from '../electron/account-store';
import { AccountSpaceStateStore } from '../electron/account-space-state';

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
  it('preserves data, active selections and the exact legacy partitions', () => {
    const { original, options } = fixture();
    const result = new AccountSpaceStateStore(options).initialize();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.manifest.activeWorkspaceId).toBe('personal');
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
