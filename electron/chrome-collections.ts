import type { AccountSpaceId, Bookmark, BrowserTab, HistoryEntry, PrivacyEvent, ShortcutTile, WorkspaceId } from './types.js';

export function chromeCollections<Tab extends BrowserTab, Saved extends Bookmark, Visit extends HistoryEntry>(state: {
  tabs: Tab[];
  bookmarks: Saved[];
  history: Visit[];
  privacyLog: PrivacyEvent[];
  shortcutsByAccountSpace: Record<string, ShortcutTile[]>;
}, accountSpaceId: AccountSpaceId, workspaceId: WorkspaceId) {
  const owns = (item: { accountSpaceId?: AccountSpaceId }) => item.accountSpaceId === accountSpaceId;
  const shortcuts = state.shortcutsByAccountSpace[accountSpaceId];
  return {
    tabs: state.tabs.filter(owns),
    bookmarks: state.bookmarks.filter(owns),
    history: workspaceId === 'banking' ? [] : state.history.filter(owns).slice(0, 100),
    privacyLog: state.privacyLog.filter((event) => !event.accountSpaceId || owns(event)).slice(0, 50),
    shortcutsByAccountSpace: shortcuts ? { [accountSpaceId]: shortcuts } : {},
  };
}
