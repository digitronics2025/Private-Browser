import { isAllowedRemoteUrl } from './security.js';
import type { AccountSpaceId, AddressMatch, Bookmark, BrowserTab, HistoryEntry } from './types.js';

const MAX_MATCHES = 8;
export const MAX_ADDRESS_QUERY_LENGTH = 256;

export function findAddressMatches(
  text: string,
  accountSpaceId: AccountSpaceId,
  tabs: readonly BrowserTab[],
  bookmarks: readonly Bookmark[],
  history: readonly HistoryEntry[],
): AddressMatch[] {
  const query = text.trim().toLowerCase();
  if (query.length < 2 || query.length > MAX_ADDRESS_QUERY_LENGTH) return [];
  const terms = query.split(/\s+/);
  const matches: AddressMatch[] = [];
  const seen = new Set<string>();

  function collect(source: AddressMatch['source'], entries: ReadonlyArray<Pick<AddressMatch, 'id' | 'title' | 'url'> & { accountSpaceId: AccountSpaceId }>) {
    for (const entry of entries) {
      if (matches.length === MAX_MATCHES) return;
      if (entry.accountSpaceId !== accountSpaceId || seen.has(entry.url)) continue;
      const searchable = (entry.title + ' ' + entry.url).toLowerCase();
      if (!terms.every((term) => searchable.includes(term)) || !isAllowedRemoteUrl(entry.url)) continue;
      seen.add(entry.url);
      matches.push({ id: entry.id, title: entry.title, url: entry.url, source });
    }
  }

  collect('tab', tabs);
  collect('bookmark', bookmarks);
  collect('history', history);
  return matches;
}
