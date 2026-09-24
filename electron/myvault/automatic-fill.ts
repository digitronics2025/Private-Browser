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

/** Rows the login picker shows at most; the list is for choosing, not browsing. */
export const FILL_PICKER_MAX_ROWS = 8;

/**
 * Fillable logins in the order both fill paths use: the user's most recent
 * manual choice first, then newest saved login, then source order.
 */
export function orderFillCandidates(
  entries: VaultEntryMetadata[],
  preferredId?: string,
): VaultEntryMetadata[] {
  const ordered = entries
    .filter((entry) => entry.hasPassword && Boolean(entry.url))
    .map((entry, index) => ({ entry, index, timestamp: Date.parse(entry.updatedAt) }))
    .sort((left, right) => {
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
