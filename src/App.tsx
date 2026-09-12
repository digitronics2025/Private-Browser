import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Bookmark,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Cloud,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileDown,
  FileCode2,
  Folder,
  Globe2,
  Gauge,
  Home,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  Network,
  PanelBottom,
  PanelRightClose,
  PanelRightOpen,
  PictureInPicture2,
  Play,
  Plus,
  RefreshCw,
  Search,
  ScanSearch,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  Upload,
  Trash2,
  TriangleAlert,
  UserRound,
  X,
  Zap,
} from 'lucide-react';
import type { AiPagePreview, AiProviderInput, AiProviderStatus, Bookmark as BookmarkItem, BrowserSnapshot, BrowserTab, ChromeImportResult, ChromeProfileSource, DeveloperDiagnosticReport, DevToolsMode, UpdateCheckResult, UpdateServiceInput, UpdateServiceStatus, VaultItemMeta, VaultStatus, WorkspaceId } from '../electron/types';

type SidebarMode = 'assistant' | 'developer' | 'vault' | 'automations' | 'downloads' | 'privacy' | 'settings';

const QUICK_LINKS: Record<WorkspaceId, Array<{ label: string; url: string; tone: string }>> = {
  digitronics: [
    { label: 'Digitronics', url: 'https://digitronics.ma', tone: '#5b8cff' },
    { label: 'Store', url: 'https://digitronics.ma', tone: '#7c6df2' },
    { label: 'Meta Ads', url: 'https://business.facebook.com/adsmanager', tone: '#3284ff' },
    { label: 'WhatsApp', url: 'https://web.whatsapp.com', tone: '#28c76f' },
  ],
  tenten: [
    { label: 'TenTen', url: 'https://tenten.ma', tone: '#ffbd59' },
    { label: 'Google Sheets', url: 'https://sheets.google.com', tone: '#2db67c' },
    { label: 'Jumia', url: 'https://vendorhub.jumia.ma', tone: '#ff8c21' },
    { label: 'Marjane', url: 'https://www.marjanemall.ma', tone: '#ef4444' },
  ],
  development: [
    { label: 'GitHub', url: 'https://github.com', tone: '#8b93a7' },
    { label: 'Cloudflare', url: 'https://dash.cloudflare.com', tone: '#f59e0b' },
    { label: 'Private Browser', url: 'https://github.com/digitronics2025/Private-Browser', tone: '#a78bfa' },
    { label: 'Workers Docs', url: 'https://developers.cloudflare.com/workers/', tone: '#fb923c' },
  ],
  personal: [
    { label: 'Gmail', url: 'https://mail.google.com', tone: '#ef4444' },
    { label: 'Drive', url: 'https://drive.google.com', tone: '#3b82f6' },
    { label: 'Calendar', url: 'https://calendar.google.com', tone: '#60a5fa' },
    { label: 'Maps', url: 'https://maps.google.com', tone: '#34d399' },
  ],
  banking: [
    { label: 'Secure search', url: 'https://duckduckgo.com', tone: '#ff6b7a' },
  ],
};

const AUTOMATIONS = [
  {
    id: 'morning',
    name: 'Morning command center',
    description: 'Orders, Meta Ads and WhatsApp',
    icon: Zap,
    workspaceId: 'digitronics' as WorkspaceId,
    urls: ['https://digitronics.ma', 'https://business.facebook.com', 'https://web.whatsapp.com'],
  },
  {
    id: 'development',
    name: 'Development stack',
    description: 'GitHub and Cloudflare dashboard',
    icon: Code2,
    workspaceId: 'development' as WorkspaceId,
    urls: ['https://github.com/digitronics2025', 'https://dash.cloudflare.com'],
  },
  {
    id: 'marketplaces',
    name: 'Marketplace check',
    description: 'Jumia and Marjane Mall',
    icon: Globe2,
    workspaceId: 'tenten' as WorkspaceId,
    urls: ['https://vendorhub.jumia.ma', 'https://www.marjanemall.ma'],
  },
];

function domainFromUrl(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function humanBytes(value: number): string {
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function timeAgo(value: string): string {
  const seconds = Math.max(1, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export default function App() {
  const [state, setState] = useState<BrowserSnapshot | null>(null);
  const [address, setAddress] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('assistant');
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  // Refusals are the moments the app is protecting a secret; they must not
  // look identical to a success. Default 'ok', explicit 'error' on every catch.
  const showToast = (text: string, kind: 'ok' | 'error' = 'ok') => setToast({ text, kind });
  const addressRef = useRef<HTMLInputElement>(null);

  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const workspace = state?.workspaces.find((item) => item.id === state.activeWorkspaceId);
  const workspaceTabs = state?.tabs.filter((tab) => tab.workspaceId === state.activeWorkspaceId) ?? [];

  useEffect(() => {
    void window.privateBrowser.getState().then(setState);
    return window.privateBrowser.onState(setState);
  }, []);

  useEffect(() => window.privateBrowser.onFocusAddress(() => {
    addressRef.current?.focus();
    addressRef.current?.select();
  }), []);

  useEffect(() => window.privateBrowser.onUpdateAvailable((result) => {
    showToast(`Private Browser ${result.latest.version} is ready to download`);
  }), []);

  useEffect(() => {
    if (activeTab) setAddress(activeTab.isHome ? '' : activeTab.url);
  }, [activeTab?.id, activeTab?.url, activeTab?.isHome]);

  useEffect(() => {
    if (!state) return;
    void window.privateBrowser.setLayout({ top: state.bookmarkBarVisible ? 158 : 128, left: 0, right: sidebarOpen ? 366 : 0, bottom: 0 });
  }, [sidebarOpen, state?.bookmarkBarVisible]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const command = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (event.key === 'F12' || (command && event.shiftKey && key === 'i')) {
        event.preventDefault();
        void act(() => window.privateBrowser.toggleDeveloperTools('right'));
      } else if (!command) return;
      else if (key === 'l') {
        event.preventDefault();
        addressRef.current?.focus();
        addressRef.current?.select();
      } else if (key === 't') {
        event.preventDefault();
        void window.privateBrowser.newTab();
      } else if (key === 'w' && activeTab) {
        event.preventDefault();
        void window.privateBrowser.closeTab(activeTab.id);
      } else if (key === 'r' && activeTab && !activeTab.isHome) {
        event.preventDefault();
        void window.privateBrowser.reload();
      } else if (event.shiftKey && key === 'b') {
        event.preventDefault();
        void window.privateBrowser.toggleBookmarkBar();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [activeTab?.id, activeTab?.isHome]);

  const act = async (action: () => Promise<unknown> | unknown, success?: string) => {
    try {
      await action();
      if (success) showToast(success);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    void act(() => window.privateBrowser.navigate(address));
    addressRef.current?.blur();
  };

  if (!state || !activeTab || !workspace) {
    return <div className="boot"><ShieldCheck size={34} /><LoaderCircle className="spin" size={22} /> Opening your private workspace</div>;
  }

  const bookmarked = state.bookmarks.some((item) => item.url === activeTab.url && item.workspaceId === activeTab.workspaceId);

  return (
    <div className={`app-shell ${state.bookmarkBarVisible ? 'bookmark-bar-on' : ''}`}>
      <header className="titlebar">
        <div className="brand-mark"><ShieldCheck size={17} /> Private Browser</div>
        <div className="privacy-status"><span className="status-dot" /> Local protection active</div>
      </header>

      <div className="tabbar">
        <div className="tab-list">
          {workspaceTabs.map((tab) => (
            <button className={`browser-tab ${tab.id === activeTab.id ? 'active' : ''}`} key={tab.id} onClick={() => void act(() => window.privateBrowser.activateTab(tab.id))}>
              <span className="tab-favicon">{tab.loading ? <LoaderCircle className="spin" size={14} /> : tab.favicon ? <img src={tab.favicon} alt="" /> : <Globe2 size={14} />}</span>
              <span className="tab-title">{tab.title}</span>
              <span className="tab-close" role="button" onClick={(event) => { event.stopPropagation(); void act(() => window.privateBrowser.closeTab(tab.id)); }}><X size={13} /></span>
            </button>
          ))}
          <button className="icon-button new-tab" title="New tab" onClick={() => void act(() => window.privateBrowser.newTab())}><Plus size={17} /></button>
        </div>
      </div>

      <nav className="toolbar">
        <button className="icon-button" disabled={!activeTab.canGoBack} onClick={() => void act(() => window.privateBrowser.back())}><ArrowLeft size={18} /></button>
        <button className="icon-button" disabled={!activeTab.canGoForward} onClick={() => void act(() => window.privateBrowser.forward())}><ArrowRight size={18} /></button>
        <button className="icon-button" onClick={() => void act(() => activeTab.loading ? window.privateBrowser.stop() : window.privateBrowser.reload())}>{activeTab.loading ? <X size={17} /> : <RefreshCw size={17} />}</button>
        <button className="icon-button" onClick={() => void act(() => window.privateBrowser.navigate('private://home'))}><Home size={17} /></button>
        <form className="address-shell" onSubmit={submitAddress}>
          {activeTab.isHome ? <Search className="address-icon" size={16} /> : activeTab.securityWarning ? <TriangleAlert className="address-icon insecure" size={16} /> : <ShieldCheck className="address-icon safe" size={16} />}
          <input ref={addressRef} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Search privately or enter address" spellCheck={false} />
          {activeTab.securityWarning && <span className="security-warning" title={activeTab.securityWarning === 'idn' ? 'Internationalized domain: verify this address carefully' : 'Connection is not encrypted'}>{activeTab.securityWarning === 'idn' ? 'Check domain' : 'Not secure'}</span>}
          {!activeTab.isHome && <span className="address-domain">{domainFromUrl(activeTab.url)}</span>}
        </form>
        <button className={`icon-button ${bookmarked ? 'selected' : ''}`} title="Bookmark" onClick={() => void act(() => window.privateBrowser.toggleBookmark())}><Star size={17} fill={bookmarked ? 'currentColor' : 'none'} /></button>
        <button className={`icon-button shield-button ${state.trackerBlocking ? 'selected' : ''}`} title="Tracker blocking" onClick={() => void act(() => window.privateBrowser.toggleTrackerBlocking(), state.trackerBlocking ? 'Tracker blocking paused' : 'Tracker blocking enabled')}><Shield size={18} /></button>
        <button className={`icon-button ${sidebarMode === 'developer' && sidebarOpen ? 'selected' : ''}`} title="Developer cockpit" onClick={() => { setSidebarMode('developer'); setSidebarOpen(true); }}><Code2 size={18} /></button>
        <button className="icon-button" onClick={() => setSidebarOpen((value) => !value)}>{sidebarOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
        <button className="avatar" title="Personal workspace" onClick={() => void act(() => window.privateBrowser.switchWorkspace('personal'))}>DR</button>
        <button className="icon-button" title="Settings" onClick={() => { setSidebarMode('settings'); setSidebarOpen(true); }}><MoreHorizontal size={18} /></button>
      </nav>

      {state.bookmarkBarVisible && <BookmarkBar state={state} openBookmark={(id) => void act(() => window.privateBrowser.openBookmark(id))} />}

      {activeTab.isHome && <Dashboard state={state} open={(url) => void act(() => window.privateBrowser.navigate(url))} openBookmark={(id) => void act(() => window.privateBrowser.openBookmark(id))} />}

      {sidebarOpen && (
        <aside className="sidebar">
          <SidebarNav mode={sidebarMode} setMode={setSidebarMode} counts={{ downloads: state.downloads.filter((item) => item.state === 'progressing').length }} />
          <div className="sidebar-main">
            <WorkspaceSwitcher state={state} onSwitch={(id) => void act(() => window.privateBrowser.switchWorkspace(id))} />
            <div className="sidebar-content">
              {sidebarMode === 'assistant' && <AssistantPanel onToast={showToast} />}
              {sidebarMode === 'developer' && <DeveloperPanel activeTab={activeTab} onToast={showToast} />}
              {sidebarMode === 'vault' && <VaultPanel onToast={showToast} />}
              {sidebarMode === 'automations' && <AutomationPanel onToast={showToast} />}
              {sidebarMode === 'downloads' && <DownloadsPanel state={state} onToast={showToast} />}
              {sidebarMode === 'privacy' && <PrivacyPanel state={state} />}
              {sidebarMode === 'settings' && <SettingsPanel state={state} onToast={showToast} />}
            </div>
          </div>
        </aside>
      )}

      {toast && <div className={`toast ${toast.kind}`}>{toast.kind === 'error' ? <X size={15} /> : <Check size={15} />} {toast.text}</div>}
    </div>
  );
}

function WorkspaceSwitcher({ state, onSwitch }: { state: BrowserSnapshot; onSwitch: (id: WorkspaceId) => void }) {
  const activeWorkspace = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)!;
  return (
    <section className="workspace-switcher" aria-label="Spaces">
      <div className="workspace-switcher-heading"><span>Spaces</span><strong>{activeWorkspace.name}</strong></div>
      <div className="workspace-switcher-items">
        {state.workspaces.map((workspace) => (
          <button key={workspace.id} title={workspace.name} aria-label={`Switch to ${workspace.name}`} aria-pressed={state.activeWorkspaceId === workspace.id} className={`workspace-button ${state.activeWorkspaceId === workspace.id ? 'active' : ''}`} onClick={() => onSwitch(workspace.id)} style={{ '--workspace-color': workspace.color } as React.CSSProperties}>
            {workspace.protected ? <LockKeyhole size={17} /> : workspace.icon}
          </button>
        ))}
        <button className="workspace-button profile" title="Personal profile" aria-label="Open personal workspace" onClick={() => onSwitch('personal')}><UserRound size={18} /></button>
      </div>
    </section>
  );
}

function bookmarkOrder(item: BookmarkItem, depth: number): number {
  return item.orderPath?.[depth] ?? item.order;
}

type BookmarkTreeEntry =
  | { kind: 'bookmark'; order: number; item: BookmarkItem }
  | { kind: 'folder'; order: number; name: string; descendants: BookmarkItem[] };

function bookmarkEntries(items: BookmarkItem[], path: string[]): BookmarkTreeEntry[] {
  const depth = path.length;
  const direct = items
    .filter((item) => item.folderPath.length === depth && path.every((part, index) => item.folderPath[index] === part))
    .map((item) => ({ kind: 'bookmark' as const, order: bookmarkOrder(item, depth), item }));
  const folderNames = [...new Set(items
    .filter((item) => item.folderPath.length > depth && path.every((part, index) => item.folderPath[index] === part))
    .map((item) => item.folderPath[depth]))];
  const folders = folderNames.map((name) => {
    const descendants = items.filter((item) => item.folderPath[depth] === name && path.every((part, index) => item.folderPath[index] === part));
    return { kind: 'folder' as const, order: Math.min(...descendants.map((item) => bookmarkOrder(item, depth))), name, descendants };
  });
  return [...direct, ...folders].sort((left, right) => left.order - right.order);
}

function BookmarkEntries({ entries, path, openBookmark }: { entries: BookmarkTreeEntry[]; path: string[]; openBookmark: (id: string) => void }) {
  return <>{entries.map((entry) => entry.kind === 'bookmark'
    ? <button className="bookmark-bar-item" key={entry.item.id} title={entry.item.title} onClick={() => openBookmark(entry.item.id)}><Globe2 size={13} /><span>{entry.item.title}</span></button>
    : <details className="bookmark-folder" key={`${path.join('/')}/${entry.name}`}>
        <summary><Folder size={14} fill="currentColor" /><span>{entry.name}</span><ChevronDown size={12} /></summary>
        <div className="bookmark-folder-menu"><BookmarkTree items={entry.descendants} path={[...path, entry.name]} openBookmark={openBookmark} /></div>
      </details>)}</>;
}

function BookmarkTree({ items, path = [], limit, openBookmark }: { items: BookmarkItem[]; path?: string[]; limit?: number; openBookmark: (id: string) => void }) {
  const entries = bookmarkEntries(items, path);
  const visible = limit ? entries.slice(0, limit) : entries;
  const overflow = limit ? entries.slice(limit) : [];
  return <>
    <BookmarkEntries entries={visible} path={path} openBookmark={openBookmark} />
    {overflow.length > 0 && <details className="bookmark-folder bookmark-overflow"><summary title="More bookmarks"><MoreHorizontal size={15} /></summary><div className="bookmark-folder-menu right"><BookmarkEntries entries={overflow} path={path} openBookmark={openBookmark} /></div></details>}
  </>;
}

function BookmarkBar({ state, openBookmark }: { state: BrowserSnapshot; openBookmark: (id: string) => void }) {
  const workspaceItems = state.bookmarks.filter((item) => item.workspaceId === state.activeWorkspaceId);
  const barItems = workspaceItems.filter((item) => item.location === 'bar');
  const otherItems = workspaceItems.filter((item) => item.location === 'other');
  return <nav className="bookmark-bar" aria-label="Bookmarks bar">
    <div className="bookmark-bar-scroll">{barItems.length ? <BookmarkTree items={barItems} limit={7} openBookmark={openBookmark} /> : <span className="bookmark-bar-empty">Import Chrome bookmarks or star a page</span>}</div>
    {otherItems.length > 0 && <details className="bookmark-folder other-bookmarks"><summary><Folder size={14} fill="currentColor" /><span>Other bookmarks</span><ChevronDown size={12} /></summary><div className="bookmark-folder-menu right"><BookmarkTree items={otherItems} openBookmark={openBookmark} /></div></details>}
  </nav>;
}

function Dashboard({ state, open, openBookmark }: { state: BrowserSnapshot; open: (url: string) => void; openBookmark: (id: string) => void }) {
  const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId)!;
  const recent = state.history.filter((item) => item.workspaceId === state.activeWorkspaceId).slice(0, 5);
  const bookmarks = state.bookmarks.filter((item) => item.workspaceId === state.activeWorkspaceId).slice(0, 5);
  const quickLinks = QUICK_LINKS[state.activeWorkspaceId];
  return (
    <main className="dashboard" style={{ '--accent': workspace.color } as React.CSSProperties}>
      <div className="dashboard-inner">
        <section className="welcome">
          <div>
            <div className="eyebrow"><span className="workspace-pulse" /> {workspace.name} workspace</div>
            <h1>Good to see you, DR.</h1>
            <p>Your private command center is ready.</p>
          </div>
          <div className="shield-card"><ShieldCheck size={22} /><div><strong>Protected</strong><span>Local-first session</span></div></div>
        </section>

        <section className="quick-grid">
          {quickLinks.map((link) => (
            <button className="quick-card" key={link.label} onClick={() => open(link.url)}>
              <span className="quick-icon" style={{ background: `${link.tone}20`, color: link.tone }}>{link.label.slice(0, 1)}</span>
              <span><strong>{link.label}</strong><small>{domainFromUrl(link.url)}</small></span>
              <ChevronRight size={16} />
            </button>
          ))}
          <button className="quick-card add-shortcut" onClick={() => document.querySelector<HTMLInputElement>('.address-shell input')?.focus()}><span className="quick-icon"><Plus size={19} /></span><span><strong>Open something</strong><small>Search or enter a URL</small></span></button>
        </section>

        <div className="dashboard-columns">
          <section className="panel-card activity-card">
            <div className="section-heading"><div><Clock3 size={17} /><h2>Recent activity</h2></div><span>{recent.length} pages</span></div>
            {recent.length ? recent.map((item) => (
              <button className="list-row" key={item.id} onClick={() => open(item.url)}>
                <span className="site-badge">{domainFromUrl(item.url).slice(0, 1).toUpperCase()}</span>
                <span className="row-main"><strong>{item.title || domainFromUrl(item.url)}</strong><small>{domainFromUrl(item.url)}</small></span>
                <time>{timeAgo(item.visitedAt)}</time>
              </button>
            )) : <EmptyState icon={Clock3} text="Your recent pages will appear here." />}
          </section>
          <section className="panel-card activity-card">
            <div className="section-heading"><div><Bookmark size={17} /><h2>Bookmarks</h2></div><span>{bookmarks.length} saved</span></div>
            {bookmarks.length ? bookmarks.map((item) => (
              <button className="list-row" key={item.id} onClick={() => openBookmark(item.id)}>
                <span className="site-badge starred"><Star size={14} /></span>
                <span className="row-main"><strong>{item.title}</strong><small>{domainFromUrl(item.url)}</small></span>
                <ExternalLink size={14} />
              </button>
            )) : <EmptyState icon={Star} text="Star a page to keep it close." />}
          </section>
        </div>
      </div>
    </main>
  );
}

function SidebarNav({ mode, setMode, counts }: { mode: SidebarMode; setMode: (mode: SidebarMode) => void; counts: { downloads: number } }) {
  const items: Array<{ id: SidebarMode; icon: typeof Bot; label: string; count?: number }> = [
    { id: 'assistant', icon: Sparkles, label: 'AI' },
    { id: 'developer', icon: Code2, label: 'Dev' },
    { id: 'vault', icon: KeyRound, label: 'Vault' },
    { id: 'automations', icon: Zap, label: 'Flows' },
    { id: 'downloads', icon: Download, label: 'Files', count: counts.downloads },
    { id: 'privacy', icon: ShieldCheck, label: 'Privacy' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ];
  return <div className="sidebar-nav">{items.map(({ id, icon: Icon, label, count }) => <button key={id} className={mode === id ? 'active' : ''} onClick={() => setMode(id)} title={label}><Icon size={17} />{count ? <b>{count}</b> : null}<span>{label}</span></button>)}</div>;
}

function PanelHeader({ icon: Icon, eyebrow, title }: { icon: typeof Bot; eyebrow: string; title: string }) {
  return <div className="panel-header"><span className="panel-icon"><Icon size={18} /></span><div><small>{eyebrow}</small><h2>{title}</h2></div></div>;
}

function DeveloperPanel({ activeTab, onToast }: { activeTab: BrowserTab; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [mode, setMode] = useState<DevToolsMode>('right');
  const [report, setReport] = useState<DeveloperDiagnosticReport | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => setReport(null), [activeTab.id, activeTab.url]);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setLoading(true);
    try {
      await action();
      if (success) onToast(success);
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setLoading(false);
    }
  };

  const capture = () => run(async () => {
    const next = await window.privateBrowser.captureDeveloperDiagnostics();
    setReport(next);
  }, 'Sanitized diagnostics captured locally');

  const clear = () => run(async () => {
    await window.privateBrowser.clearDeveloperDiagnostics();
    setReport(null);
  }, 'Developer diagnostics cleared');

  return (
    <div className="side-panel developer-panel">
      <PanelHeader icon={Code2} eyebrow="Development workspace" title="Developer cockpit" />

      {!activeTab.developerToolsAllowed ? (
        <div className="developer-locked">
          <LockKeyhole size={24} />
          <h3>Protected by workspace policy</h3>
          <p>Open a non-banking webpage in the Development workspace. Developer tools never attach to Home, Banking, or detected payment pages.</p>
        </div>
      ) : (
        <>
          <div className="developer-status">
            <span className={activeTab.developerToolsOpen ? 'live' : ''} />
            <div><strong>{activeTab.developerToolsOpen ? 'Chromium DevTools open' : 'Ready to inspect'}</strong><small>{domainFromUrl(activeTab.url)} · F12 or Ctrl+Shift+I</small></div>
          </div>

          <div className="developer-launch">
            <select value={mode} onChange={(event) => setMode(event.target.value as DevToolsMode)} aria-label="DevTools position">
              <option value="right">Dock right</option>
              <option value="bottom">Dock bottom</option>
              <option value="detach">Separate window</option>
            </select>
            <button className="primary-button" disabled={loading} onClick={() => void run(() => window.privateBrowser.toggleDeveloperTools(mode))}>
              {activeTab.developerToolsOpen ? <PanelRightClose size={14} /> : mode === 'bottom' ? <PanelBottom size={14} /> : mode === 'detach' ? <PictureInPicture2 size={14} /> : <PanelRightOpen size={14} />}
              {activeTab.developerToolsOpen ? 'Close tools' : 'Open tools'}
            </button>
          </div>

          <div className="developer-tip"><ScanSearch size={16} /><p><strong>Inspect exact UI.</strong> Right-click anything in the page and choose <em>Inspect element</em>.</p></div>

          <div className="tool-grid">
            <div><ScanSearch size={15} /><strong>Elements</strong><small>DOM & CSS</small></div>
            <div><Bug size={15} /><strong>Console</strong><small>Errors & JS</small></div>
            <div><Network size={15} /><strong>Network</strong><small>APIs & timing</small></div>
            <div><FileCode2 size={15} /><strong>Sources</strong><small>Breakpoints</small></div>
            <div><Gauge size={15} /><strong>Performance</strong><small>CPU & layout</small></div>
            <div><Play size={15} /><strong>Recorder</strong><small>User flows</small></div>
          </div>

          <section className="diagnostic-card">
            <div><div><small>AI-READY REPORT</small><strong>Safe debugging context</strong></div>{report && <b>{report.console.length + report.network.length} issues</b>}</div>
            <p>Captures document counts, console warnings/errors, and failed requests. It excludes page text, inputs, cookies, storage, headers, request bodies, query strings, and fragments.</p>
            <button className="primary-button full" disabled={loading} onClick={capture}><Bug size={14} /> Capture diagnostics</button>
            {report && (
              <div className="diagnostic-result">
                <div><span><strong>{report.console.length}</strong> console</span><span><strong>{report.network.length}</strong> network</span><span><strong>{report.redactions}</strong> redacted</span></div>
                <button onClick={() => void run(() => window.privateBrowser.copyText(report.formatted), 'Report copied for Codex or Claude')}><Copy size={13} /> Copy for AI</button>
                <button className="quiet" onClick={clear}>Clear captured data</button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function AssistantPanel({ onToast }: { onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [preview, setPreview] = useState<AiPagePreview | null>(null);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState<AiProviderStatus>({ configured: false });
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [providerForm, setProviderForm] = useState<AiProviderInput>({ endpoint: 'https://openrouter.ai/api/v1', model: '', apiKey: '' });
  const [question, setQuestion] = useState('Summarize the important points on this page.');
  const [answer, setAnswer] = useState('');
  useEffect(() => { void window.privateBrowser.getAiProvider().then(setProvider).catch(() => undefined); }, []);
  const clearContext = async () => {
    setPreview(null);
    setApprovalToken(null);
    setAnswer('');
    // Forgetting the token in the renderer did not invalidate it: the captured
    // page text and the live capability stayed in the main process for the full
    // five minutes. Revoke it for real.
    try { await window.privateBrowser.revokeAiContext(); } catch { /* nothing to revoke */ }
  };
  // Leaving the panel is the same intent as pressing Clear.
  useEffect(() => () => { void window.privateBrowser.revokeAiContext().catch(() => undefined); }, []);
  const prepare = async () => {
    setLoading(true);
    setApprovalToken(null);
    setAnswer('');
    try { setPreview(await window.privateBrowser.prepareAiPreview()); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  const approve = async () => {
    if (!preview) return;
    setLoading(true);
    try {
      const approval = await window.privateBrowser.approveAiPreview(preview.id);
      setPreview(approval.preview);
      setApprovalToken(approval.token);
      onToast('Sanitized context approved');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  const configureProvider = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      setProvider(await window.privateBrowser.configureAiProvider(providerForm));
      setShowProviderForm(false);
      onToast('AI provider encrypted and saved');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally {
      setLoading(false);
      // Clear the key whether or not it was accepted: a rejected submit used to
      // leave it in renderer state and in the input's DOM value.
      setProviderForm((value) => ({ ...value, apiKey: '' }));
    }
  };
  const ask = async () => {
    if (!approvalToken) return;
    setLoading(true);
    try {
      setAnswer(await window.privateBrowser.askAi(approvalToken, question));
      setApprovalToken(null);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };
  return (
    <div className="side-panel">
      <PanelHeader icon={Bot} eyebrow="Private assistant" title="Page intelligence" />
      <div className="local-banner"><LockKeyhole size={15} /><div><strong>Private by default</strong><span>Nothing leaves this device without approval.</span></div></div>
      <div className="provider-strip">
        <span className={provider.configured ? 'connected' : ''} />
        <div><strong>{provider.configured ? provider.model : provider.error === 'provider-corrupt' ? 'Provider recovery required' : 'Cloud AI not connected'}</strong><small>{provider.configured ? domainFromUrl(provider.endpoint ?? '') : provider.error === 'provider-corrupt' ? 'Reset the unreadable configuration' : 'Local tools remain available'}</small></div>
        <button onClick={() => setShowProviderForm((value) => !value)}>{provider.configured ? 'Change' : 'Connect'}</button>
      </div>
      {showProviderForm && <form className="vault-form provider-form" onSubmit={configureProvider}>
        <input placeholder="OpenAI-compatible endpoint" required value={providerForm.endpoint} onChange={(event) => setProviderForm({ ...providerForm, endpoint: event.target.value })} />
        <input placeholder="Model ID" required value={providerForm.model} onChange={(event) => setProviderForm({ ...providerForm, model: event.target.value })} />
        <input placeholder="API key (encrypted)" type="password" value={providerForm.apiKey} onChange={(event) => setProviderForm({ ...providerForm, apiKey: event.target.value })} />
        <button className="primary-button" type="submit" disabled={loading}><LockKeyhole size={15} /> Save encrypted provider</button>
        {(provider.configured || provider.error === 'provider-corrupt') && <button className="text-button danger-text" type="button" onClick={() => { if (window.confirm('Remove the saved AI provider configuration?')) void window.privateBrowser.clearAiProvider().then((status) => { setProvider(status); setShowProviderForm(false); onToast('AI provider removed'); }); }}>{provider.error === 'provider-corrupt' ? 'Reset provider configuration' : 'Remove provider'}</button>}
      </form>}
      {!preview ? (
        <div className="assistant-empty">
          <span className="orb"><Sparkles size={25} /></span>
          <h3>Understand this page</h3>
          <p>Read visible text locally, remove sensitive patterns, and review it before any cloud use.</p>
          <button className="primary-button" onClick={prepare} disabled={loading}>{loading ? <LoaderCircle className="spin" size={16} /> : <Eye size={16} />} Read page locally</button>
        </div>
      ) : (
        <>
          <div className="context-card">
            <div className="context-heading"><span>EXACTLY WHAT WOULD BE SENT</span><b>{preview.redactions} redacted</b></div>
            <h3>{preview.title || 'Untitled page'}</h3>
            <small className="context-origin">{preview.url}</small>
            {preview.text
              ? <><pre className="context-text">{preview.text}</pre><small className="context-size">{preview.text.length.toLocaleString()} characters — scroll the box to read all of it</small></>
              : <p>No readable text was found. Only the title and address above would be sent.</p>}
          </div>
          <div className="permission-card">
            <div><Cloud size={17} /><strong>Cloud permission</strong></div>
            <p>The title, address and text shown above are the whole of what leaves this machine. Nothing else from the page is sent, and only for the one request you approve.</p>
            {approvalToken ? <div className="approved"><Check size={15} /> Approved for one request</div> : <button className="primary-button" onClick={approve} disabled={loading || !provider.configured}><ShieldCheck size={16} /> {provider.configured ? 'Approve context' : 'Connect provider first'}</button>}
          </div>
          {approvalToken && <div className="ask-card"><textarea maxLength={2000} value={question} onChange={(event) => setQuestion(event.target.value)} /><button className="primary-button full" onClick={() => void ask()} disabled={loading || !question.trim()}>{loading ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />} Ask cloud AI once</button></div>}
          {answer && <div className="answer-card"><span>AI ANSWER</span><p>{answer}</p></div>}
          <button className="text-button" onClick={() => void clearContext()}>Clear page context</button>
        </>
      )}
    </div>
  );
}

function VaultPanel({ onToast }: { onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [items, setItems] = useState<VaultItemMeta[]>([]);
  const [status, setStatus] = useState<VaultStatus>({ available: true, items: [] });
  const load = async () => {
    try { const result = await window.privateBrowser.listVault(); setItems(result.items); setStatus(result); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  useEffect(() => { void load(); }, []);
  const copyPassword = async (id: string) => {
    try { await window.privateBrowser.copyPassword(id); onToast('Password copied; clipboard clears in 30 seconds'); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const copyTotp = async (id: string) => {
    try { const { secondsRemaining } = await window.privateBrowser.copyTotp(id); onToast(`Authenticator code copied · ${secondsRemaining}s remaining`); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const unlock = async () => { try { const result = await window.privateBrowser.requestVaultUnlock(); setStatus(result); setItems(result.items); } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const lock = async () => { const result = await window.privateBrowser.lockVault(); setStatus(result); setItems([]); };
  const add = async () => { try { const result = await window.privateBrowser.openVaultEditor(); if (result) { await load(); onToast('Login encrypted in MyVault'); } } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  return (
    <div className="side-panel">
      <PanelHeader icon={KeyRound} eyebrow="MyVault broker" title="MyVault" />
      <div className={`vault-health ${status.available ? '' : 'warning'}`}><ShieldCheck size={16} /><div><strong>{status.lifecycle === 'unlocked' ? 'Unlocked on this device' : status.lifecycle === 'recovery-required' ? 'Recovery required' : status.lifecycle === 'unconfigured' ? 'Connection required' : 'Locked'}</strong><span>{status.sync === 'dirty' ? 'Encrypted changes are waiting to sync.' : 'Passwords stay outside this interface and browser pages.'}</span></div></div>
      {status.lifecycle === 'recovery-required' && <button className="recovery-button" onClick={() => void window.privateBrowser.acknowledgeVaultRecovery().then((result) => { setStatus(result); setItems(result.items); })}>Keep recovery copy and continue</button>}
      {status.lifecycle === 'locked' && <button className="primary-button full" onClick={() => void unlock()}><LockKeyhole size={16} /> Unlock in secure window</button>}
      {status.lifecycle === 'unlocked' && <div className="credential-actions"><button className="primary-button" onClick={() => void add()}><Plus size={16} /> Add login</button><button onClick={() => void lock()}><LockKeyhole size={14} /> Lock</button></div>}
      <div className="credential-list">
        {items.map((item) => <div className="credential-card" key={item.id}>
          <div className="credential-top"><span className="site-badge">{item.label.slice(0, 1).toUpperCase()}</span><div><strong>{item.label}</strong><small>{domainFromUrl(item.url)} · {item.username}</small></div></div>
          <div className="credential-actions">
            <button onClick={() => void window.privateBrowser.autofill(item.id).then(() => onToast('Credential filled')).catch((error) => onToast(error.message, 'error'))}><Zap size={14} /> Fill</button>
            <button onClick={() => void copyPassword(item.id)}><Copy size={14} /> Password</button>
            {item.hasTotp && <button onClick={() => void copyTotp(item.id)}><Clock3 size={14} /> Code</button>}
            <button className="danger" title="Delete" onClick={() => void window.privateBrowser.requestVaultDelete(item.id).then(load)}><Trash2 size={14} /></button>
          </div>
        </div>)}
        {!items.length && status.lifecycle === 'unlocked' && <EmptyState icon={KeyRound} text="No logins in MyVault yet." />}
      </div>
    </div>
  );
}

function AutomationPanel({ onToast }: { onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [running, setRunning] = useState<string | null>(null);
  const run = async (automation: typeof AUTOMATIONS[number]) => {
    setRunning(automation.id);
    try {
      for (const url of automation.urls) await window.privateBrowser.newTab(automation.workspaceId, url);
      onToast(`${automation.name} opened`);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setRunning(null); }
  };
  return <div className="side-panel"><PanelHeader icon={Zap} eyebrow="Safe routines" title="Automations" /><p className="panel-intro">Open complete work setups in isolated sessions. Publishing, payments and destructive actions are never automated.</p><div className="automation-list">{AUTOMATIONS.map((automation) => { const Icon = automation.icon; return <button className="automation-card" key={automation.id} onClick={() => void run(automation)}><span><Icon size={18} /></span><div><strong>{automation.name}</strong><small>{automation.description}</small></div>{running === automation.id ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}</button>; })}</div><div className="safety-note"><Shield size={16} /><p><strong>Approval boundary</strong><br />Messages, purchases, ads, deletion and account changes always require you.</p></div></div>;
}

function DownloadsPanel({ state, onToast }: { state: BrowserSnapshot; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  return <div className="side-panel"><PanelHeader icon={FileDown} eyebrow="This session" title="Downloads" /><div className="download-list">{state.downloads.map((item) => { const progress = item.totalBytes ? Math.round(item.receivedBytes / item.totalBytes * 100) : 0; return <div className="download-card" key={item.id}><div className="download-icon"><FileDown size={18} /></div><div className="download-body"><strong>{item.filename}</strong><small>{item.state === 'progressing' ? `${humanBytes(item.receivedBytes)} of ${humanBytes(item.totalBytes)}` : item.state}</small>{item.state === 'progressing' && <div className="progress"><span style={{ width: `${progress}%` }} /></div>}{item.risk !== 'ordinary' && item.checksum !== 'verified' && <small className="checksum bad"><TriangleAlert size={12} /> {item.risk === 'deceptive' ? 'Deceptive double extension — opening blocked' : 'Executable download — opening blocked until verified'}</small>}{item.checksum === 'verified' && <small className="checksum ok"><ShieldCheck size={12} /> Checksum matches the published release</small>}{item.checksum === 'mismatch' && <small className="checksum bad"><X size={12} /> Checksum does NOT match — do not run this file</small>}<div className="download-actions"><button onClick={() => void window.privateBrowser.openDownload(item.id).catch((error) => onToast(error.message, 'error'))}>Open</button><button onClick={() => void window.privateBrowser.showDownload(item.id)}>Show folder</button></div></div></div>; })}{!state.downloads.length && <EmptyState icon={Download} text="Downloaded files will appear here." />}</div></div>;
}

function PrivacyPanel({ state }: { state: BrowserSnapshot }) {
  return <div className="side-panel"><PanelHeader icon={ShieldCheck} eyebrow="Transparent by design" title="Privacy log" /><div className="privacy-summary"><div><strong>{state.trackerBlocking ? 'On' : 'Off'}</strong><span>Tracker blocking</span></div><div><strong>5</strong><span>Isolated spaces</span></div><div><strong>{state.privacyLog.length}</strong><span>Logged events</span></div></div><div className="privacy-events">{state.privacyLog.map((event) => <div className="privacy-event" key={event.id}><span className={`event-dot ${event.kind}`} /><div><strong>{event.title}</strong><small>{event.detail}</small></div><time>{timeAgo(event.at)}</time></div>)}{!state.privacyLog.length && <EmptyState icon={ShieldCheck} text="Sensitive access events will be recorded here." />}</div></div>;
}

function SettingsPanel({ state, onToast }: { state: BrowserSnapshot; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [isDefault, setIsDefault] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateServiceStatus | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [editingUpdates, setEditingUpdates] = useState(false);
  const [checking, setChecking] = useState(false);
  const [updateForm, setUpdateForm] = useState<UpdateServiceInput>({ endpoint: '', accessToken: '' });
  const [chromeProfiles, setChromeProfiles] = useState<ChromeProfileSource[]>([]);
  const [chromeProfileId, setChromeProfileId] = useState('');
  const [chromeWorkspace, setChromeWorkspace] = useState<WorkspaceId>(state.activeWorkspaceId === 'banking' ? 'personal' : state.activeWorkspaceId);
  const [chromeBookmarks, setChromeBookmarks] = useState(true);
  const [chromeHistory, setChromeHistory] = useState(true);
  const [chromeImportOpen, setChromeImportOpen] = useState(false);
  const [chromeLoading, setChromeLoading] = useState(false);
  const [chromeResult, setChromeResult] = useState<ChromeImportResult | null>(null);
  // null while the first status is still in flight — better than claiming
  // 'Active' before anything has been checked, which is what it used to do.
  const encryptionAvailable = updateStatus ? updateStatus.error !== 'os-encryption-unavailable' : null;
  useEffect(() => {
    void window.privateBrowser.getDefaultBrowserStatus().then(setIsDefault).catch(() => undefined);
    void window.privateBrowser.getUpdateService().then((status) => {
      setUpdateStatus(status);
      setUpdateForm((value) => ({ ...value, endpoint: status.endpoint ?? '' }));
    }).catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'));
  }, []);
  const makeDefault = async () => {
    try {
      const result = await window.privateBrowser.setDefaultBrowser();
      setIsDefault(result);
      onToast(result ? 'Private Browser is now your default' : 'Windows requires you to choose Private Browser in Default Apps');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const configureUpdates = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const status = await window.privateBrowser.configureUpdateService(updateForm);
      setUpdateStatus(status);
      setUpdateForm({ endpoint: status.endpoint ?? '', accessToken: '' });
      setEditingUpdates(false);
      onToast('Private download service connected');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setUpdateForm((value) => ({ ...value, accessToken: '' })); }
  };
  const checkUpdates = async () => {
    setChecking(true);
    try {
      const result = await window.privateBrowser.checkForUpdates();
      setUpdateResult(result);
      onToast(result.state === 'available' ? `Version ${result.latest.version} is available` : 'Private Browser is up to date');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setChecking(false); }
  };
  const disconnectUpdates = async () => {
    try {
      const status = await window.privateBrowser.clearUpdateService();
      setUpdateStatus(status);
      setUpdateResult(null);
      setUpdateForm({ endpoint: '', accessToken: '' });
      setEditingUpdates(false);
      onToast('Private download service disconnected');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const openChromeImport = async () => {
    setChromeImportOpen(true);
    setChromeLoading(true);
    setChromeResult(null);
    try {
      const profiles = await window.privateBrowser.listChromeProfiles();
      setChromeProfiles(profiles);
      setChromeProfileId((current) => current || profiles.find((profile) => profile.isDefault)?.id || profiles[0]?.id || '');
      if (!profiles.length) onToast('No local Chrome profile was found', 'error');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setChromeLoading(false); }
  };
  const importChrome = async () => {
    setChromeLoading(true);
    try {
      const result = await window.privateBrowser.importChrome({ profileId: chromeProfileId, workspaceId: chromeWorkspace, bookmarks: chromeBookmarks, history: chromeHistory });
      setChromeResult(result);
      onToast(`Imported ${result.imported.bookmarks} bookmarks and ${result.imported.history} history entries`);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setChromeLoading(false); }
  };
  const importChromePasswords = async () => {
    setChromeLoading(true);
    try {
      const result = await window.privateBrowser.importChromePasswords();
      setChromeResult(result);
      onToast(`Encrypted ${result.imported.passwords} Chrome passwords in your local vault`);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setChromeLoading(false); }
  };
  return <div className="side-panel">
    <PanelHeader icon={Settings} eyebrow="Application" title="Settings" />
    <div className="settings-card"><div className="settings-row"><span><Globe2 size={17} /></span><div><strong>Default browser</strong><small>{isDefault ? 'Private Browser opens web links.' : 'Use Private Browser for HTTP and HTTPS links.'}</small></div>{isDefault ? <b><Check size={14} /> Set</b> : <button onClick={() => void makeDefault()}>Set default</button>}</div></div>
    <div className="settings-card chrome-import-settings">
      <div className="settings-row"><span><Upload size={17} /></span><div><strong>Import from Chrome</strong><small>Bookmarks, bookmark folders and browsing history stay on this computer.</small></div><button onClick={() => chromeImportOpen ? setChromeImportOpen(false) : void openChromeImport()}>{chromeImportOpen ? 'Close' : 'Import'}</button></div>
      {chromeImportOpen && <div className="chrome-import-form">
        {chromeLoading && !chromeProfiles.length ? <div className="import-loading"><LoaderCircle className="spin" size={15} /> Detecting Chrome profiles…</div> : chromeProfiles.length > 0 ? <>
          <label><span>Chrome profile</span><select value={chromeProfileId} onChange={(event) => setChromeProfileId(event.target.value)}>{chromeProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}{profile.isDefault ? ' (Default)' : ''}</option>)}</select></label>
          <label><span>Import into workspace</span><select value={chromeWorkspace} onChange={(event) => setChromeWorkspace(event.target.value as WorkspaceId)}>{state.workspaces.filter((item) => !item.protected).map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
          <div className="import-checks">
            <label><input type="checkbox" checked={chromeBookmarks} onChange={(event) => setChromeBookmarks(event.target.checked)} /> <span><strong>Bookmarks</strong><small>Includes the full Chrome bookmarks bar and folder hierarchy.</small></span></label>
            <label><input type="checkbox" checked={chromeHistory} onChange={(event) => setChromeHistory(event.target.checked)} /> <span><strong>Browsing history</strong><small>Up to 10,000 recent Chrome pages.</small></span></label>
          </div>
          <button className="primary-button full" disabled={chromeLoading || (!chromeBookmarks && !chromeHistory)} onClick={() => void importChrome()}>{chromeLoading ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />} Import selected data</button>
        </> : !chromeLoading ? <p className="import-note">Install or open Chrome once so a local profile exists, then try again.</p> : null}
        <div className="password-import-row"><div><strong>Saved passwords</strong><small>Chrome protects direct access. Export passwords as CSV, then select that file here. Secrets go straight into the OS-encrypted Vault and never enter the page.</small></div><button disabled={chromeLoading} onClick={() => void importChromePasswords()}>Choose CSV</button></div>
        <p className="import-limit"><Shield size={13} /> Cookies, signed-in sessions, payment cards, extensions and Chrome account tokens are intentionally not copied.</p>
        {chromeResult && <div className="import-result"><Check size={15} /><div><strong>Import complete</strong><small>{chromeResult.imported.bookmarks} bookmarks · {chromeResult.imported.history} history · {chromeResult.imported.passwords} passwords</small>{chromeResult.skipped.bookmarks + chromeResult.skipped.history + chromeResult.skipped.passwords > 0 && <small>{chromeResult.skipped.bookmarks + chromeResult.skipped.history + chromeResult.skipped.passwords} duplicate or unsafe entries skipped</small>}{chromeResult.warnings.map((warning) => <small className="warning" key={warning}>{warning}</small>)}</div></div>}
      </div>}
    </div>
    <div className="settings-card"><div className="settings-row"><span><Bookmark size={17} /></span><div><strong>Bookmarks bar</strong><small>Show the Chrome-style bookmarks bar. Shortcut: Ctrl+Shift+B.</small></div><button onClick={() => void window.privateBrowser.toggleBookmarkBar()}>{state.bookmarkBarVisible ? 'Hide' : 'Show'}</button></div></div>
    <div className="settings-card update-settings">
      <div className="settings-row"><span><Cloud size={17} /></span><div><strong>Private downloads</strong><small>{updateStatus?.configured ? updateStatus.endpoint : 'Cloudflare Worker · D1 metadata · R2 installers'}</small></div>{updateStatus?.configured ? <b><Check size={14} /> Connected</b> : <button onClick={() => setEditingUpdates((value) => !value)}>Connect</button>}</div>
      {(editingUpdates || updateStatus?.error) && <form className="update-form" onSubmit={configureUpdates}>
        {updateStatus?.error && <p>{updateStatus.error === 'configuration-corrupt' ? 'The encrypted update configuration is unreadable. Saving replaces it.' : 'Windows encryption is unavailable on this device.'}</p>}
        <input type="url" required placeholder="https://private-browser-downloads.example.workers.dev" value={updateForm.endpoint} onChange={(event) => setUpdateForm({ ...updateForm, endpoint: event.target.value })} />
        <input type="password" required minLength={32} placeholder="Download access token" value={updateForm.accessToken} onChange={(event) => setUpdateForm({ ...updateForm, accessToken: event.target.value })} />
        <button className="primary-button" type="submit"><LockKeyhole size={14} /> Encrypt and connect</button>
      </form>}
      {updateStatus?.configured && <div className="update-actions">
        <button onClick={() => void checkUpdates()} disabled={checking}>{checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} Check now</button>
        <button className="download-update" onClick={() => void window.privateBrowser.openUpdatePage().catch((error) => onToast(error.message, 'error'))}><Download size={14} /> {updateResult?.state === 'available' ? `Download ${updateResult.latest.version}` : 'Download page'}</button>
        <button onClick={() => setEditingUpdates((value) => !value)}>Change</button>
        <button className="danger" onClick={() => void disconnectUpdates()}>Disconnect</button>
      </div>}
      {updateResult && <div className={`update-result ${updateResult.state}`}><strong>{updateResult.state === 'available' ? `Version ${updateResult.latest.version} available` : `Up to date · ${updateResult.currentVersion}`}</strong><small>{updateResult.state === 'available' ? `${humanBytes(updateResult.latest.sizeBytes)} · SHA-256 verified in release metadata` : `Checked ${timeAgo(updateResult.checkedAt)}`}</small></div>}
    </div>
    <div className="settings-card"><div className="settings-row"><span><ShieldCheck size={17} /></span><div><strong>Security baseline</strong><small>Sandboxed pages, isolated sessions, strict IPC and encrypted secrets.</small></div>{encryptionAvailable === null ? <b className="pending">Checking…</b> : encryptionAvailable ? <b><Check size={14} /> Active</b> : <b className="failing"><X size={14} /> Encryption unavailable</b>}</div></div>
    <div className="about-card"><span><ShieldCheck size={23} /></span><div><strong>Private Browser</strong><small>{updateStatus?.currentVersion ? `Version ${updateStatus.currentVersion} · Digitronics` : 'Digitronics'}</small></div></div>
  </div>;
}

function EmptyState({ icon: Icon, text }: { icon: typeof Clock3; text: string }) {
  return <div className="empty-state"><Icon size={21} /><span>{text}</span></div>;
}
