import { describe, expect, it } from 'vitest';
import { parseChromeBookmarks, parseChromePasswordCsv } from '../electron/chrome-importer';
import type { AccountSpaceId } from '../electron/types';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001' as AccountSpaceId;

describe('Chrome data importer', () => {
  it('preserves bookmark-bar placement, nested folders and Chrome order', () => {
    const input = JSON.stringify({
      roots: {
        bookmark_bar: {
          type: 'folder',
          name: 'Bookmarks bar',
          children: [
            { type: 'url', name: 'First', url: 'https://first.example/', date_added: '13300000000000000' },
            { type: 'folder', name: 'Work', children: [
              { type: 'url', name: 'Orders', url: 'https://orders.example/' },
              { type: 'folder', name: 'Stores', children: [{ type: 'url', name: 'Shop', url: 'https://shop.example/' }] },
            ] },
          ],
        },
        other: { type: 'folder', name: 'Other bookmarks', children: [{ type: 'url', name: 'Later', url: 'https://later.example/' }] },
      },
    });

    const result = parseChromeBookmarks(input, 'personal', ACCOUNT_ID);
    expect(result.skipped).toBe(0);
    expect(result.bookmarks).toHaveLength(4);
    expect(result.bookmarks[0]).toEqual(expect.objectContaining({ title: 'First', location: 'bar', folderPath: [], orderPath: [0] }));
    expect(result.bookmarks[1]).toEqual(expect.objectContaining({ title: 'Orders', location: 'bar', folderPath: ['Work'], orderPath: [1, 0] }));
    expect(result.bookmarks[2]).toEqual(expect.objectContaining({ title: 'Shop', folderPath: ['Work', 'Stores'], orderPath: [1, 1, 0] }));
    expect(result.bookmarks[3]).toEqual(expect.objectContaining({ title: 'Later', location: 'other' }));
    expect(result.bookmarks.every((item) => item.accountSpaceId === ACCOUNT_ID)).toBe(true);
  });

  it('drops Chrome internal and unsafe bookmark URLs', () => {
    const input = JSON.stringify({ roots: { bookmark_bar: { children: [
      { type: 'url', name: 'Chrome', url: 'chrome://settings' },
      { type: 'url', name: 'Script', url: 'javascript:alert(1)' },
      { type: 'url', name: 'Good', url: 'https://example.com' },
    ] } } });
    const result = parseChromeBookmarks(input, 'personal', ACCOUNT_ID);
    expect(result.bookmarks.map((item) => item.title)).toEqual(['Good']);
    expect(result.skipped).toBe(2);
  });

  it('parses quoted Chrome password CSV without exposing unsupported rows', () => {
    const result = parseChromePasswordCsv('name,url,username,password,note\n"Shop, Main",https://shop.example/login,user@example.com,"p,a""ss",memo\nBad,chrome://settings,user,secret,\n');
    expect(result.items).toEqual([{ label: 'Shop, Main', url: 'https://shop.example/login', username: 'user@example.com', password: 'p,a"ss' }]);
    expect(result.skipped).toBe(1);
  });
});
