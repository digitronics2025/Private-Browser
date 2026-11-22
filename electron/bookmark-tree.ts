import type { Bookmark, BookmarkFolder } from './types.js';

/**
 * Bookmark rows carry their existing folder paths. Explicit folder records keep
 * empty folders and preserve their order. Sibling order at depth `d` is
 * `orderPath[d]` (falling back to `order`), which preserves the imported Chrome
 * order. These helpers are pure so both processes and the tests share them.
 */

export type BookmarkLocation = Bookmark['location'];

export interface BookmarkLevel {
  location: BookmarkLocation;
  path: string[];
}

export type BookmarkEntryKey = { kind: 'bookmark'; id: string } | { kind: 'folder'; name: string };

export type BookmarkTreeEntry<T extends Bookmark = Bookmark> =
  | { kind: 'bookmark'; order: number; item: T }
  | { kind: 'folder'; order: number; name: string; descendants: T[] };

export function bookmarkImportIdentity(item: Bookmark): string {
  return JSON.stringify([item.accountSpaceId, item.location, item.folderPath, item.title, item.url]);
}

export function planImportedBookmarks(current: Bookmark[], incoming: Bookmark[]) {
  const existing = new Set(current.map(bookmarkImportIdentity));
  const accepted: Bookmark[] = [];
  let duplicates = 0;
  let overLimit = 0;
  for (const item of incoming) {
    const key = bookmarkImportIdentity(item);
    if (existing.has(key)) { duplicates += 1; continue; }
    existing.add(key);
    if (current.length + accepted.length >= 25_000) { overLimit += 1; continue; }
    accepted.push(item);
  }
  return { accepted, duplicates, overLimit };
}

export function appendImportedBookmarks(current: Bookmark[], incoming: Bookmark[]): number {
  const { accepted } = planImportedBookmarks(current, incoming);
  current.push(...accepted);
  return accepted.length;
}

export function bookmarkOrder(item: Bookmark, depth: number): number {
  return item.orderPath?.[depth] ?? item.order;
}

export function hasBookmarkPath(path: string[], prefix: string[]): boolean {
  return prefix.every((part, index) => path[index] === part);
}

function inPath(item: Bookmark, path: string[]): boolean {
  return hasBookmarkPath(item.folderPath, path);
}

export const MAX_BOOKMARK_FOLDERS = 5000;

export function validateBookmarkFolders(value: unknown): BookmarkFolder[] {
  if (!Array.isArray(value)) return [];
  const folders = new Map<string, BookmarkFolder>();
  for (const item of value.slice(0, MAX_BOOKMARK_FOLDERS)) {
    if (!item || (item.location !== 'bar' && item.location !== 'other') || !Array.isArray(item.path)
      || !item.path.length || item.path.length > 20 || !item.path.every((part: unknown) => typeof part === 'string' && part.length > 0 && part.length <= 200)) continue;
    const orderPath = item.path.map((_: string, depth: number) => Number.isSafeInteger(item.orderPath?.[depth]) && item.orderPath[depth] >= 0 ? item.orderPath[depth] : 0);
    const folder = { location: item.location, path: [...item.path], orderPath };
    const key = JSON.stringify([folder.location, folder.path]);
    if (!folders.has(key)) folders.set(key, folder);
  }
  return [...folders.values()];
}

export function appendBookmarkFolders(current: BookmarkFolder[], incoming: BookmarkFolder[]): BookmarkFolder[] {
  return validateBookmarkFolders([...current, ...incoming]);
}

export function rememberBookmarkFolders(bookmarks: Bookmark[], saved: BookmarkFolder[]): BookmarkFolder[] {
  const folders = new Map(saved.map((item) => [JSON.stringify([item.location, item.path]), item]));
  for (const item of bookmarks) {
    for (let depth = 1; depth <= item.folderPath.length; depth += 1) {
      if (folders.size >= MAX_BOOKMARK_FOLDERS) return [...folders.values()];
      const path = item.folderPath.slice(0, depth);
      const key = JSON.stringify([item.location, path]);
      if (!folders.has(key)) folders.set(key, { location: item.location, path, orderPath: path.map((_, index) => bookmarkOrder(item, index)) });
    }
  }
  return [...folders.values()];
}

export function undoImportedBookmarkFolders(bookmarks: Bookmark[], saved: BookmarkFolder[], imported: BookmarkFolder[]): BookmarkFolder[] {
  const removable = new Set(imported.map((item) => JSON.stringify(item)));
  const preserved = saved.filter((item) => !removable.has(JSON.stringify(item)));
  return saved.filter((item) => !removable.has(JSON.stringify(item))
    || bookmarks.some((bookmark) => bookmark.location === item.location && inPath(bookmark, item.path))
    || preserved.some((folder) => folder.location === item.location && hasBookmarkPath(folder.path, item.path)));
}

export function nextBookmarkOrder(items: Bookmark[], folders: BookmarkFolder[], level: BookmarkLevel): number[] {
  const matchingItems = items.filter((item) => item.location === level.location && inPath(item, level.path));
  const matchingFolders = folders.filter((item) => item.location === level.location && hasBookmarkPath(item.path, level.path));
  if (level.path.length && !matchingItems.length && !matchingFolders.length) throw new Error('The destination folder is no longer available.');
  const siblings = bookmarkEntries(matchingItems, level.path, matchingFolders);
  const parent = level.path.map((_, depth) => Math.min(
    ...matchingItems.map((item) => bookmarkOrder(item, depth)),
    ...matchingFolders.map((item) => item.orderPath[depth] ?? 0),
  ));
  const order = siblings.reduce((highest, entry) => Math.max(highest, entry.order), -1) + 1;
  return [...parent, Math.min(order, Number.MAX_SAFE_INTEGER)];
}

export function createBookmarkFolder(items: Bookmark[], folders: BookmarkFolder[], parent: BookmarkLevel, name: string): BookmarkFolder[] {
  const clean = name.trim();
  if (!clean || clean.length > 200 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error('Enter a folder name.');
  if (parent.path.length >= 20 || folders.length >= MAX_BOOKMARK_FOLDERS) throw new Error('This Account Space has reached its folder limit.');
  const path = [...parent.path, clean];
  if (folderExists(items, folders, { location: parent.location, path })) throw new Error('A folder with that name already exists here.');
  return [...folders, { location: parent.location, path, orderPath: nextBookmarkOrder(items, folders, parent) }];
}

function folderExists(items: Bookmark[], folders: BookmarkFolder[], level: BookmarkLevel): boolean {
  return !level.path.length || items.some((item) => item.location === level.location && inPath(item, level.path))
    || folders.some((item) => item.location === level.location && hasBookmarkPath(item.path, level.path));
}

export function editBookmarkFolder<T extends Bookmark>(all: T[], folders: BookmarkFolder[], accountId: string,
  source: BookmarkLevel, destination?: BookmarkLevel): { bookmarks: T[]; folders: BookmarkFolder[] } {
  const owned = all.filter((item) => item.accountSpaceId === accountId);
  if (!source.path.length || !folderExists(owned, folders, source)) throw new Error('Folder was not found.');
  const sameLevel = (item: BookmarkLevel) => item.location === source.location && hasBookmarkPath(item.path, source.path);
  const matches = (item: T) => item.accountSpaceId === accountId && item.location === source.location && inPath(item, source.path);
  if (!destination) return { bookmarks: all.filter((item) => !matches(item)), folders: folders.filter((item) => !sameLevel(item)) };
  if (!destination.path.length || destination.path.length > 20) throw new Error('Choose a folder destination.');
  if (sameLevel(destination)) {
    if (source.path.length === destination.path.length) return { bookmarks: all, folders };
    throw new Error('Choose a destination outside the folder being moved.');
  }
  if (folderExists(owned, folders, destination)) throw new Error('A folder with that name already exists here.');
  const parent = { location: destination.location, path: destination.path.slice(0, -1) };
  const orderPath = source.location === destination.location && source.path.length === destination.path.length && hasBookmarkPath(source.path, parent.path)
    ? nextBookmarkOrder(owned, folders, source).slice(0, -1) : nextBookmarkOrder(owned, folders, parent);
  const depth = source.path.length;
  const movePath = (path: string[]) => {
    const result = [...destination.path, ...path.slice(depth)];
    if (result.length > 20) throw new Error('This folder would be nested too deeply.');
    return result;
  };
  return {
    bookmarks: all.map((item) => {
      if (!matches(item)) return item;
      const placement = [...orderPath, ...item.folderPath.slice(depth).map((_, step) => bookmarkOrder(item, depth + step)),
        bookmarkOrder(item, item.folderPath.length)];
      return { ...item, location: destination.location, folderPath: movePath(item.folderPath), orderPath: placement, order: placement[0] };
    }),
    folders: folders.map((item) => sameLevel(item) ? { location: destination.location, path: movePath(item.path),
      orderPath: [...orderPath, ...item.orderPath.slice(depth)] } : item),
  };
}

/** Direct children (bookmarks and folders) at one level, in display order. */
export function bookmarkEntries<T extends Bookmark>(items: T[], path: string[], savedFolders: BookmarkFolder[] = []): Array<BookmarkTreeEntry<T>> {
  const depth = path.length;
  const entries: BookmarkTreeEntry<T>[] = [];
  const folders = new Map<string, Extract<BookmarkTreeEntry<T>, { kind: 'folder' }>>();
  const include = (name: string, order: number, item?: T) => {
    let entry = folders.get(name);
    if (!entry) {
      entry = { kind: 'folder', order, name, descendants: [] };
      folders.set(name, entry);
    }
    entry.order = Math.min(entry.order, order);
    if (item) entry.descendants.push(item);
  };
  for (const item of items) {
    if (!inPath(item, path)) continue;
    const order = bookmarkOrder(item, depth);
    if (item.folderPath.length === depth) entries.push({ kind: 'bookmark', item, order });
    else include(item.folderPath[depth], order, item);
  }
  for (const item of savedFolders) {
    if (item.path.length > depth && hasBookmarkPath(item.path, path)) include(item.path[depth], item.orderPath[depth] ?? 0);
  }
  return [...entries, ...folders.values()].sort((left, right) => left.order - right.order);
}

function entryMatches(entry: BookmarkTreeEntry, key: BookmarkEntryKey): boolean {
  return entry.kind === 'bookmark' ? key.kind === 'bookmark' && entry.item.id === key.id : key.kind === 'folder' && entry.name === key.name;
}

function withOrderAt<T extends Bookmark>(item: T, depth: number, order: number): T {
  const orderPath = [...(item.orderPath ?? [])];
  while (orderPath.length < depth) orderPath.push(orderPath.length === 0 ? item.order : 0);
  orderPath[depth] = order;
  return depth === 0 ? { ...item, orderPath, order } : { ...item, orderPath };
}

/**
 * Move one entry among its siblings. Only items in `accountSpaceId` are
 * considered or changed; every other Account Space's bookmarks pass through
 * untouched.
 */
export function reorderBookmarkEntry<T extends Bookmark>(bookmarks: T[], accountSpaceId: string, level: BookmarkLevel, key: BookmarkEntryKey, toIndex: number): T[] {
  return reorderBookmarkLevel(bookmarks, [], accountSpaceId, level, key, toIndex).bookmarks;
}

export function reorderBookmarkLevel<T extends Bookmark>(bookmarks: T[], folders: BookmarkFolder[], accountSpaceId: string,
  level: BookmarkLevel, key: BookmarkEntryKey, toIndex: number): { bookmarks: T[]; folders: BookmarkFolder[] } {
  const depth = level.path.length;
  const scoped = bookmarks.filter((item) => item.accountSpaceId === accountSpaceId && item.location === level.location);
  const entries = bookmarkEntries(scoped, level.path, folders.filter((item) => item.location === level.location));
  const from = entries.findIndex((entry) => entryMatches(entry, key));
  if (from < 0) throw new Error('Bookmark is no longer at that position');
  const [moved] = entries.splice(from, 1);
  entries.splice(Math.max(0, Math.min(entries.length, Math.trunc(toIndex))), 0, moved);
  const nextOrder = new Map<string, number>();
  const folderOrder = new Map<string, number>();
  entries.forEach((entry, order) => {
    const members = entry.kind === 'bookmark' ? [entry.item] : entry.descendants;
    for (const member of members) nextOrder.set(member.id, order);
    if (entry.kind === 'folder') folderOrder.set(entry.name, order);
  });
  return {
    bookmarks: bookmarks.map((item) => {
      if (item.accountSpaceId !== accountSpaceId || item.location !== level.location) return item;
      const order = nextOrder.get(item.id);
      return order === undefined ? item : withOrderAt(item, depth, order);
    }),
    folders: folders.map((item) => {
      if (item.location !== level.location || !hasBookmarkPath(item.path, level.path)) return item;
      const order = folderOrder.get(item.path[depth]);
      return order === undefined ? item : { ...item, orderPath: item.orderPath.map((previous, index) => index === depth ? order : previous) };
    }),
  };
}

/** An empty title is allowed: the bookmarks bar then shows the icon alone, as Chrome does. */
export function renameBookmark<T extends Bookmark>(bookmarks: T[], id: string, title: string): T[] {
  const clean = title.trim().slice(0, 500);
  if (!bookmarks.some((item) => item.id === id)) throw new Error('Bookmark was not found');
  return bookmarks.map((item) => item.id === id ? { ...item, title: clean } : item);
}

export function removeBookmark<T extends Bookmark>(bookmarks: T[], id: string): T[] {
  if (!bookmarks.some((item) => item.id === id)) throw new Error('Bookmark was not found');
  return bookmarks.filter((item) => item.id !== id);
}

function inFolder(item: Bookmark, accountSpaceId: string, level: BookmarkLevel, name: string): boolean {
  return item.accountSpaceId === accountSpaceId
    && item.location === level.location
    && item.folderPath.length > level.path.length
    && inPath(item, level.path)
    && item.folderPath[level.path.length] === name;
}

export function renameBookmarkFolder<T extends Bookmark>(bookmarks: T[], accountSpaceId: string, level: BookmarkLevel, name: string, nextName: string): T[] {
  const clean = nextName.trim().slice(0, 200);
  if (!clean) throw new Error('A folder needs a name');
  if (clean === name) return bookmarks;
  if (!bookmarks.some((item) => inFolder(item, accountSpaceId, level, name))) throw new Error('Folder was not found');
  if (bookmarks.some((item) => inFolder(item, accountSpaceId, level, clean))) throw new Error('A folder with that name already exists here');
  const depth = level.path.length;
  return bookmarks.map((item) => {
    if (!inFolder(item, accountSpaceId, level, name)) return item;
    const folderPath = [...item.folderPath];
    folderPath[depth] = clean;
    return { ...item, folderPath };
  });
}

export function removeBookmarkFolder<T extends Bookmark>(bookmarks: T[], accountSpaceId: string, level: BookmarkLevel, name: string): T[] {
  if (!bookmarks.some((item) => inFolder(item, accountSpaceId, level, name))) throw new Error('Folder was not found');
  return bookmarks.filter((item) => !inFolder(item, accountSpaceId, level, name));
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function exportLevel(items: Bookmark[], path: string[], indent: string, folders: BookmarkFolder[]): string[] {
  const lines: string[] = [];
  for (const entry of bookmarkEntries(items, path, folders)) {
    if (entry.kind === 'bookmark') {
      const added = Math.floor(new Date(entry.item.createdAt).getTime() / 1000);
      lines.push(`${indent}<DT><A HREF="${escapeHtml(entry.item.url)}"${Number.isFinite(added) ? ` ADD_DATE="${added}"` : ''}>${escapeHtml(entry.item.title)}</A>`);
    } else {
      lines.push(`${indent}<DT><H3>${escapeHtml(entry.name)}</H3>`, `${indent}<DL><p>`, ...exportLevel(entry.descendants, [...path, entry.name], `${indent}    `, folders), `${indent}</DL><p>`);
    }
  }
  return lines;
}

/** Netscape bookmark file, the format every mainstream browser imports. */
export function exportBookmarksHtml(bookmarks: Bookmark[], folders: BookmarkFolder[] = []): string {
  const bar = bookmarks.filter((item) => item.location === 'bar');
  const other = bookmarks.filter((item) => item.location === 'other');
  const barFolders = folders.filter((item) => item.location === 'bar');
  const otherFolders = folders.filter((item) => item.location === 'other');
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    '    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>',
    '    <DL><p>',
    ...exportLevel(bar, [], '        ', barFolders),
    '    </DL><p>',
    ...(other.length || otherFolders.length ? ['    <DT><H3>Other bookmarks</H3>', '    <DL><p>', ...exportLevel(other, [], '        ', otherFolders), '    </DL><p>'] : []),
    '</DL><p>',
    '',
  ].join('\n');
}

/** Move a tab among the tabs of its own Account Space, keeping every other tab's position. */
export function moveTabWithinAccountSpace<T extends { id: string; accountSpaceId: string }>(tabs: T[], tabId: string, toIndex: number): T[] {
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab) throw new Error('Tab was not found');
  const siblings = tabs.filter((candidate) => candidate.accountSpaceId === tab.accountSpaceId && candidate.id !== tabId);
  const target = Math.max(0, Math.min(siblings.length, Math.trunc(toIndex)));
  siblings.splice(target, 0, tab);
  let cursor = 0;
  return tabs.map((candidate) => candidate.accountSpaceId === tab.accountSpaceId ? siblings[cursor++] : candidate);
}
