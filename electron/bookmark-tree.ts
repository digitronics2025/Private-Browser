import type { Bookmark } from './types.js';

/**
 * Bookmark folders are implicit: a folder exists while at least one bookmark
 * carries its name in `folderPath`. Sibling order at depth `d` is
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

export function bookmarkOrder(item: Bookmark, depth: number): number {
  return item.orderPath?.[depth] ?? item.order;
}

function inPath(item: Bookmark, path: string[]): boolean {
  return path.every((part, index) => item.folderPath[index] === part);
}

/** Direct children (bookmarks and folders) at one level, in display order. */
export function bookmarkEntries<T extends Bookmark>(items: T[], path: string[]): Array<BookmarkTreeEntry<T>> {
  const depth = path.length;
  const direct = items
    .filter((item) => item.folderPath.length === depth && inPath(item, path))
    .map((item) => ({ kind: 'bookmark' as const, order: bookmarkOrder(item, depth), item }));
  const folderNames = [...new Set(items
    .filter((item) => item.folderPath.length > depth && inPath(item, path))
    .map((item) => item.folderPath[depth]))];
  const folders = folderNames.map((name) => {
    const descendants = items.filter((item) => item.folderPath[depth] === name && inPath(item, path));
    return { kind: 'folder' as const, order: Math.min(...descendants.map((item) => bookmarkOrder(item, depth))), name, descendants };
  });
  return [...direct, ...folders].sort((left, right) => left.order - right.order);
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
  const depth = level.path.length;
  const scoped = bookmarks.filter((item) => item.accountSpaceId === accountSpaceId && item.location === level.location);
  const entries = bookmarkEntries(scoped, level.path);
  const from = entries.findIndex((entry) => entryMatches(entry, key));
  if (from < 0) throw new Error('Bookmark is no longer at that position');
  const [moved] = entries.splice(from, 1);
  entries.splice(Math.max(0, Math.min(entries.length, Math.trunc(toIndex))), 0, moved);
  const nextOrder = new Map<string, number>();
  entries.forEach((entry, order) => {
    const members = entry.kind === 'bookmark' ? [entry.item] : entry.descendants;
    for (const member of members) nextOrder.set(member.id, order);
  });
  return bookmarks.map((item) => {
    if (item.accountSpaceId !== accountSpaceId || item.location !== level.location) return item;
    const order = nextOrder.get(item.id);
    return order === undefined ? item : withOrderAt(item, depth, order);
  });
}

export function renameBookmark<T extends Bookmark>(bookmarks: T[], id: string, title: string): T[] {
  const clean = title.trim().slice(0, 500);
  if (!clean) throw new Error('A bookmark needs a name');
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

function exportLevel(items: Bookmark[], path: string[], indent: string): string[] {
  const lines: string[] = [];
  for (const entry of bookmarkEntries(items, path)) {
    if (entry.kind === 'bookmark') {
      const added = Math.floor(new Date(entry.item.createdAt).getTime() / 1000);
      lines.push(`${indent}<DT><A HREF="${escapeHtml(entry.item.url)}"${Number.isFinite(added) ? ` ADD_DATE="${added}"` : ''}>${escapeHtml(entry.item.title)}</A>`);
    } else {
      lines.push(`${indent}<DT><H3>${escapeHtml(entry.name)}</H3>`, `${indent}<DL><p>`, ...exportLevel(entry.descendants, [...path, entry.name], `${indent}    `), `${indent}</DL><p>`);
    }
  }
  return lines;
}

/** Netscape bookmark file, the format every mainstream browser imports. */
export function exportBookmarksHtml(bookmarks: Bookmark[]): string {
  const bar = bookmarks.filter((item) => item.location === 'bar');
  const other = bookmarks.filter((item) => item.location === 'other');
  return [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<!-- This is an automatically generated file. -->',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>',
    '    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>',
    '    <DL><p>',
    ...exportLevel(bar, [], '        '),
    '    </DL><p>',
    ...(other.length ? ['    <DT><H3>Other bookmarks</H3>', '    <DL><p>', ...exportLevel(other, [], '        '), '    </DL><p>'] : []),
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
