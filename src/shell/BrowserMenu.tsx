import { Asterisk, NotebookPen, Code2, Download, FileDown, History, Info, Keyboard, KeyRound, Link2, LogOut, Maximize2, Minus, Palette, Plus, Printer, RotateCcw, ScrollText, Search, Settings, Shield, Sparkles, SquarePlus, Star, Trash2, Upload, UsersRound, Wrench, Zap } from 'lucide-react';
import type { AccountSpaceId, BookmarkBarMode, BrowserSnapshot, BrowserTab, SidePanelTool, ThemePreference, UiPreferences } from '../../electron/types';
import { AccountAvatar } from '../lib/accounts';
import { MenuItem, MenuSeparator, MenuSurface, SubmenuItem } from './Menu';
import { SIDE_PANEL_NAMES } from './side-panel-tools';

export interface BrowserMenuActions {
  newTab: () => void;
  reopenClosedTab: () => void;
  reopenRecentTab: (id: string) => void;
  undoTabBatch: () => void;
  switchAccount: (id: AccountSpaceId) => void;
  manageAccounts: () => void;
  openTool: (tool: SidePanelTool) => void;
  toggleBookmark: () => void;
  pinCurrentPage?: () => void;
  setUi: (patch: Partial<UiPreferences>) => void;
  exportBookmarks: () => void;
  clearBrowsingData: () => void;
  zoom: (direction: 'in' | 'out' | 'reset') => void;
  toggleFullscreen: () => void;
  print: () => void;
  find: () => void;
  copyLink: () => void;
  reviewClaudeExcerpt?: () => void;
  toggleDeveloperTools: () => void;
  toggleTrackers: () => void;
  quit: () => void;
}

const BAR_MODES: Array<{ id: BookmarkBarMode; label: string }> = [
  { id: 'always', label: 'Always show' },
  { id: 'new-tab', label: 'Only on New Tab' },
  { id: 'hidden', label: 'Never show' },
];

const THEMES: Array<{ id: ThemePreference; label: string }> = [
  { id: 'system', label: 'Match Windows' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

const closedTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function BrowserMenu({ anchor, state, tab, ui, bookmarked, onClose, actions }: {
  anchor: HTMLElement | null;
  state: BrowserSnapshot;
  tab: BrowserTab;
  ui: UiPreferences;
  bookmarked: boolean;
  onClose: () => void;
  actions: BrowserMenuActions;
}) {
  const accounts = state.accountSpaces.filter((account) => account.workspaceId === state.activeWorkspaceId).sort((a, b) => a.order - b.order);
  const zoom = tab.zoomPercent ?? 100;
  const vaultAvailable = state.activeWorkspaceId !== 'development';
  const recentlyClosed = state.recentlyClosedTabs ?? [];
  return (
    <MenuSurface anchor={anchor} placement="bottom-end" label="Browser menu" className="browser-menu" onClose={onClose}>
      <MenuItem icon={SquarePlus} label="New tab" shortcut="Ctrl+T" onSelect={actions.newTab} />
      <MenuItem icon={RotateCcw} label="Reopen closed tab" shortcut="Ctrl+Shift+T" disabled={!state.canReopenClosedTab} onSelect={actions.reopenClosedTab} />
      {state.closedTabBatch && <MenuItem icon={RotateCcw} label={state.closedTabBatch.groupName ? 'Reopen group ' + state.closedTabBatch.groupName : 'Undo tab close'}
        hint={state.closedTabBatch.count + (state.closedTabBatch.count === 1 ? ' tab' : ' tabs')} onSelect={actions.undoTabBatch} />}
      {recentlyClosed.length > 0 && <SubmenuItem id="recently-closed" icon={History} label="Recently closed">
        {recentlyClosed.map((entry) => (
          <MenuItem key={entry.id} label={entry.title || entry.url}
            hint={closedTime.format(new Date(entry.closedAt)) + ' · Reopen in background'}
            onSelect={() => actions.reopenRecentTab(entry.id)} />
        ))}
      </SubmenuItem>}
      <MenuSeparator />
      <SubmenuItem id="account-spaces" icon={UsersRound} label="Account Spaces">
        {accounts.map((account) => (
          <MenuItem key={account.id} role="menuitemradio" checked={account.id === state.activeAccountSpaceId} disabled={account.locked} className="account-item" leading={<AccountAvatar account={account} />} label={account.label} hint={account.email ?? 'Local browsing only'} onSelect={() => actions.switchAccount(account.id)} />
        ))}
        <MenuSeparator />
        <MenuItem icon={Settings} label="Manage Account Spaces" onSelect={actions.manageAccounts} />
      </SubmenuItem>
      {vaultAvailable && <MenuItem icon={KeyRound} label={SIDE_PANEL_NAMES.vault} onSelect={() => actions.openTool('vault')} />}
      <MenuItem icon={History} label="History" shortcut="Ctrl+H" onSelect={() => actions.openTool('history')} />
      <MenuItem icon={Download} label={SIDE_PANEL_NAMES.downloads} shortcut="Ctrl+J" onSelect={() => actions.openTool('downloads')} />
      <SubmenuItem id="bookmarks" icon={Star} label="Bookmarks">
        <MenuItem icon={Star} label={bookmarked ? 'Remove bookmark' : 'Bookmark this tab'} shortcut="Ctrl+D" disabled={tab.isHome} onSelect={actions.toggleBookmark} />
        {actions.pinCurrentPage && <MenuItem label="Pin current page to New Tab" onSelect={actions.pinCurrentPage} />}
        <SubmenuItem id="bookmark-bar-mode" label="Bookmarks bar">
          {BAR_MODES.map((mode) => <MenuItem key={mode.id} role="menuitemradio" checked={ui.bookmarkBarMode === mode.id} label={mode.label} onSelect={() => actions.setUi({ bookmarkBarMode: mode.id })} />)}
        </SubmenuItem>
        <MenuItem label="Bookmark manager" shortcut="Ctrl+Shift+O" onSelect={() => actions.openTool('bookmarks')} />
        <MenuSeparator />
        <MenuItem icon={Upload} label="Import bookmarks and history" onSelect={() => actions.openTool('settings')} />
        <MenuItem icon={FileDown} label="Export bookmarks" onSelect={actions.exportBookmarks} />
      </SubmenuItem>
      <MenuItem icon={Trash2} label="Delete browsing data…" shortcut="Ctrl+Shift+Del" onSelect={actions.clearBrowsingData} />
      <MenuSeparator />
      <div className="menu-zoom-row" role="group" aria-label="Zoom">
        <span className="menu-item-icon" aria-hidden="true" />
        <span className="menu-zoom-label">Zoom</span>
        <button type="button" role="menuitem" aria-label="Zoom out" title="Zoom out (Ctrl+-)" disabled={tab.isHome} onClick={() => actions.zoom('out')}><Minus size={15} /></button>
        <output aria-live="polite">{zoom}%</output>
        <button type="button" role="menuitem" aria-label="Zoom in" title="Zoom in (Ctrl++)" disabled={tab.isHome} onClick={() => actions.zoom('in')}><Plus size={15} /></button>
        <button type="button" role="menuitem" aria-label="Full screen" title="Full screen (F11)" onClick={() => { actions.toggleFullscreen(); onClose(); }}><Maximize2 size={15} /></button>
      </div>
      <MenuSeparator />
      <MenuItem icon={Printer} label="Print…" shortcut="Ctrl+P" disabled={tab.isHome} onSelect={actions.print} />
      <MenuItem icon={Search} label="Find…" shortcut="Ctrl+F" disabled={tab.isHome} onSelect={actions.find} />
      <MenuItem icon={Link2} label="Copy link" disabled={tab.isHome} onSelect={actions.copyLink} />
      <SubmenuItem id="more-tools" icon={Wrench} label="More tools">
        <MenuItem icon={Code2} label="Developer tools" shortcut="F12" disabled={!tab.developerToolsAllowed} onSelect={actions.toggleDeveloperTools} />
        <MenuItem icon={Code2} label={SIDE_PANEL_NAMES.developer} onSelect={() => actions.openTool('developer')} />
        <MenuItem icon={Zap} label={SIDE_PANEL_NAMES.automations} onSelect={() => actions.openTool('automations')} />
        <MenuItem icon={ScrollText} label={SIDE_PANEL_NAMES.privacy} onSelect={() => actions.openTool('privacy')} />
        <MenuSeparator />
        <MenuItem role="menuitemcheckbox" checked={state.trackerBlocking} icon={Shield} label="Block trackers" keepOpen onSelect={actions.toggleTrackers} />
      </SubmenuItem>
      <MenuSeparator />
      <MenuItem icon={NotebookPen} label={SIDE_PANEL_NAMES.easynote} shortcut="Ctrl+Shift+Y" onSelect={() => actions.openTool('easynote')} />
      <MenuItem icon={Asterisk} label={SIDE_PANEL_NAMES.claude} onSelect={() => actions.openTool('claude')} />
      {actions.reviewClaudeExcerpt && <MenuItem icon={Asterisk} label="Copy approved excerpt for Claude…" onSelect={actions.reviewClaudeExcerpt} />}
      <MenuItem icon={Sparkles} label={SIDE_PANEL_NAMES.assistant} onSelect={() => actions.openTool('assistant')} />
      <SubmenuItem id="appearance" icon={Palette} label="Appearance">
        {THEMES.map((theme) => <MenuItem key={theme.id} role="menuitemradio" checked={ui.theme === theme.id} label={theme.label} onSelect={() => actions.setUi({ theme: theme.id })} />)}
      </SubmenuItem>
      <MenuItem icon={Settings} label="Settings" onSelect={() => actions.openTool('settings')} />
      <MenuItem icon={Keyboard} label="Keyboard shortcuts" shortcut="Ctrl+Shift+K" onSelect={() => actions.openTool('shortcuts')} />
      <MenuItem icon={Info} label="About Private Browser" onSelect={() => actions.openTool('settings')} />
      <MenuSeparator />
      <MenuItem icon={LogOut} label="Exit" onSelect={actions.quit} />
    </MenuSurface>
  );
}
