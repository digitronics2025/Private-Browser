import { bookmarkOrder } from './bookmark-tree.js';
import { MAX_ROUTINE_ITEMS } from './browser-routines.js';
import { isAllowedRemoteUrl, isProtectedPage } from './security.js';
import type { AccountSpaceId, Bookmark, BrowserTab, TabSetInput } from './types.js';

export function canSaveTabInSet(tab: BrowserTab, account: AccountSpaceId): boolean {
  return tab.accountSpaceId === account && tab.workspaceId !== 'banking' && !tab.isHome
    && tab.url.length <= 4096 && isAllowedRemoteUrl(tab.url) && !isProtectedPage(tab.url);
}

export function resolveTabSet(tabs: BrowserTab[], input: TabSetInput): BrowserTab[] {
  const eligible = new Map(tabs.filter((tab) => canSaveTabInSet(tab, input.accountSpaceId)).map((tab) => [tab.id, tab]));
  if (!input.tabs.length || input.tabs.length > MAX_ROUTINE_ITEMS || new Set(input.tabs.map(({ id }) => id)).size !== input.tabs.length) {
    throw new Error('Choose between 1 and 20 different tabs.');
  }
  return input.tabs.map(({ id, url }) => {
    const tab = eligible.get(id);
    if (!tab || tab.url !== url) throw new Error('The selected tabs changed. Open a new preview.');
    return tab;
  });
}

export function appendTabSetBookmarks(bookmarks: Bookmark[], tabs: BrowserTab[], input: TabSetInput): Bookmark[] {
  const name = input.name.trim();
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('Enter a bookmark folder name.');
  const bar = bookmarks.filter((item) => item.accountSpaceId === input.accountSpaceId && item.location === 'bar');
  const folder = bar.filter((item) => item.folderPath[0] === name);
  const known = new Set(folder.filter((item) => item.folderPath.length === 1).map((item) => item.url));
  const rootOrder = folder.length ? folder.reduce((lowest, item) => Math.min(lowest, bookmarkOrder(item, 0)), Infinity)
    : bar.reduce((highest, item) => Math.max(highest, bookmarkOrder(item, 0)), -1) + 1;
  let order = folder.reduce((highest, item) => Math.max(highest, bookmarkOrder(item, 1)), -1) + 1;
  const added: Bookmark[] = [];
  const createdAt = new Date().toISOString();
  for (const tab of tabs) {
    if (known.has(tab.url)) continue;
    known.add(tab.url);
    added.push({
      id: crypto.randomUUID(), accountSpaceId: tab.accountSpaceId, workspaceId: tab.workspaceId,
      url: tab.url, title: tab.title.trim().slice(0, 500) || tab.url, createdAt,
      location: 'bar', folderPath: [name], order: rootOrder, orderPath: [rootOrder, order++],
    });
  }
  const accountCount = bookmarks.reduce((count, item) => count + Number(item.accountSpaceId === input.accountSpaceId), 0);
  if (accountCount + added.length > 25_000) throw new Error('This Account Space cannot hold more than 25,000 bookmarks.');
  return added;
}
