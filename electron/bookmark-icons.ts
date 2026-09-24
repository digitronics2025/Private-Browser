import type { Bookmark } from './types.js';

/**
 * Remembered bookmark icons: host → inert `data:` URL, one map per Account Space.
 *
 * An icon is only ever recorded from a favicon the main process already fetched
 * for a page the user opened (see `updateFavicon`), and only for a host that has
 * a bookmark in that same Account Space. Nothing here fetches anything, so
 * remembering an icon never makes the browser contact a site on its own.
 */

export const FAVICON_TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_FAVICON_BYTES = 32 * 1024;
/** Per Account Space. The active space's map rides in every state broadcast, so it stays bounded. */
export const MAX_BOOKMARK_ICONS = 300;

export type BookmarkIcons = Record<string, string>;

const HOST_PATTERN = /^[a-z0-9.\-[\]:]{1,253}$/;
const MAX_DATA_URL_LENGTH = 'data:image/vnd.microsoft.icon;base64,'.length + Math.ceil(MAX_FAVICON_BYTES / 3) * 4;

/** Must match the renderer's `domainFromUrl`, which is how bookmarks look their icon up. */
export function bookmarkIconHost(url: string): string | undefined {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return undefined;
    const host = hostname.replace(/^www\./, '');
    return HOST_PATTERN.test(host) ? host : undefined;
  } catch {
    return undefined;
  }
}

export function isBookmarkIconDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_DATA_URL_LENGTH) return false;
  const match = /^data:([a-z+./-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  return Boolean(match && FAVICON_TYPES.has(match[1]!));
}

/** Drops anything malformed and caps the map; used on load and on every save. */
export function sanitizeBookmarkIcons(value: unknown): BookmarkIcons | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const icons: BookmarkIcons = {};
  let count = 0;
  for (const [host, dataUrl] of Object.entries(value)) {
    if (count >= MAX_BOOKMARK_ICONS) break;
    if (!HOST_PATTERN.test(host) || !isBookmarkIconDataUrl(dataUrl)) continue;
    icons[host] = dataUrl;
    count += 1;
  }
  return count ? icons : undefined;
}

/** Keeps only icons whose host still has a bookmark in this Account Space. */
export function pruneBookmarkIcons(icons: BookmarkIcons | undefined, bookmarks: Bookmark[]): BookmarkIcons | undefined {
  if (!icons) return undefined;
  const hosts = new Set(bookmarks.map((item) => bookmarkIconHost(item.url)).filter(Boolean));
  const kept = Object.fromEntries(Object.entries(icons).filter(([host]) => hosts.has(host)));
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Returns the updated map when `pageUrl`'s host is bookmarked in `bookmarks` and
 * the icon is new or changed, otherwise `undefined` so the caller can skip a save.
 */
export function rememberBookmarkIcon(icons: BookmarkIcons | undefined, bookmarks: Bookmark[], pageUrl: string, dataUrl: string): BookmarkIcons | undefined {
  const host = bookmarkIconHost(pageUrl);
  if (!host || !isBookmarkIconDataUrl(dataUrl) || icons?.[host] === dataUrl) return undefined;
  if (!bookmarks.some((item) => bookmarkIconHost(item.url) === host)) return undefined;
  const next = { ...icons, [host]: dataUrl };
  if (Object.keys(next).length > MAX_BOOKMARK_ICONS) return undefined;
  return next;
}
