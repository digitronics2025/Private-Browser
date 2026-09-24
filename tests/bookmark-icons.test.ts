import { describe, expect, it } from 'vitest';
import { validateAccountState } from '../electron/account-space-state';
import { MAX_BOOKMARK_ICONS, bookmarkIconHost, pruneBookmarkIcons, rememberBookmarkIcon, sanitizeBookmarkIcons } from '../electron/bookmark-icons';
import type { AccountBrowsingStateV2, AccountSpaceId, Bookmark } from '../electron/types';
import { domainFromUrl } from '../src/lib/format';

const ACCOUNT = '11111111-1111-4111-8111-111111111111' as AccountSpaceId;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const OTHER_PNG = 'data:image/png;base64,AAAA';

const bookmark = (url: string): Bookmark => ({
  id: url, title: url, url, workspaceId: 'personal', accountSpaceId: ACCOUNT,
  createdAt: '2026-09-24T00:00:00Z', location: 'bar', folderPath: [], order: 0, orderPath: [0],
});

describe('remembered bookmark icons', () => {
  it('keys hosts exactly as the renderer looks them up', () => {
    for (const url of ['https://www.tiktok.com/ads', 'https://business.facebook.com/x?y=1', 'http://localhost:5173/', 'https://[::1]:8443/']) {
      expect(bookmarkIconHost(url)).toBe(domainFromUrl(url));
    }
    expect(bookmarkIconHost('private://home')).toBeUndefined();
    expect(bookmarkIconHost('not a url')).toBeUndefined();
  });

  it('remembers an icon only for a host bookmarked in the same Account Space', () => {
    const bookmarks = [bookmark('https://www.tiktok.com/ads')];
    expect(rememberBookmarkIcon(undefined, bookmarks, 'https://tiktok.com/other-page', PNG)).toEqual({ 'tiktok.com': PNG });
    expect(rememberBookmarkIcon(undefined, bookmarks, 'https://example.com/', PNG)).toBeUndefined();
  });

  it('skips a save when nothing changed, and replaces a changed icon', () => {
    const bookmarks = [bookmark('https://gemini.google.com/')];
    expect(rememberBookmarkIcon({ 'gemini.google.com': PNG }, bookmarks, 'https://gemini.google.com/app', PNG)).toBeUndefined();
    expect(rememberBookmarkIcon({ 'gemini.google.com': PNG }, bookmarks, 'https://gemini.google.com/app', OTHER_PNG)).toEqual({ 'gemini.google.com': OTHER_PNG });
  });

  it('refuses anything that is not an inert image data URL', () => {
    const bookmarks = [bookmark('https://example.com/')];
    for (const value of ['https://example.com/favicon.ico', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png,<svg>', `data:image/png;base64,${'A'.repeat(64 * 1024)}`]) {
      expect(rememberBookmarkIcon(undefined, bookmarks, 'https://example.com/', value)).toBeUndefined();
    }
  });

  it('stops growing at the per-space cap', () => {
    const full = Object.fromEntries(Array.from({ length: MAX_BOOKMARK_ICONS }, (_, index) => [`site${index}.example`, PNG]));
    expect(rememberBookmarkIcon(full, [bookmark('https://new.example/')], 'https://new.example/', PNG)).toBeUndefined();
  });

  it('sanitizes stored maps and prunes hosts without a bookmark', () => {
    expect(sanitizeBookmarkIcons({ 'ok.example': PNG, 'BAD HOST': PNG, 'bad.example': 'javascript:alert(1)' })).toEqual({ 'ok.example': PNG });
    expect(sanitizeBookmarkIcons(['x'])).toBeUndefined();
    expect(pruneBookmarkIcons({ 'kept.example': PNG, 'gone.example': PNG }, [bookmark('https://kept.example/a')])).toEqual({ 'kept.example': PNG });
    expect(pruneBookmarkIcons({ 'gone.example': PNG }, [])).toBeUndefined();
  });

  it('survives a save and load of the Account Space state, minus orphaned hosts', () => {
    const state: AccountBrowsingStateV2 = {
      version: 2, accountSpaceId: ACCOUNT, workspaceId: 'personal',
      tabs: [{ id: 'tab', workspaceId: 'personal', accountSpaceId: ACCOUNT, title: 'New tab', url: 'private://home', isHome: true }],
      activeTabId: 'tab',
      bookmarks: [bookmark('https://www.tiktok.com/ads')],
      history: [],
      bookmarkIcons: { 'tiktok.com': PNG, 'orphan.example': PNG },
    };
    expect(validateAccountState(state).bookmarkIcons).toEqual({ 'tiktok.com': PNG });
    expect(validateAccountState({ ...state, bookmarkIcons: undefined })).not.toHaveProperty('bookmarkIcons');
  });
});
