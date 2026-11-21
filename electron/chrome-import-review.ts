import { createHash } from 'node:crypto';
import { bookmarkImportIdentity, planImportedBookmarks } from './bookmark-tree.js';
import type { ChromeProfileData } from './chrome-importer.js';
import type { Bookmark, ChromeImportReview, ChromeImportResult, HistoryEntry } from './types.js';

type BrowsingData = { bookmarks: Bookmark[]; history: HistoryEntry[] };
type ReviewSummary = Omit<ChromeImportReview, 'id' | 'accountSpaceId'>;

export function planChromeImport(current: BrowsingData, source: ChromeProfileData): BrowsingData & { summary: ReviewSummary } {
  const planned = planImportedBookmarks(current.bookmarks, source.bookmarks);
  const historyKey = (item: HistoryEntry) => JSON.stringify([item.accountSpaceId, item.url, item.visitedAt]);
  const known = new Set(current.history.map(historyKey));
  const history: HistoryEntry[] = [];
  let duplicateHistory = 0;
  let historyOverLimit = 0;
  for (const item of source.history) {
    const key = historyKey(item);
    if (known.has(key)) { duplicateHistory += 1; continue; }
    known.add(key);
    if (current.history.length + history.length >= 10_000) { historyOverLimit += 1; continue; }
    history.push(item);
  }
  const folders = new Map<string, ChromeImportReview['folders'][number]>();
  for (const item of planned.accepted) {
    const key = JSON.stringify([item.location, item.folderPath]);
    const row = folders.get(key);
    if (row) row.count += 1;
    else folders.set(key, { location: item.location, path: item.folderPath, count: 1 });
  }
  const range = history.map(({ visitedAt }) => visitedAt).sort();
  const result: ChromeImportResult = {
    imported: { ...source.result.imported, bookmarks: planned.accepted.length, history: history.length },
    skipped: {
      ...source.result.skipped,
      bookmarks: source.result.skipped.bookmarks + planned.duplicates + planned.overLimit,
      history: source.result.skipped.history + duplicateHistory + historyOverLimit,
    },
    warnings: source.result.warnings,
    appliedSettings: source.result.appliedSettings,
  };
  return {
    bookmarks: planned.accepted,
    history,
    summary: {
      result, duplicates: planned.duplicates + duplicateHistory,
      unsupported: source.result.skipped.bookmarks + source.result.skipped.history,
      overLimit: planned.overLimit + historyOverLimit,
      folders: [...folders.values()].slice(0, 50), moreFolders: Math.max(0, folders.size - 50),
      historyRange: range.length ? { from: range[0], through: range.at(-1)! } : undefined,
      settingsPatch: source.settingsPatch,
    },
  };
}

export function chromeImportKey(data: BrowsingData): string {
  return createHash('sha256').update(JSON.stringify([data.bookmarks.map(({ id }) => id), data.history.map(({ id }) => id)])).digest('hex');
}

export function chromeImportBookmarkStamp(bookmark: Bookmark): string {
  return createHash('sha256').update(bookmarkImportIdentity(bookmark)).digest('hex');
}
