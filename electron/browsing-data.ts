import { requireAccountSpaceId } from './account-space-validation.js';
import { isAllowedRemoteUrl, parseWebAddress } from './security.js';
import type { BrowsingDataInput, BrowsingDataRange, HistoryEntry } from './types.js';

const RANGES: Readonly<Record<BrowsingDataRange, number>> = {
  hour: 60 * 60 * 1_000,
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  all: Infinity,
};

export function requireBrowsingDataInput(value: unknown): BrowsingDataInput & { siteOrigin?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose which browsing data to delete.');
  const { accountSpaceId, range, site, history, websiteData, cache } = value as Partial<BrowsingDataInput>;
  if (typeof range !== 'string' || !Object.hasOwn(RANGES, range)
    || typeof site !== 'string' || site.length > 2048 || typeof history !== 'boolean'
    || typeof websiteData !== 'boolean' || typeof cache !== 'boolean' || !(history || websiteData || cache)) {
    throw new Error('Choose which browsing data to delete.');
  }
  let siteOrigin: string | undefined;
  if (site.trim()) {
    try {
      const address = parseWebAddress(site);
      if (address && isAllowedRemoteUrl(address)) siteOrigin = new URL(address).origin;
    } catch {
      // Malformed URLs are rejected instead of expanding the scope to every site.
    }
    if (!siteOrigin) throw new Error('Enter a valid HTTP or HTTPS site address.');
  }
  return { accountSpaceId: requireAccountSpaceId(accountSpaceId), range, site, siteOrigin, history, websiteData, cache };
}

export function browsingDataVisitIds(history: readonly HistoryEntry[], input: BrowsingDataInput & { siteOrigin?: string }, now: number): Set<string> {
  if (!input.history) return new Set();
  const earliest = now - RANGES[input.range];
  const matches = history.filter((item) => {
    const time = Date.parse(item.visitedAt);
    if (item.accountSpaceId !== input.accountSpaceId || !Number.isFinite(time) || time < earliest) return false;
    if (!input.siteOrigin) return true;
    try { return new URL(item.url).origin === input.siteOrigin; } catch { return false; }
  });
  return new Set(matches.map((item) => item.id));
}
