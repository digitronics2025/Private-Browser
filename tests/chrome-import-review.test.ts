import { expect, it } from 'vitest';
import { chromeImportKey, planChromeImport } from '../electron/chrome-import-review';
import type { AccountSpaceId, Bookmark, HistoryEntry } from '../electron/types';

const account = '122b503d-a1b3-497a-a610-e193af8d0702' as AccountSpaceId;
const other = '6ba2c705-9ba8-4f4a-9af2-46f8a36f9fc4' as AccountSpaceId;
const url = 'https://example.test/reference';
const date = '2026-11-20T12:00:00.000Z';
const bookmark: Bookmark = { id: 'incoming', accountSpaceId: account, workspaceId: 'personal', title: 'Reference', url, createdAt: date,
  location: 'bar', folderPath: ['References'], order: 0, orderPath: [0, 0] };
const entry: HistoryEntry = { id: 'history-incoming', accountSpaceId: account, workspaceId: 'personal', title: 'Reference', url, visitedAt: date };
const source = {
  bookmarks: [bookmark], history: [entry],
  result: { imported: { bookmarks: 0, history: 0, passwords: 0 }, skipped: { bookmarks: 1, history: 0, passwords: 0 }, warnings: [] },
};

it('previews only records that can be added to the chosen account and detects a stale review', () => {
  const current = { bookmarks: [{ ...bookmark, id: 'elsewhere', accountSpaceId: other }], history: [] as HistoryEntry[] };
  const review = planChromeImport(current, source);
  expect(current.bookmarks).toHaveLength(1);
  expect(review.summary).toMatchObject({
    duplicates: 0, unsupported: 1, overLimit: 0,
    folders: [{ location: 'bar', path: ['References'], count: 1 }],
    historyRange: { from: date, through: date },
    result: { imported: { bookmarks: 1, history: 1 }, skipped: { bookmarks: 1, history: 0 } },
  });
  const changed = planChromeImport({ bookmarks: [...current.bookmarks, { ...bookmark, id: 'already-added' }], history: [{ ...entry, id: 'old-visit' }] }, source);
  expect(changed.summary.duplicates).toBe(2);
  expect(changed.summary.result.imported).toMatchObject({ bookmarks: 0, history: 0 });
  expect(chromeImportKey(changed)).not.toBe(chromeImportKey(review));
});
