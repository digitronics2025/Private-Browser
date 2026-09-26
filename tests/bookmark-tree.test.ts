import { describe, expect, it } from 'vitest';
import { bookmarkEntries, exportBookmarksHtml, moveTabWithinAccountSpace, removeBookmark, removeBookmarkFolder, renameBookmark, renameBookmarkFolder, reorderBookmarkEntry } from '../electron/bookmark-tree';
import type { AccountSpaceId, Bookmark } from '../electron/types';

const A = 'a' as AccountSpaceId;
const B = 'b' as AccountSpaceId;

function item(id: string, folderPath: string[], orderPath: number[], accountSpaceId = A, location: Bookmark['location'] = 'bar'): Bookmark {
  return { id, title: id, url: `https://${id}.example/`, workspaceId: 'personal', accountSpaceId, createdAt: '2026-09-14T08:00:00Z', location, folderPath, order: orderPath[0], orderPath };
}

const tree = () => [
  item('one', [], [0]),
  item('work-a', ['Work'], [1, 0]),
  item('work-b', ['Work', 'Deep'], [1, 1, 0]),
  item('two', [], [2]),
  item('other-space', [], [0], B),
];

const names = (bookmarks: Bookmark[], accountSpaceId: string, path: string[] = []) => bookmarkEntries(bookmarks.filter((entry) => entry.accountSpaceId === accountSpaceId), path)
  .map((entry) => (entry.kind === 'bookmark' ? entry.item.id : `[${entry.name}]`));

describe('bookmark tree', () => {
  it('keeps imported Chrome order with folders between bookmarks', () => {
    expect(names(tree(), A)).toEqual(['one', '[Work]', 'two']);
    expect(names(tree(), A, ['Work'])).toEqual(['work-a', '[Deep]']);
  });

  it('moves a whole folder and every descendant together', () => {
    const moved = reorderBookmarkEntry(tree(), A, { location: 'bar', path: [] }, { kind: 'folder', name: 'Work' }, 0);
    expect(names(moved, A)).toEqual(['[Work]', 'one', 'two']);
    expect(names(moved, A, ['Work'])).toEqual(['work-a', '[Deep]']);
    expect(names(moved, B)).toEqual(['other-space']);
    expect(moved.find((entry) => entry.id === 'other-space')).toEqual(tree()[4]);
  });

  it('moves a bookmark inside a folder without disturbing the parent level', () => {
    const moved = reorderBookmarkEntry(tree(), A, { location: 'bar', path: ['Work'] }, { kind: 'folder', name: 'Deep' }, 0);
    expect(names(moved, A, ['Work'])).toEqual(['[Deep]', 'work-a']);
    expect(names(moved, A)).toEqual(['one', '[Work]', 'two']);
  });

  it('refuses a move for an entry that is not there', () => {
    expect(() => reorderBookmarkEntry(tree(), B, { location: 'bar', path: [] }, { kind: 'bookmark', id: 'one' }, 1)).toThrow(/no longer/);
  });

  it('renames and removes bookmarks and folders only in the given Account Space', () => {
    expect(renameBookmark(tree(), 'one', '  Renamed  ').find((entry) => entry.id === 'one')?.title).toBe('Renamed');
    expect(renameBookmark(tree(), 'one', '   ').find((entry) => entry.id === 'one')?.title).toBe('');
    expect(removeBookmark(tree(), 'two').map((entry) => entry.id)).not.toContain('two');
    const renamed = renameBookmarkFolder(tree(), A, { location: 'bar', path: [] }, 'Work', 'Clients');
    expect(names(renamed, A)).toEqual(['one', '[Clients]', 'two']);
    expect(() => renameBookmarkFolder([...tree(), item('x', ['Clients'], [5, 0])], A, { location: 'bar', path: [] }, 'Work', 'Clients')).toThrow(/already exists/);
    expect(removeBookmarkFolder(tree(), A, { location: 'bar', path: [] }, 'Work').map((entry) => entry.id)).toEqual(['one', 'two', 'other-space']);
  });

  it('exports an escaped Netscape bookmark file', () => {
    const hostile = { ...item('x', ['<Folder>'], [0, 0]), title: '<script>alert(1)</script>', url: 'https://example.com/?a="b"&c=1' };
    const html = exportBookmarksHtml([hostile]);
    expect(html).toContain('<!DOCTYPE NETSCAPE-Bookmark-file-1>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('HREF="https://example.com/?a=&quot;b&quot;&amp;c=1"');
    expect(html).toContain('<H3>&lt;Folder&gt;</H3>');
    expect(html).not.toContain('<script>');
  });

  it('reorders tabs only within their own Account Space', () => {
    const tabs = [{ id: '1', accountSpaceId: 'a' }, { id: 'x', accountSpaceId: 'b' }, { id: '2', accountSpaceId: 'a' }, { id: '3', accountSpaceId: 'a' }];
    expect(moveTabWithinAccountSpace(tabs, '3', 0).map((tab) => tab.id)).toEqual(['3', 'x', '1', '2']);
    expect(moveTabWithinAccountSpace(tabs, '1', 99).map((tab) => tab.id)).toEqual(['2', 'x', '3', '1']);
  });
});
