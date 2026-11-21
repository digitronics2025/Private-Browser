import { nextBookmarkOrder, type BookmarkLevel } from './bookmark-tree.js';
import { isAllowedRemoteUrl } from './security.js';
import type { Bookmark, BookmarkFolder } from './types.js';

export const MAX_BOOKMARK_EDIT_BATCH = 200;
const ACCOUNT_BOOKMARK_LIMIT = 25_000;

export type BookmarkUndo<T extends Bookmark = Bookmark> =
  | { kind: 'deleted'; before: T[] }
  | { kind: 'moved'; before: T[]; after: T[] };

export function bookmarkFolderKey(level: BookmarkLevel): string {
  return JSON.stringify([level.location, level.path]);
}

export function bookmarkFolderLabel(level: BookmarkLevel): string {
  return [level.location === 'bar' ? 'Bookmarks bar' : 'Other bookmarks', ...level.path].join(' / ');
}

export function bookmarkFolders(bookmarks: Bookmark[], saved: BookmarkFolder[] = []): BookmarkLevel[] {
  const folders = new Map<string, BookmarkLevel>();
  for (const location of ['bar', 'other'] as const) {
    const level = { location, path: [] };
    folders.set(bookmarkFolderKey(level), level);
  }
  const include = (location: BookmarkLevel['location'], path: string[]) => {
    for (let depth = 1; depth <= path.length; depth += 1) {
      const level = { location, path: path.slice(0, depth) };
      folders.set(bookmarkFolderKey(level), level);
    }
  };
  for (const item of bookmarks) include(item.location, item.folderPath);
  for (const item of saved) include(item.location, item.path);
  return [...folders.values()].sort((left, right) => bookmarkFolderLabel(left).localeCompare(bookmarkFolderLabel(right)));
}

export function duplicateBookmarkIds(bookmarks: Bookmark[]): Set<string> {
  const addresses = new Map<string, string[]>();
  for (const item of bookmarks) {
    const key = new URL(item.url).href;
    const ids = addresses.get(key);
    if (ids) ids.push(item.id);
    else addresses.set(key, [item.id]);
  }
  return new Set([...addresses.values()].filter((ids) => ids.length > 1).flat());
}

export function editBookmarkAddress<T extends Bookmark>(bookmarks: T[], id: string, address: string): T[] {
  if (!isAllowedRemoteUrl(address)) throw new Error('Enter an HTTP or HTTPS bookmark address');
  const url = new URL(address).href;
  if (url.length > 4096) throw new Error('The bookmark address is too long');
  return bookmarks.map((bookmark) => bookmark.id === id ? { ...bookmark, url } : bookmark);
}

export function changeBookmarkBatch<T extends Bookmark>(bookmarks: T[], account: string, ids: string[], destination?: BookmarkLevel, folders: BookmarkFolder[] = []): { bookmarks: T[]; undo?: BookmarkUndo<T> } {
  const selected = new Set(ids);
  const owned = bookmarks.filter((item) => item.accountSpaceId === account);
  const items = owned.filter((item) => selected.has(item.id));
  if (!ids.length || ids.length > MAX_BOOKMARK_EDIT_BATCH || ids.length !== selected.size || items.length !== selected.size) {
    throw new Error('Bookmark selection changed. Review the selected bookmarks and try again.');
  }
  if (!destination) return { bookmarks: bookmarks.filter((item) => !(item.accountSpaceId === account && selected.has(item.id))), undo: { kind: 'deleted', before: items } };

  const { location, path } = destination;
  const firstOrder = nextBookmarkOrder(owned, folders, destination);
  const before = items.filter((item) => item.location !== location || item.folderPath.length !== path.length || !path.every((part, index) => item.folderPath[index] === part));
  if (!before.length) return { bookmarks };

  const parentOrder = firstOrder.slice(0, -1);
  let nextOrder = firstOrder.at(-1)!;
  const after = before.map((item) => {
    const orderPath = [...parentOrder, Math.min(Number.MAX_SAFE_INTEGER, nextOrder++)];
    return { ...item, location, folderPath: [...path], orderPath, order: orderPath[0] };
  });
  const moved = new Map(after.map((item) => [item.id, item]));
  return {
    bookmarks: bookmarks.map((item) => item.accountSpaceId === account ? moved.get(item.id) ?? item : item),
    undo: { kind: 'moved', before, after },
  };
}

export function restoreBookmarkBatch<T extends Bookmark>(bookmarks: T[], account: string, undo: BookmarkUndo<T>): { bookmarks: T[]; restored: number } {
  if (undo.kind === 'deleted') {
    const ids = new Set(bookmarks.map((item) => item.id));
    const recovered = undo.before.filter((item) => !ids.has(item.id));
    if (bookmarks.filter((item) => item.accountSpaceId === account).length + recovered.length > ACCOUNT_BOOKMARK_LIMIT) {
      throw new Error('Make room in this Account Space before restoring these bookmarks.');
    }
    return { bookmarks: [...bookmarks, ...recovered], restored: recovered.length };
  }
  const changes = new Map(undo.after.map((item, index) => [item.id, { after: item, before: undo.before[index] }]));
  let restored = 0;
  const next = bookmarks.map((item) => {
    const change = item.accountSpaceId === account ? changes.get(item.id) : undefined;
    if (!change || !samePlacement(item, change.after)) return item;
    const { location, order, folderPath, orderPath } = change.before;
    restored += 1;
    return { ...item, location, order, folderPath, orderPath };
  });
  return { bookmarks: next, restored };
}

function samePlacement(left: Bookmark, right: Bookmark): boolean {
  return left.location === right.location && left.order === right.order
    && JSON.stringify(left.folderPath) === JSON.stringify(right.folderPath)
    && JSON.stringify(left.orderPath) === JSON.stringify(right.orderPath);
}
