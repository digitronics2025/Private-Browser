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

/** Prefer the user's most recent manual choice, then the newest saved login. */
export function selectAutomaticFillEntry(
  entries: VaultEntryMetadata[],
  preferredId?: string,
): VaultEntryMetadata | undefined {
  const eligible = entries.filter((entry) => entry.hasPassword && Boolean(entry.url));
  const preferred = preferredId ? eligible.find((entry) => entry.id === preferredId) : undefined;
  if (preferred) return preferred;
  return eligible
    .map((entry, index) => ({ entry, index, timestamp: Date.parse(entry.updatedAt) }))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : 0;
      const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : 0;
      return rightTime - leftTime || left.index - right.index;
    })[0]?.entry;
}
