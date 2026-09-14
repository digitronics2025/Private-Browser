import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Check, KeyRound, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import type { AccountSpaceId, Bookmark, BookmarkLevelInput, BrowserSnapshot, Shortcut, ShortcutTile, SidePanelTool, UiPreferences, UiPreferencesPatch, WindowState } from '../electron/types';
import { CHROME, computeChromeLayout, FRAME_COLORS } from '../electron/chrome-layout';
import { resolveShortcut } from '../electron/shortcuts';
import { DEFAULT_UI_PREFERENCES } from '../electron/ui-preferences';
import { OverlayContext } from './shell/overlay';
import { WindowTabStrip } from './shell/TabStrip';
import { NavigationToolbar } from './shell/NavigationToolbar';
import { BookmarkBar, type BookmarkActions } from './shell/BookmarkBar';
import { FindBar } from './shell/FindBar';
import { SidePanel } from './shell/SidePanel';
import { NewTabPage } from './shell/NewTabPage';
import { ProfileMenu } from './shell/ProfileMenu';
import { BrowserMenu } from './shell/BrowserMenu';
import { ShieldStatusMenu, SiteInfoMenu, TabSearchMenu } from './shell/StatusMenus';
import { PromptDialog, type PromptRequest } from './shell/PromptDialog';
import { AccountManager } from './panels/AccountManager';
import { PermissionOverlay, RecoveryOverlay } from './panels/Overlays';
import { AssistantPanel } from './panels/AssistantPanel';
import { DeveloperPanel } from './panels/DeveloperPanel';
import { VaultPanel } from './panels/VaultPanel';
import { AutomationPanel } from './panels/AutomationPanel';
import { DownloadsPanel } from './panels/DownloadsPanel';
import { PrivacyPanel } from './panels/PrivacyPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { BookmarksPanel } from './panels/BookmarksPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { EmptyState } from './panels/common';
import { defaultShortcutTiles } from './lib/quick-links';
import { faviconsByHost } from './lib/format';
import { disposer } from './lib/subscribe';

type MenuKind = 'browser' | 'profile' | 'shield' | 'tab-search' | 'site-info';

const DEFAULT_WINDOW_STATE: WindowState = { maximized: false, fullscreen: false, darkMode: true };

function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

/** Accept a typed address such as `example.com` as a shortcut destination. */
function shortcutUrl(value: string): string {
  const input = value.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
  const url = new URL(candidate);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Shortcuts must be web addresses');
  return url.toString();
}

export default function App() {
  const [state, setState] = useState<BrowserSnapshot | null>(null);
  const [address, setAddress] = useState('');
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const [accountManagerOpen, setAccountManagerOpen] = useState(false);
  const [vaultFullOpen, setVaultFullOpen] = useState(false);
  const [menu, setMenu] = useState<MenuKind | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [prompt, setPrompt] = useState<PromptRequest | null>(null);
  const [pendingUi, setPendingUi] = useState<UiPreferencesPatch>({});
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [overlayCount, setOverlayCount] = useState(0);
  const [overlayReady, setOverlayReady] = useState(true);
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null);
  // Refusals are the moments the app is protecting a secret; they must not
  // look identical to a success. Default 'ok', explicit 'error' on every catch.
  const showToast = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => setToast({ text, kind }), []);
  const addressRef = useRef<HTMLInputElement>(null);
  const shieldButtonRef = useRef<HTMLButtonElement>(null);
  const tabSearchButtonRef = useRef<HTMLButtonElement>(null);
  const siteInfoButtonRef = useRef<HTMLButtonElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const workspace = state?.workspaces.find((item) => item.id === state.activeWorkspaceId);
  const activeAccount = state?.accountSpaces.find((account) => account.id === state.activeAccountSpaceId);
  const workspaceTabs = useMemo(() => state?.tabs.filter((tab) => tab.accountSpaceId === state.activeAccountSpaceId) ?? [], [state?.tabs, state?.activeAccountSpaceId]);
  const accountBookmarks = useMemo(() => state?.bookmarks.filter((item) => item.accountSpaceId === state.activeAccountSpaceId) ?? [], [state?.bookmarks, state?.activeAccountSpaceId]);
  const favicons = useMemo(() => faviconsByHost(state?.tabs ?? []), [state?.tabs]);
  const ui: UiPreferences = { ...DEFAULT_UI_PREFERENCES, ...state?.ui, ...pendingUi };
  const windowState = state?.windowState ?? DEFAULT_WINDOW_STATE;

  const overlayOpen = overlayCount > 0 || accountManagerOpen || vaultFullOpen || Boolean(state?.pendingPermission) || Boolean(state?.recovery);

  useEffect(() => {
    void window.privateBrowser.getState().then(setState);
    return disposer(window.privateBrowser.onState(setState));
  }, []);

  useEffect(() => disposer(window.privateBrowser.onUpdateAvailable((result) => {
    showToast(`Private Browser ${result.latest.version} is ready to download`);
  })), []);

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Optimistic preferences stay only until the main process confirms them.
  useEffect(() => {
    if (!state?.ui) return;
    setPendingUi((current) => {
      const entries = Object.entries(current).filter(([key, value]) => state.ui[key as keyof UiPreferences] !== value);
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [state?.ui]);

  useEffect(() => {
    if (activeTab) setAddress(activeTab.isHome ? '' : activeTab.url);
  }, [activeTab?.id, activeTab?.url, activeTab?.isHome]);

  useEffect(() => {
    setFindOpen(false);
    setFrozenFrame((current) => (current ? '' : current));
  }, [state?.activeTabId]);

  useEffect(() => {
    const dark = windowState.darkMode;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--frame', (dark ? FRAME_COLORS.dark : FRAME_COLORS.light).frame);
    document.documentElement.style.setProperty('--window', (dark ? FRAME_COLORS.dark : FRAME_COLORS.light).window);
  }, [windowState.darkMode]);

  const committedLayout = computeChromeLayout({
    bookmarkBarMode: ui.bookmarkBarMode,
    isHome: activeTab?.isHome ?? true,
    findBarOpen: findOpen,
    sidePanelOpen: ui.sidePanelOpen,
    sidePanelWidth: ui.sidePanelWidth,
    fullscreen: windowState.fullscreen,
    windowWidth,
  });
  const liveLayout = liveWidth === null ? committedLayout : computeChromeLayout({
    bookmarkBarMode: ui.bookmarkBarMode,
    isHome: activeTab?.isHome ?? true,
    findBarOpen: findOpen,
    sidePanelOpen: ui.sidePanelOpen,
    sidePanelWidth: liveWidth,
    fullscreen: windowState.fullscreen,
    windowWidth,
  });

  useEffect(() => {
    if (!state) return;
    void window.privateBrowser.setLayout(committedLayout.insets);
  }, [Boolean(state), committedLayout.insets.top, committedLayout.insets.right, committedLayout.insets.left, committedLayout.insets.bottom]);

  const acquireOverlay = useCallback(() => {
    setOverlayCount((count) => count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setOverlayCount((count) => Math.max(0, count - 1));
    };
  }, []);

  // Freeze the page, then hide the live view, so menus and dialogs can draw over
  // the content area. Protected pages come back as null and show a plain backdrop.
  useEffect(() => {
    let cancelled = false;
    if (overlayOpen) {
      setOverlayReady(false);
      void (async () => {
        const frame = await window.privateBrowser.freezeContent().catch(() => null);
        if (cancelled) return;
        setFrozenFrame(frame ?? '');
        await nextPaint();
        if (cancelled) return;
        await window.privateBrowser.setOverlayOpen(overlayOpen);
        if (!cancelled) setOverlayReady(true);
      })();
    } else {
      setOverlayReady(true);
      void window.privateBrowser.setOverlayOpen(overlayOpen).finally(() => { if (!cancelled) setFrozenFrame(null); });
    }
    return () => { cancelled = true; };
  }, [overlayOpen]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const act = async (action: () => Promise<unknown> | unknown, success?: string) => {
    try {
      await action();
      if (success) showToast(success);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const setUi = (patch: UiPreferencesPatch) => {
    setPendingUi((current) => ({ ...current, ...patch }));
    void act(() => window.privateBrowser.setUiPreferences(patch));
  };
  const openTool = (tool: SidePanelTool) => setUi({ sidePanelOpen: true, sidePanelTool: tool });
  const toggleTool = (tool: SidePanelTool) => (ui.sidePanelOpen && ui.sidePanelTool === tool ? setUi({ sidePanelOpen: false }) : openTool(tool));

  const clearBrowsingData = () => {
    if (!activeAccount) return;
    if (!window.confirm(`Delete browsing data for “${activeAccount.label}”?\n\nWebsite data, sign-ins and history in this Account Space are removed. Bookmarks, MyVault logins and other Account Spaces are not affected.`)) return;
    void act(() => window.privateBrowser.clearAccountSpaceData(activeAccount.id), 'Browsing data deleted');
  };

  const cycleAccountSpace = (direction: 1 | -1) => {
    if (!state) return;
    const accounts = state.accountSpaces.filter((account) => account.workspaceId === state.activeWorkspaceId && !account.locked).sort((a, b) => a.order - b.order);
    const index = accounts.findIndex((account) => account.id === state.activeAccountSpaceId);
    const target = accounts[(index + direction + accounts.length) % accounts.length];
    if (target && target.id !== state.activeAccountSpaceId) void act(() => window.privateBrowser.switchAccountSpace(target.id));
  };

  const selectTabAt = (index: number) => {
    const target = workspaceTabs[Math.max(0, Math.min(workspaceTabs.length - 1, index))];
    if (target) void act(() => window.privateBrowser.activateTab(target.id));
  };

  const runCommand = (shortcut: Shortcut) => {
    if (!state || !activeTab) return;
    const tabIndex = workspaceTabs.findIndex((tab) => tab.id === activeTab.id);
    switch (shortcut.command) {
      case 'developer-tools': void act(() => window.privateBrowser.toggleDeveloperTools('right')); break;
      case 'focus-address': addressRef.current?.focus(); addressRef.current?.select(); break;
      case 'new-tab': void act(() => window.privateBrowser.newTab()); break;
      case 'close-tab': void act(() => window.privateBrowser.closeTab(activeTab.id)); break;
      case 'reopen-closed-tab': void act(() => window.privateBrowser.reopenClosedTab()); break;
      case 'reload': if (!activeTab.isHome) void act(() => window.privateBrowser.reload()); break;
      case 'hard-reload': if (!activeTab.isHome) void act(() => window.privateBrowser.hardReload()); break;
      case 'back': void act(() => window.privateBrowser.back()); break;
      case 'forward': void act(() => window.privateBrowser.forward()); break;
      case 'home': void act(() => window.privateBrowser.navigate('private://home')); break;
      case 'next-tab': selectTabAt((tabIndex + 1) % workspaceTabs.length); break;
      case 'previous-tab': selectTabAt((tabIndex - 1 + workspaceTabs.length) % workspaceTabs.length); break;
      case 'select-tab': selectTabAt(shortcut.index ?? 0); break;
      case 'last-tab': selectTabAt(workspaceTabs.length - 1); break;
      case 'toggle-bookmark-bar': void act(() => window.privateBrowser.toggleBookmarkBar()); break;
      case 'bookmark-page': if (!activeTab.isHome) void act(() => window.privateBrowser.toggleBookmark()); break;
      case 'bookmark-manager': openTool('bookmarks'); break;
      case 'history': openTool('history'); break;
      case 'downloads': openTool('downloads'); break;
      case 'find': if (!activeTab.isHome) { setFindOpen(true); setFindFocus((value) => value + 1); } break;
      case 'print': void act(() => window.privateBrowser.print()); break;
      case 'zoom-in': void act(() => window.privateBrowser.zoom('in')); break;
      case 'zoom-out': void act(() => window.privateBrowser.zoom('out')); break;
      case 'zoom-reset': void act(() => window.privateBrowser.zoom('reset')); break;
      case 'fullscreen': void act(() => window.privateBrowser.toggleFullscreen()); break;
      case 'browser-menu': setMenu('browser'); break;
      case 'tab-search': setMenu('tab-search'); break;
      case 'clear-browsing-data': clearBrowsingData(); break;
      case 'next-account-space': cycleAccountSpace(1); break;
      case 'previous-account-space': cycleAccountSpace(-1); break;
      default:
    }
  };
  const commandRef = useRef(runCommand);
  commandRef.current = runCommand;

  // Page focus reaches this dispatcher through the main process; chrome focus
  // reaches it directly. Both resolve keys through the same table.
  useEffect(() => disposer(window.privateBrowser.onCommand((shortcut) => commandRef.current(shortcut))), []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key === 'Escape' && windowStateRef.current.fullscreen) {
        void window.privateBrowser.toggleFullscreen();
        return;
      }
      const shortcut = resolveShortcut({ key: event.key, control: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey, alt: event.altKey });
      if (!shortcut) return;
      const editing = event.target instanceof HTMLElement && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA');
      // Ctrl+Shift+arrows select words while typing; only claim them outside text fields.
      if (editing && (shortcut.command === 'next-account-space' || shortcut.command === 'previous-account-space')) return;
      event.preventDefault();
      commandRef.current(shortcut);
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const windowStateRef = useRef(windowState);
  windowStateRef.current = windowState;

  const overlayValue = useMemo(() => ({ acquire: acquireOverlay, ready: overlayReady }), [acquireOverlay, overlayReady]);

  if (!state || !activeTab || !workspace || !activeAccount) {
    return <div className="boot"><ShieldCheck size={34} /><LoaderCircle className="spin" size={22} /> Opening your private workspace</div>;
  }

  const bookmarked = state.bookmarks.some((item) => item.url === activeTab.url && item.accountSpaceId === activeTab.accountSpaceId);
  const customShortcuts = state.shortcutsByAccountSpace?.[activeAccount.id];
  const shortcutTiles = customShortcuts ?? defaultShortcutTiles(state.activeWorkspaceId);
  const recentHistory = state.history.filter((item) => item.accountSpaceId === state.activeAccountSpaceId);
  const fullscreen = windowState.fullscreen;
  const vaultAvailable = state.activeWorkspaceId !== 'development';

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    void act(() => window.privateBrowser.navigate(address));
    addressRef.current?.blur();
  };

  const saveShortcuts = (tiles: ShortcutTile[] | null) => window.privateBrowser.setShortcutTiles(activeAccount.id, tiles);
  const editShortcut = (tile?: ShortcutTile) => setPrompt({
    title: tile ? 'Edit shortcut' : 'Add shortcut',
    confirmLabel: tile ? 'Save' : 'Add',
    fields: [
      { name: 'title', label: 'Name', value: tile?.title ?? '', maxLength: 100 },
      { name: 'url', label: 'URL', value: tile?.url ?? '', type: 'url', maxLength: 4096, placeholder: 'https://example.com' },
    ],
    submit: async (values) => {
      const next = { id: tile?.id && !tile.id.startsWith('default-') ? tile.id : crypto.randomUUID(), title: values.title.trim(), url: shortcutUrl(values.url) };
      const tiles = tile ? shortcutTiles.map((item) => (item.id === tile.id ? next : item)) : [...shortcutTiles, next];
      await saveShortcuts(tiles.map((item) => (item.id.startsWith('default-') ? { ...item, id: crypto.randomUUID() } : item)));
    },
  });

  const bookmarkActions: BookmarkActions = {
    open: (id) => void act(() => window.privateBrowser.openBookmark(id)),
    openAll: (items: Bookmark[]) => {
      if (items.length > 8 && !window.confirm(`Open all ${items.length} bookmarks in new tabs?`)) return;
      void act(async () => { for (const item of items.slice(0, 50)) await window.privateBrowser.openBookmark(item.id); });
    },
    copyLink: (url) => void act(() => window.privateBrowser.copyText(url), 'Link copied'),
    rename: (item) => setPrompt({ title: 'Edit bookmark name', confirmLabel: 'Save', fields: [{ name: 'title', label: 'Name', value: item.title, maxLength: 500 }], submit: (values) => window.privateBrowser.renameBookmark(item.id, values.title) }),
    remove: (item) => void act(() => window.privateBrowser.removeBookmark(item.id), 'Bookmark deleted'),
    renameFolder: (level: BookmarkLevelInput, name) => setPrompt({ title: 'Rename folder', confirmLabel: 'Save', fields: [{ name: 'name', label: 'Folder name', value: name, maxLength: 200 }], submit: (values) => window.privateBrowser.renameBookmarkFolder(level, name, values.name) }),
    removeFolder: (level, name, count) => {
      if (!window.confirm(`Delete the folder “${name}” and the ${count} bookmark${count === 1 ? '' : 's'} inside it?`)) return;
      void act(() => window.privateBrowser.removeBookmarkFolder(level, name), 'Folder deleted');
    },
    move: (level, key, toIndex) => void act(() => window.privateBrowser.moveBookmark(level, key, toIndex)),
    setMode: (mode) => setUi({ bookmarkBarMode: mode }),
    openManager: () => openTool('bookmarks'),
    importBookmarks: () => openTool('settings'),
    exportBookmarks: () => void act(async () => { if (await window.privateBrowser.exportBookmarks()) showToast('Bookmarks exported'); }),
  };

  const shellStyle = {
    '--tab-strip-h': `${fullscreen ? 0 : CHROME.tabStrip}px`,
    '--toolbar-h': `${fullscreen ? 0 : CHROME.toolbar}px`,
    '--bookmark-bar-h': `${liveLayout.bookmarkBar}px`,
    '--find-bar-h': `${liveLayout.findBar}px`,
    '--chrome-top': `${liveLayout.insets.top}px`,
    '--side-panel-w': `${liveLayout.sidePanel}px`,
  } as CSSProperties;

  const sidePanelContent = (() => {
    switch (ui.sidePanelTool) {
      case 'assistant': return <AssistantPanel onToast={showToast} />;
      case 'developer': return <DeveloperPanel activeTab={activeTab} onToast={showToast} />;
      case 'vault': return state.activeWorkspaceId === 'development'
        ? <EmptyState icon={KeyRound} text="MyVault is isolated from the Development workspace." />
        : <VaultPanel workspaceId={state.activeWorkspaceId} activeOrigin={activeTab.isHome ? undefined : activeTab.url} onOpenFull={() => setVaultFullOpen(true)} onToast={showToast} />;
      case 'automations': return <AutomationPanel onToast={showToast} />;
      case 'downloads': return <DownloadsPanel state={state} onToast={showToast} />;
      case 'privacy': return <PrivacyPanel state={state} />;
      case 'settings': return <SettingsPanel state={state} ui={ui} onUiChange={setUi} onToast={showToast} />;
      case 'bookmarks': return <BookmarksPanel bookmarks={accountBookmarks} favicons={favicons} onOpen={bookmarkActions.open} onRename={bookmarkActions.rename} onRemove={bookmarkActions.remove} onImport={bookmarkActions.importBookmarks} onExport={bookmarkActions.exportBookmarks} />;
      case 'history': return <HistoryPanel history={recentHistory} protectedWorkspace={workspace.protected} onOpen={(url) => void act(() => window.privateBrowser.navigate(url))} onClearData={clearBrowsingData} />;
      default: return null;
    }
  })();

  const closeMenu = () => setMenu(null);

  return (
    <OverlayContext.Provider value={overlayValue}>
      <div className={`app-shell ${fullscreen ? 'is-fullscreen' : ''} ${windowState.maximized ? 'is-maximized' : ''} ${liveLayout.bookmarkBar ? 'bookmark-bar-on' : ''}`} style={shellStyle}>
        {!fullscreen && (
          <>
            <WindowTabStrip
              tabs={workspaceTabs}
              activeTabId={activeTab.id}
              shieldButtonRef={shieldButtonRef}
              tabSearchButtonRef={tabSearchButtonRef}
              shieldOpen={menu === 'shield'}
              tabSearchOpen={menu === 'tab-search'}
              onShield={() => setMenu((current) => (current === 'shield' ? null : 'shield'))}
              onTabSearch={() => setMenu((current) => (current === 'tab-search' ? null : 'tab-search'))}
              onActivate={(id) => void act(() => window.privateBrowser.activateTab(id))}
              onClose={(id) => void act(() => window.privateBrowser.closeTab(id))}
              onNewTab={() => void act(() => window.privateBrowser.newTab())}
              onMove={(id, index) => void act(() => window.privateBrowser.moveTab(id, index))}
              onMute={(id, muted) => void act(() => window.privateBrowser.setTabMuted(id, muted))}
            />
            <NavigationToolbar
              tab={activeTab}
              account={activeAccount}
              address={address}
              addressRef={addressRef}
              bookmarked={bookmarked}
              vaultAvailable={vaultAvailable}
              sidePanelOpen={ui.sidePanelOpen}
              assistantOpen={ui.sidePanelOpen && ui.sidePanelTool === 'assistant'}
              siteInfoButtonRef={siteInfoButtonRef}
              profileButtonRef={profileButtonRef}
              menuButtonRef={menuButtonRef}
              siteInfoOpen={menu === 'site-info'}
              profileOpen={menu === 'profile'}
              menuOpen={menu === 'browser'}
              onAddressChange={setAddress}
              onSubmit={submitAddress}
              onBack={() => void act(() => window.privateBrowser.back())}
              onForward={() => void act(() => window.privateBrowser.forward())}
              onReloadOrStop={() => void act(() => (activeTab.loading ? window.privateBrowser.stop() : window.privateBrowser.reload()))}
              onHome={() => void act(() => window.privateBrowser.navigate('private://home'))}
              onSiteInfo={() => setMenu((current) => (current === 'site-info' ? null : 'site-info'))}
              onToggleBookmark={() => void act(() => window.privateBrowser.toggleBookmark())}
              onOpenVault={() => toggleTool('vault')}
              onResetZoom={() => void act(() => window.privateBrowser.zoom('reset'))}
              onToggleSidePanel={() => setUi({ sidePanelOpen: !ui.sidePanelOpen })}
              onAssistant={() => toggleTool('assistant')}
              onProfile={() => setMenu((current) => (current === 'profile' ? null : 'profile'))}
              onMenu={() => setMenu((current) => (current === 'browser' ? null : 'browser'))}
            />
            {liveLayout.bookmarkBar > 0 && <BookmarkBar bookmarks={accountBookmarks} mode={ui.bookmarkBarMode} favicons={favicons} actions={bookmarkActions} />}
            {findOpen && !activeTab.isHome && <FindBar tabId={activeTab.id} focusSignal={findFocus} onClose={() => setFindOpen(false)} />}
          </>
        )}

        {activeTab.isHome ? (
          <NewTabPage
            workspace={workspace}
            account={activeAccount}
            shortcuts={shortcutTiles}
            customized={Boolean(customShortcuts)}
            history={recentHistory}
            bookmarks={accountBookmarks}
            favicons={favicons}
            background={ui.newTabBackground}
            theme={ui.theme}
            onNavigate={(value) => void act(() => window.privateBrowser.navigate(value))}
            onOpenBookmark={bookmarkActions.open}
            onAddShortcut={() => editShortcut()}
            onEditShortcut={(tile) => editShortcut(tile)}
            onRemoveShortcut={(tile) => void act(() => saveShortcuts(shortcutTiles.filter((item) => item.id !== tile.id).map((item) => (item.id.startsWith('default-') ? { ...item, id: crypto.randomUUID() } : item))), 'Shortcut removed')}
            onResetShortcuts={() => void act(() => saveShortcuts(null), 'Default shortcuts restored')}
            onBackground={(background) => setUi({ newTabBackground: background })}
            onTheme={(theme) => setUi({ theme })}
          />
        ) : (
          <div className="page-surface" aria-hidden="true">
            {frozenFrame ? <img className="frozen-frame" src={frozenFrame} alt="" draggable={false} /> : null}
          </div>
        )}

        {ui.sidePanelOpen && !fullscreen && (
          <SidePanel
            tool={ui.sidePanelTool}
            width={liveLayout.sidePanel || ui.sidePanelWidth}
            activeDownloads={state.downloads.filter((item) => item.state === 'progressing').length}
            onSelectTool={openTool}
            onClose={() => setUi({ sidePanelOpen: false })}
            onLiveWidth={setLiveWidth}
            onCommitWidth={(width) => setUi({ sidePanelWidth: width })}
          >
            {sidePanelContent}
          </SidePanel>
        )}

        {menu === 'shield' && <ShieldStatusMenu anchor={shieldButtonRef.current} state={state} workspace={workspace} onClose={closeMenu} onToggleTrackers={() => void act(() => window.privateBrowser.toggleTrackerBlocking(), state.trackerBlocking ? 'Tracker blocking paused' : 'Tracker blocking enabled')} onOpenPrivacy={() => openTool('privacy')} onOpenSettings={() => openTool('settings')} />}
        {menu === 'tab-search' && <TabSearchMenu anchor={tabSearchButtonRef.current} tabs={workspaceTabs} activeTabId={activeTab.id} onActivate={(id) => void act(() => window.privateBrowser.activateTab(id))} onClose={closeMenu} />}
        {menu === 'site-info' && <SiteInfoMenu anchor={siteInfoButtonRef.current} tab={activeTab} account={activeAccount} trackerBlocking={state.trackerBlocking} onClose={closeMenu} onOpenPrivacy={() => openTool('privacy')} onResetZoom={() => void act(() => window.privateBrowser.zoom('reset'))} onToggleDeveloperTools={() => void act(() => window.privateBrowser.toggleDeveloperTools('right'))} />}
        {menu === 'profile' && (
          <ProfileMenu
            anchor={profileButtonRef.current}
            state={state}
            onClose={closeMenu}
            onSwitchAccount={(id: AccountSpaceId) => void act(() => window.privateBrowser.switchAccountSpace(id))}
            onSwitchWorkspace={(id) => void act(() => window.privateBrowser.switchWorkspace(id))}
            onManage={() => setAccountManagerOpen(true)}
            onLock={(id) => void act(() => window.privateBrowser.setAccountSpaceLocked(id, true), 'Account Space locked')}
          />
        )}
        {menu === 'browser' && (
          <BrowserMenu
            anchor={menuButtonRef.current}
            state={state}
            tab={activeTab}
            ui={ui}
            bookmarked={bookmarked}
            onClose={closeMenu}
            actions={{
              newTab: () => void act(() => window.privateBrowser.newTab()),
              reopenClosedTab: () => void act(() => window.privateBrowser.reopenClosedTab()),
              switchAccount: (id) => void act(() => window.privateBrowser.switchAccountSpace(id)),
              manageAccounts: () => setAccountManagerOpen(true),
              openTool,
              toggleBookmark: () => void act(() => window.privateBrowser.toggleBookmark()),
              setUi,
              exportBookmarks: bookmarkActions.exportBookmarks,
              clearBrowsingData,
              zoom: (direction) => void act(() => window.privateBrowser.zoom(direction)),
              toggleFullscreen: () => void act(() => window.privateBrowser.toggleFullscreen()),
              print: () => void act(() => window.privateBrowser.print()),
              find: () => { setFindOpen(true); setFindFocus((value) => value + 1); },
              copyLink: () => void act(() => window.privateBrowser.copyText(activeTab.url), 'Link copied'),
              toggleDeveloperTools: () => void act(() => window.privateBrowser.toggleDeveloperTools('right')),
              toggleTrackers: () => void act(() => window.privateBrowser.toggleTrackerBlocking()),
              quit: () => void window.privateBrowser.quit(),
            }}
          />
        )}

        {state.pendingPermission && <PermissionOverlay state={state} onRespond={(decision, sourceId) => void act(() => window.privateBrowser.respondToPermissionPrompt(state.pendingPermission!.id, decision, sourceId))} />}
        {state.recovery && <RecoveryOverlay state={state} />}
        {accountManagerOpen && <AccountManager state={state} onClose={() => { setAccountManagerOpen(false); profileButtonRef.current?.focus(); }} onToast={showToast} />}
        {vaultFullOpen && <div className="vault-full-overlay" role="dialog" aria-modal="true" aria-label="MyVault metadata"><div className="vault-full-shell"><button className="toolbar-button vault-full-close" aria-label="Close full MyVault view" onClick={() => setVaultFullOpen(false)}><X size={18} /></button><VaultPanel workspaceId={state.activeWorkspaceId} activeOrigin={activeTab.isHome ? undefined : activeTab.url} onToast={showToast} /></div></div>}
        {prompt && <PromptDialog request={prompt} onDone={() => setPrompt(null)} />}

        {toast && <div className={`toast ${toast.kind}`} role="status">{toast.kind === 'error' ? <X size={15} /> : <Check size={15} />} {toast.text}</div>}
      </div>
    </OverlayContext.Provider>
  );
}
