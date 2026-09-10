import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Bookmark,
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
  Globe2,
  Home,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  UserRound,
  X,
  Zap,
} from 'lucide-react';
import type { AiPagePreview, BrowserSnapshot, VaultItemInput, VaultItemMeta, WorkspaceId } from '../electron/types';

type SidebarMode = 'assistant' | 'vault' | 'automations' | 'downloads' | 'privacy';

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
  const [toast, setToast] = useState<string | null>(null);
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

  useEffect(() => {
    if (activeTab) setAddress(activeTab.isHome ? '' : activeTab.url);
  }, [activeTab?.id, activeTab?.url, activeTab?.isHome]);

  useEffect(() => {
    void window.privateBrowser.setLayout({ top: 128, left: 74, right: sidebarOpen ? 366 : 0, bottom: 0 });
  }, [sidebarOpen]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const act = async (action: () => Promise<unknown> | unknown, success?: string) => {
    try {
      await action();
      if (success) setToast(success);
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
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
    <div className="app-shell">
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
          {activeTab.isHome ? <Search className="address-icon" size={16} /> : <ShieldCheck className="address-icon safe" size={16} />}
          <input ref={addressRef} value={address} onChange={(event) => setAddress(event.target.value)} placeholder="Search privately or enter address" spellCheck={false} />
          {!activeTab.isHome && <span className="address-domain">{domainFromUrl(activeTab.url)}</span>}
        </form>
        <button className={`icon-button ${bookmarked ? 'selected' : ''}`} title="Bookmark" onClick={() => void act(() => window.privateBrowser.toggleBookmark())}><Star size={17} fill={bookmarked ? 'currentColor' : 'none'} /></button>
        <button className={`icon-button shield-button ${state.trackerBlocking ? 'selected' : ''}`} title="Tracker blocking" onClick={() => void act(() => window.privateBrowser.toggleTrackerBlocking(), state.trackerBlocking ? 'Tracker blocking paused' : 'Tracker blocking enabled')}><Shield size={18} /></button>
        <button className="icon-button" onClick={() => setSidebarOpen((value) => !value)}>{sidebarOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}</button>
        <button className="avatar">DR</button>
        <button className="icon-button"><MoreHorizontal size={18} /></button>
      </nav>

      <WorkspaceRail state={state} onSwitch={(id) => void act(() => window.privateBrowser.switchWorkspace(id))} />

      {activeTab.isHome && <Dashboard state={state} open={(url) => void act(() => window.privateBrowser.navigate(url))} openBookmark={(id) => void act(() => window.privateBrowser.openBookmark(id))} />}

      {sidebarOpen && (
        <aside className="sidebar">
          <SidebarNav mode={sidebarMode} setMode={setSidebarMode} counts={{ downloads: state.downloads.filter((item) => item.state === 'progressing').length }} />
          <div className="sidebar-content">
            {sidebarMode === 'assistant' && <AssistantPanel activeTitle={activeTab.title} onToast={setToast} />}
            {sidebarMode === 'vault' && <VaultPanel onToast={setToast} />}
            {sidebarMode === 'automations' && <AutomationPanel onToast={setToast} />}
            {sidebarMode === 'downloads' && <DownloadsPanel state={state} onToast={setToast} />}
            {sidebarMode === 'privacy' && <PrivacyPanel state={state} />}
          </div>
        </aside>
      )}

      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
    </div>
  );
}

function WorkspaceRail({ state, onSwitch }: { state: BrowserSnapshot; onSwitch: (id: WorkspaceId) => void }) {
  return (
    <aside className="workspace-rail">
      <div className="rail-label">Spaces</div>
      {state.workspaces.map((workspace) => (
        <button key={workspace.id} title={workspace.name} className={`workspace-button ${state.activeWorkspaceId === workspace.id ? 'active' : ''}`} onClick={() => onSwitch(workspace.id)} style={{ '--workspace-color': workspace.color } as React.CSSProperties}>
          {workspace.protected ? <LockKeyhole size={17} /> : workspace.icon}
          <span className="workspace-tooltip">{workspace.name}</span>
        </button>
      ))}
      <div className="rail-spacer" />
      <button className="workspace-button profile"><UserRound size={18} /></button>
    </aside>
  );
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
    { id: 'vault', icon: KeyRound, label: 'Vault' },
    { id: 'automations', icon: Zap, label: 'Flows' },
    { id: 'downloads', icon: Download, label: 'Files', count: counts.downloads },
    { id: 'privacy', icon: ShieldCheck, label: 'Privacy' },
  ];
  return <div className="sidebar-nav">{items.map(({ id, icon: Icon, label, count }) => <button key={id} className={mode === id ? 'active' : ''} onClick={() => setMode(id)} title={label}><Icon size={17} />{count ? <b>{count}</b> : null}<span>{label}</span></button>)}</div>;
}

function PanelHeader({ icon: Icon, eyebrow, title }: { icon: typeof Bot; eyebrow: string; title: string }) {
  return <div className="panel-header"><span className="panel-icon"><Icon size={18} /></span><div><small>{eyebrow}</small><h2>{title}</h2></div></div>;
}

function AssistantPanel({ activeTitle, onToast }: { activeTitle: string; onToast: (message: string) => void }) {
  const [preview, setPreview] = useState<AiPagePreview | null>(null);
  const [approved, setApproved] = useState(false);
  const [loading, setLoading] = useState(false);
  const summary = useMemo(() => {
    if (!preview) return '';
    return preview.text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter((part) => part.length > 35).slice(0, 3).join(' ');
  }, [preview]);
  const prepare = async () => {
    setLoading(true);
    setApproved(false);
    try { setPreview(await window.privateBrowser.prepareAiPreview()); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  const approve = async () => {
    if (!preview) return;
    setLoading(true);
    try {
      setPreview(await window.privateBrowser.approveAiPreview(preview));
      setApproved(true);
      onToast('Sanitized context approved');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  };
  return (
    <div className="side-panel">
      <PanelHeader icon={Bot} eyebrow="Private assistant" title="Page intelligence" />
      <div className="local-banner"><LockKeyhole size={15} /><div><strong>Private by default</strong><span>Nothing leaves this device without approval.</span></div></div>
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
            <div className="context-heading"><span>LOCAL SUMMARY</span><b>{preview.redactions} redacted</b></div>
            <h3>{activeTitle}</h3>
            <p>{summary || 'No readable page text was found.'}</p>
          </div>
          <div className="permission-card">
            <div><Cloud size={17} /><strong>Cloud permission</strong></div>
            <p>Only the sanitized preview shown above can be passed to a connected AI provider.</p>
            {approved ? <div className="approved"><Check size={15} /> Approved for this request only</div> : <button className="primary-button" onClick={approve} disabled={loading}><ShieldCheck size={16} /> Approve context</button>}
          </div>
          <button className="text-button" onClick={() => setPreview(null)}>Clear page context</button>
        </>
      )}
    </div>
  );
}

function VaultPanel({ onToast }: { onToast: (message: string) => void }) {
  const [items, setItems] = useState<VaultItemMeta[]>([]);
  const [available, setAvailable] = useState(true);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<VaultItemInput>({ label: '', url: '', username: '', password: '', totpSecret: '' });
  const load = async () => {
    try { const result = await window.privateBrowser.listVault(); setItems(result.items); setAvailable(result.available); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { void load(); }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await window.privateBrowser.addVaultItem(form);
      setForm({ label: '', url: '', username: '', password: '', totpSecret: '' });
      setAdding(false);
      await load();
      onToast('Credential encrypted and saved');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error)); }
  };
  const reveal = async (id: string) => {
    try { const password = await window.privateBrowser.revealPassword(id); await window.privateBrowser.copyText(password); onToast('Password copied; clipboard is not synced'); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error)); }
  };
  const copyTotp = async (id: string) => {
    try { const { code } = await window.privateBrowser.getTotp(id); await window.privateBrowser.copyText(code); onToast(`Code ${code} copied`); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error)); }
  };
  return (
    <div className="side-panel">
      <PanelHeader icon={KeyRound} eyebrow="OS encrypted" title="Private vault" />
      <div className={`vault-health ${available ? '' : 'warning'}`}><ShieldCheck size={16} /><div><strong>{available ? 'Device encryption active' : 'Encryption unavailable'}</strong><span>Secrets never enter browser history or sync.</span></div></div>
      <button className="primary-button full" onClick={() => setAdding((value) => !value)} disabled={!available}><Plus size={16} /> Add credential</button>
      {adding && <form className="vault-form" onSubmit={submit}>
        <input placeholder="Name (e.g. Digitronics Admin)" required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
        <input placeholder="Website" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
        <input placeholder="Username or email" required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} />
        <input placeholder="Password" type="password" required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        <input placeholder="Authenticator secret (optional)" value={form.totpSecret} onChange={(e) => setForm({ ...form, totpSecret: e.target.value })} />
        <button className="primary-button" type="submit"><LockKeyhole size={15} /> Encrypt and save</button>
      </form>}
      <div className="credential-list">
        {items.map((item) => <div className="credential-card" key={item.id}>
          <div className="credential-top"><span className="site-badge">{item.label.slice(0, 1).toUpperCase()}</span><div><strong>{item.label}</strong><small>{domainFromUrl(item.url)} · {item.username}</small></div></div>
          <div className="credential-actions">
            <button onClick={() => void window.privateBrowser.autofill(item.id).then(() => onToast('Credential filled')).catch((error) => onToast(error.message))}><Zap size={14} /> Fill</button>
            <button onClick={() => void reveal(item.id)}><Copy size={14} /> Password</button>
            {item.hasTotp && <button onClick={() => void copyTotp(item.id)}><Clock3 size={14} /> Code</button>}
            <button className="danger" title="Delete" onClick={() => void window.privateBrowser.removeVaultItem(item.id).then(load)}><Trash2 size={14} /></button>
          </div>
        </div>)}
        {!items.length && !adding && <EmptyState icon={KeyRound} text="No credentials saved on this device." />}
      </div>
    </div>
  );
}

function AutomationPanel({ onToast }: { onToast: (message: string) => void }) {
  const [running, setRunning] = useState<string | null>(null);
  const run = async (automation: typeof AUTOMATIONS[number]) => {
    setRunning(automation.id);
    try {
      for (const url of automation.urls) await window.privateBrowser.newTab(automation.workspaceId, url);
      onToast(`${automation.name} opened`);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error)); }
    finally { setRunning(null); }
  };
  return <div className="side-panel"><PanelHeader icon={Zap} eyebrow="Safe routines" title="Automations" /><p className="panel-intro">Open complete work setups in isolated sessions. Publishing, payments and destructive actions are never automated.</p><div className="automation-list">{AUTOMATIONS.map((automation) => { const Icon = automation.icon; return <button className="automation-card" key={automation.id} onClick={() => void run(automation)}><span><Icon size={18} /></span><div><strong>{automation.name}</strong><small>{automation.description}</small></div>{running === automation.id ? <LoaderCircle className="spin" size={17} /> : <Play size={17} />}</button>; })}</div><div className="safety-note"><Shield size={16} /><p><strong>Approval boundary</strong><br />Messages, purchases, ads, deletion and account changes always require you.</p></div></div>;
}

function DownloadsPanel({ state, onToast }: { state: BrowserSnapshot; onToast: (message: string) => void }) {
  return <div className="side-panel"><PanelHeader icon={FileDown} eyebrow="This session" title="Downloads" /><div className="download-list">{state.downloads.map((item) => { const progress = item.totalBytes ? Math.round(item.receivedBytes / item.totalBytes * 100) : 0; return <div className="download-card" key={item.id}><div className="download-icon"><FileDown size={18} /></div><div className="download-body"><strong>{item.filename}</strong><small>{item.state === 'progressing' ? `${humanBytes(item.receivedBytes)} of ${humanBytes(item.totalBytes)}` : item.state}</small>{item.state === 'progressing' && <div className="progress"><span style={{ width: `${progress}%` }} /></div>}<div className="download-actions"><button onClick={() => void window.privateBrowser.openDownload(item.id).catch((error) => onToast(error.message))}>Open</button><button onClick={() => void window.privateBrowser.showDownload(item.id)}>Show folder</button></div></div></div>; })}{!state.downloads.length && <EmptyState icon={Download} text="Downloaded files will appear here." />}</div></div>;
}

function PrivacyPanel({ state }: { state: BrowserSnapshot }) {
  return <div className="side-panel"><PanelHeader icon={ShieldCheck} eyebrow="Transparent by design" title="Privacy log" /><div className="privacy-summary"><div><strong>{state.trackerBlocking ? 'On' : 'Off'}</strong><span>Tracker blocking</span></div><div><strong>5</strong><span>Isolated spaces</span></div><div><strong>{state.privacyLog.length}</strong><span>Logged events</span></div></div><div className="privacy-events">{state.privacyLog.map((event) => <div className="privacy-event" key={event.id}><span className={`event-dot ${event.kind}`} /><div><strong>{event.title}</strong><small>{event.detail}</small></div><time>{timeAgo(event.at)}</time></div>)}{!state.privacyLog.length && <EmptyState icon={ShieldCheck} text="Sensitive access events will be recorded here." />}</div></div>;
}

function EmptyState({ icon: Icon, text }: { icon: typeof Clock3; text: string }) {
  return <div className="empty-state"><Icon size={21} /><span>{text}</span></div>;
}
