import { expect, it } from 'vitest';
import { parseBookmarkHtml } from '../electron/bookmark-html';
import { appendImportedBookmarks, exportBookmarksHtml } from '../electron/bookmark-tree';
import type { AccountSpaceId, Bookmark, WorkspaceId } from '../electron/types';

const destination = { accountSpaceId: '122b503d-a1b3-497a-a610-e193af8d0702' as AccountSpaceId, workspaceId: 'personal' as WorkspaceId };
const date = '2026-11-21T12:00:00.000Z';

it('round-trips toolbar and other folders, escapes text and skips duplicate imports', async () => {
  const source: Bookmark[] = [
    { ...destination, id: 'one', title: 'Café & notes', url: 'https://example.test/?a=1&b=2', createdAt: date,
      location: 'bar', folderPath: ['Projects', 'References'], order: 0, orderPath: [0, 0, 0] },
    { ...destination, id: 'two', title: 'الشاي', url: 'https://example.test/tea', createdAt: date,
      location: 'other', folderPath: [], order: 0, orderPath: [0] },
  ];
  const parsed = await parseBookmarkHtml(exportBookmarksHtml(source), destination);
  expect(parsed.skipped).toBe(0);
  expect(parsed.bookmarks.map(({ id: _id, ...item }) => item)).toEqual(source.map(({ id: _id, ...item }) => item));
  const current = [...source];
  expect(appendImportedBookmarks(current, parsed.bookmarks)).toBe(0);
  expect(current).toEqual(source);
});

it('accepts only web bookmarks inside an HTML export and bounds folder depth', async () => {
  const deep = '<DT><H3>Nested</H3><DL>'.repeat(21) + '<DT><A HREF="https://example.test/deep">Too deep</A>' + '</DL>'.repeat(21);
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><A HREF="https://example.test/outside">Outside</A><DL>'
    + '<DT><A HREF="file:///fixture">Local file</A><DT><A HREF="https://example.test/valid">Valid</A>'
    + '<template><DT><A HREF="https://example.test/inert">Inert</A></template>' + deep + '</DL>';
  const parsed = await parseBookmarkHtml(html, destination);
  expect(parsed.bookmarks.map(({ title }) => title)).toEqual(['Valid']);
  expect(parsed.skipped).toBe(2);
  await expect(parseBookmarkHtml('<!doctype html><DL><DT><A HREF="https://example.test/">Other page</A></DL>', destination))
    .rejects.toThrow(/standard browser bookmark HTML/);
});
