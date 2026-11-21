import { isAllowedRemoteUrl, stripTrackingParameters } from './security.js';
import type { Bookmark, BrowserTab } from './types.js';

export const MAX_BOOKMARK_BATCH = 20;

export function bookmarkBatchChoices(bookmarks: Bookmark[], tabs: BrowserTab[]) {
  const open = new Set(tabs.filter((tab) => !tab.isHome).map((tab) => stripTrackingParameters(tab.url)));
  const seen = new Set<string>();
  return bookmarks.map((bookmark) => {
    const url = stripTrackingParameters(bookmark.url);
    const reason = !isAllowedRemoteUrl(url) ? 'Address unavailable'
      : open.has(url) ? 'Already open'
      : seen.has(url) ? 'Duplicate address' : undefined;
    seen.add(url);
    return { bookmark, reason };
  });
}

export function planBookmarkBatch(bookmarks: Bookmark[], tabs: BrowserTab[], ids: string[]) {
  const owned = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));
  const selected = [...new Set(ids)].flatMap((id) => {
    const bookmark = owned.get(id);
    return bookmark ? [bookmark] : [];
  });
  const choices = bookmarkBatchChoices(selected, tabs);
  const reused = choices.filter((choice) => choice.reason === 'Already open').length;
  const pending = choices.filter((choice) => !choice.reason).slice(0, Math.min(MAX_BOOKMARK_BATCH, Math.max(0, 100 - tabs.length)));
  return { pending, reused, skipped: ids.length - pending.length - reused };
}
