import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sealBrowsingArchive, unsealBrowsingArchive } from '../electron/browsing-recovery';
import { applyBrowsingRetention } from '../electron/runtime-state-store';
import type { AccountBackupPayload } from '../electron/account-backup';
import type { AccountSpaceId, RuntimeBrowserStateV2 } from '../electron/types';
import { DEFAULT_UI_PREFERENCES } from '../electron/ui-preferences';

const id = '11111111-1111-4111-8111-111111111111' as AccountSpaceId;
const url = 'https://archive-fixture.example/private-page';
const fixture = { id: 'fixture', workspaceId: 'personal', accountSpaceId: id, url, title: 'Private fixture', visitedAt: '2026-11-01T10:22:09Z' } as const;

describe('portable browsing privacy', () => {
  it('authenticates a recovery file independently of the device key', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'private-browser-portable-fixture-'));
    try {
      const archive = join(temp, 'fixture.pbbr');
      const key = 'A long test passphrase for portable browsing';
      const payload: AccountBackupPayload = { version: 1, workspaceId: 'personal', createdAt: fixture.visitedAt,
        bookmarks: [], bookmarkFolders: [], settings: { trackerBlocking: true }, history: [fixture] };
      const bytes = await sealBrowsingArchive(payload, key);
      writeFileSync(archive, bytes);
      expect(bytes.toString()).not.toContain(url);
      await expect(unsealBrowsingArchive(archive, key)).resolves.toEqual(payload);
      await expect(unsealBrowsingArchive(archive, 'A wrong passphrase for this fixture')).rejects.toThrow(/incorrect/);
      const tampered = JSON.parse(bytes.toString());
      tampered.body.ciphertext = (tampered.body.ciphertext[0] === 'A' ? 'B' : 'A') + tampered.body.ciphertext.slice(1);
      writeFileSync(archive, JSON.stringify(tampered));
      await expect(unsealBrowsingArchive(archive, key)).rejects.toThrow(/file has changed/);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  it('keeps recent history and stores only generic timed privacy entries', () => {
    const state: Pick<RuntimeBrowserStateV2, 'ui' | 'history' | 'privacyLog' | 'historyTrimmedByAccountSpace'> = {
      ui: { ...DEFAULT_UI_PREFERENCES, historyRetentionDays: 30, minimalPrivacyLog: true },
      history: [fixture, { ...fixture, id: 'old', visitedAt: '2026-10-01T00:00:00Z' }],
      privacyLog: [{ id: 'metadata', at: fixture.visitedAt, kind: 'blocked', service: 'browser', accountSpaceId: id, title: fixture.title, detail: url }],
    };
    applyBrowsingRetention(state, Date.parse('2026-11-20T00:00:00Z'));
    expect(state.history).toEqual([fixture]);
    expect(state.historyTrimmedByAccountSpace?.[id]).toBe(true);
    expect(state.privacyLog).toEqual([{ id: 'metadata', at: '2026-11-01T10:22:00.000Z', kind: 'blocked', service: 'browser', accountSpaceId: id, title: 'Blocked action', detail: '' }]);
  });
});
