import { isAutofillTarget } from '../security.js';
import type { VaultEntryMetadata } from './vault-broker.js';

const ACCOUNT_CREATION_PATH = /(?:^|\/)(?:sign[-_]?up|signup|register|registration|create[-_]?account|forgot(?:ten)?[-_]?password|reset[-_]?password|change[-_]?password)(?:\/|$)/i;

/** Automatic credential injection is deliberately narrower than manual fill. */
export function isAutomaticFillPageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !ACCOUNT_CREATION_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

/** A sanity bound on the picker's rows; the list scrolls, so this is not a UI limit. */
export const FILL_PICKER_MAX_ROWS = 50;

/**
 * Fillable logins in the order both fill paths use: the user's most recent
 * manual choice first, then newest saved login, then source order. Given the
 * page origin, logins saved for that exact origin come before those saved for
 * other addresses of the same site (the picker's second tier).
 */
export function orderFillCandidates(
  entries: VaultEntryMetadata[],
  preferredId?: string,
  exactOrigin?: string,
): VaultEntryMetadata[] {
  const ordered = entries
    .filter((entry) => entry.hasPassword && Boolean(entry.url))
    .map((entry, index) => ({ entry, index, timestamp: Date.parse(entry.updatedAt) }))
    .map((item) => ({ ...item, tier: exactOrigin && !isAutofillTarget(item.entry.url!, exactOrigin) ? 1 : 0 }))
    .sort((left, right) => {
      if (left.tier !== right.tier) return left.tier - right.tier;
      const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : 0;
      const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : 0;
      return rightTime - leftTime || left.index - right.index;
    })
    .map(({ entry }) => entry);
  const preferred = preferredId ? ordered.findIndex((entry) => entry.id === preferredId) : -1;
  if (preferred > 0) ordered.unshift(...ordered.splice(preferred, 1));
  return ordered;
}

/** Prefer the user's most recent manual choice, then the newest saved login. */
export function selectAutomaticFillEntry(
  entries: VaultEntryMetadata[],
  preferredId?: string,
): VaultEntryMetadata | undefined {
  return orderFillCandidates(entries, preferredId)[0];
}
