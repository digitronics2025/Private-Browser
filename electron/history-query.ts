import type { AccountSpaceId, HistoryEntry, HistoryPage, HistoryQuery } from './types.js';

export const RETAINED_HISTORY_LIMIT = 10_000;
export const HISTORY_PAGE_SIZE = 40;

export function queryHistory(history: readonly HistoryEntry[], accountId: AccountSpaceId, input: HistoryQuery, trimmed = false): HistoryPage {
  const needle = input.text.trim().toLowerCase();
  const site = input.site.trim().toLowerCase();
  const grouped = new Map<string, HistoryPage['entries'][number]>();
  for (const item of history) {
    if (item.accountSpaceId !== accountId) continue;
    const time = Date.parse(item.visitedAt);
    if (!Number.isFinite(time) || (input.from !== null && time < input.from) || (input.until !== null && time >= input.until)) continue;
    if (needle && !(item.title + ' ' + item.url).toLowerCase().includes(needle)) continue;
    if (site) {
      try {
        const host = new URL(item.url).hostname;
        if (host !== site && !host.endsWith('.' + site)) continue;
      } catch {
        continue;
      }
    }
    const existing = grouped.get(item.url);
    const visits = (existing?.visits ?? 0) + 1;
    if (existing && Date.parse(existing.visitedAt) >= time) existing.visits = visits;
    else grouped.set(item.url, { id: item.id, url: item.url, title: item.title, visitedAt: item.visitedAt, visits });
  }
  const ranked = [...grouped.values()].sort((a, b) => Date.parse(b.visitedAt) - Date.parse(a.visitedAt));
  const page = Math.min(input.page, Math.max(0, Math.ceil(ranked.length / HISTORY_PAGE_SIZE) - 1));
  return {
    entries: ranked.slice(page * HISTORY_PAGE_SIZE, (page + 1) * HISTORY_PAGE_SIZE),
    page,
    pages: Math.ceil(ranked.length / HISTORY_PAGE_SIZE),
    total: ranked.length,
    trimmed,
  };
}
