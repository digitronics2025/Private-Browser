import { FormEvent, lazy, Suspense, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bookmark, Home, Search, Palette, Check, ChevronRight, Code2, Download, ExternalLink, Globe2, LoaderCircle, LockKeyhole, RefreshCw, Settings, Shield, ShieldCheck, Upload, TriangleAlert, X } from 'lucide-react';
import type { AccountSpaceId, BrowserSettings, BrowserSettingsPatch, BrowserSnapshot, ChromeImportResult, ChromeProfileSource, UpdateCheckResult, UpdateServiceInput, UpdateServiceStatus, UiPreferences, UiPreferencesPatch } from '../../electron/types';
import type { ChromeImportReview, ChromeSettingChoice, ChromeSettingsSelection, ManagedUpdateStatus } from '../../electron/types';
import { PanelHeader } from './common';
import { ChromePasswordImportWizard } from './ChromePasswordImportWizard';
import { formatReleaseDate, humanBytes, timeAgo } from '../lib/format';
import { DEFAULT_SPELLCHECK, MAX_SETTING_URL_LENGTH, MAX_SITE_KEYWORDS, MAX_STARTUP_PAGES, SEARCH_ENGINES, SPELLCHECK_LANGUAGES, type PresetSearchEngineId, type SpellcheckLanguage, type SpellcheckSettings } from '../../electron/browser-settings';
import type { Workspace } from '../../electron/types';
import { SetupGuide } from './SetupGuide';
import { IDLE_LOCK_MINUTES, MEMORY_SAVER_MINUTES } from '../../electron/ui-preferences';
import { AgentsPanel } from './AgentsPanel';
import { SafeDiagnostics } from './SafeDiagnostics';
import type { DiagnosticReason } from '../lib/safe-diagnostics';
import { Bot } from 'lucide-react';

const BrowsingPrivacySettings = lazy(() => import('./BrowsingPrivacySettings'));

const THEME_OPTIONS = [['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']] as const;
const BOOKMARK_BAR_OPTIONS = [['always', 'Always'], ['new-tab', 'New Tab only'], ['hidden', 'Hidden']] as const;
const HOME_PAGE_OPTIONS = [['new-tab', 'New Tab page'], ['url', 'Web address']] as const;
const STARTUP_OPTIONS = [['fresh', 'Start fresh'], ['ask', 'Ask whether to restore'], ['automatic', 'Restore automatically']] as const;
const CHROME_SETTINGS: Array<[ChromeSettingChoice, string]> = [['search', 'Search engine'], ['home', 'Home page'], ['startup', 'Startup settings']];
const SETTINGS_SEARCH_INDEX = [
  ['Search engine', 'setting-search-engine'], ['Home page', 'setting-home-page'],
  ['New tabs', 'setting-new-tabs'], ['On startup', 'setting-startup'],
  ['Startup pages', 'setting-startup'], ['Site keywords', 'setting-site-keywords'],
  ['Theme and appearance', 'setting-appearance'], ['Spellcheck and languages', 'setting-spellcheck'],
  ['Import from Chrome', 'setting-chrome-import'], ['Default browser', 'setting-default-browser'],
] as const;

export function SettingsPanel({ state, ui, settings, entry, fullView = false, onManageAccounts, onOpenVault, onOpenFull, onSetupExit, onUiChange, onToast }: {
  state: BrowserSnapshot;
  ui: UiPreferences;
  settings: BrowserSettings;
  entry: 'overview' | 'setup';
  fullView?: boolean;
  onManageAccounts: () => void;
  onOpenVault: () => void;
  onOpenFull: () => void;
  onSetupExit: () => void;
  onUiChange: (patch: UiPreferencesPatch) => void;
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const [isDefault, setIsDefault] = useState<boolean | null>(null);
  const [settingsPage, setSettingsPage] = useState<'overview' | 'updates' | 'setup' | 'agents' | 'passwords' | 'extensions'>(entry);
  const [settingsSearch, setSettingsSearch] = useState('');
  const [reviewPrivacy, setReviewPrivacy] = useState(false);
  useEffect(() => { if (entry === 'setup') setSettingsPage('setup'); }, [entry]);
  const [updateStatus, setUpdateStatus] = useState<UpdateServiceStatus | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [editingUpdates, setEditingUpdates] = useState(false);
  const [checking, setChecking] = useState(true);
  const [updateForm, setUpdateForm] = useState<UpdateServiceInput>({ endpoint: '', accessToken: '' });
  const [chromeProfiles, setChromeProfiles] = useState<ChromeProfileSource[]>([]);
  const [chromeProfileId, setChromeProfileId] = useState('');
  const [chromeAccountSpaceId, setChromeAccountSpaceId] = useState<AccountSpaceId | ''>('');
  const [chromeSettingsSelection, setChromeSettingsSelection] = useState<ChromeSettingsSelection>({});
  const [chromeBookmarks, setChromeBookmarks] = useState(true);
  const [chromeHistory, setChromeHistory] = useState(true);
  const [chromeImportOpen, setChromeImportOpen] = useState(false);
  const [chromeLoading, setChromeLoading] = useState(false);
  const [chromeResult, setChromeResult] = useState<ChromeImportResult | null>(null);
  const [chromeReview, setChromeReview] = useState<ChromeImportReview>();
  const chromeReviewRequest = useRef(0);
  const [chromeUndo, setChromeUndo] = useState(false);
  const [bookmarkHtmlResult, setBookmarkHtmlResult] = useState<{ imported: number; skipped: number }>();
  const chromeImportSection = useRef<HTMLDivElement>(null);
  const searchSection = useRef<HTMLDivElement>(null);
  const workspace = state.workspaces.find((item) => item.id === state.activeWorkspaceId)!;
  const currentTab = state.tabs.find((tab) => tab.id === state.activeTabId);
  const currentPageUrl = currentTab && !currentTab.isHome && /^https?:\/\//i.test(currentTab.url) && state.activeWorkspaceId !== 'banking' ? currentTab.url : undefined;
  const settingsResults = settingsSearch.trim() ? SETTINGS_SEARCH_INDEX.filter(([label, id]) =>
    label.toLowerCase().includes(settingsSearch.trim().toLowerCase())
    && (!workspace.protected || !['setting-home-page', 'setting-new-tabs', 'setting-startup', 'setting-site-keywords'].includes(id))) : [];
  const jumpToSetting = (id: string) => {
    const target = document.getElementById(id);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target?.querySelector<HTMLElement>('input, select, textarea, button')?.focus({ preventScroll: true });
  };
  const chromeDestinations = state.accountSpaces.filter((account) => account.workspaceId === state.activeWorkspaceId && account.workspaceId !== 'banking' && !account.locked);
  const chromeProfile = chromeProfiles.find((profile) => profile.id === chromeProfileId);
  const suggestedChromeDestination = chromeDestinations.find(({ id }) => id === chromeProfile?.suggestedAccountSpaceId);
  const importedChromeDestination = chromeDestinations.find(({ id }) => id === chromeProfile?.importedInto);
  const hasChromeSelection = chromeProfile && (chromeBookmarks && chromeProfile.hasBookmarks
    || chromeHistory && chromeProfile.hasHistory || chromeProfile.hasPreferences && Object.values(chromeSettingsSelection).some(Boolean));
  useEffect(() => {
    const id = chromeReview?.id;
    return () => { if (id) void window.privateBrowser.discardChromeImport(id).catch(() => undefined); };
  }, [chromeReview?.id]);
  useEffect(() => {
    chromeReviewRequest.current += 1;
    setChromeReview(undefined);
  }, [state.activeAccountSpaceId]);
  useEffect(() => {
    if (chromeAccountSpaceId && !chromeDestinations.some((account) => account.id === chromeAccountSpaceId)) setChromeAccountSpaceId('');
  }, [state.accountSpaces, state.activeAccountSpaceId, state.activeWorkspaceId, chromeAccountSpaceId]);
  useEffect(() => {
    setChromeUndo(false);
    if (!chromeImportOpen || !chromeAccountSpaceId || state.activeWorkspaceId === 'banking') return;
    let current = true;
    void window.privateBrowser.canUndoChromeImport(chromeAccountSpaceId).then((available) => {
      if (current) setChromeUndo(available);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [chromeAccountSpaceId, chromeImportOpen, state.activeWorkspaceId]);
  // null while the first status is still in flight — better than claiming
  // 'Active' before anything has been checked, which is what it used to do.
  const encryptionAvailable = updateStatus ? updateStatus.error !== 'os-encryption-unavailable' : null;
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void window.privateBrowser.getDefaultBrowserStatus().then((status) => {
        if (active) setIsDefault(status);
      }).catch(() => { if (active) setIsDefault(null); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener('focus', refresh); };
  }, []);
  useEffect(() => {
    void window.privateBrowser.getUpdateService().then((status) => {
      setUpdateStatus(status);
      setUpdateForm((value) => ({ ...value, endpoint: status.endpoint }));
    }).catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'));
    void window.privateBrowser.checkForUpdates()
      .then((result) => { setUpdateResult(result); setUpdateError(null); })
      .catch((error) => setUpdateError(error instanceof Error ? error.message : String(error)))
      .finally(() => setChecking(false));
  }, []);
  useEffect(() => {
    if (!chromeImportOpen) return;
    let current = true;
    setChromeProfiles([]);
    setChromeAccountSpaceId('');
    setChromeSettingsSelection({});
    setChromeLoading(true);
    void window.privateBrowser.listChromeProfiles().then((profiles) => {
      if (current) {
        setChromeProfiles(profiles);
        setChromeProfileId(profiles.find((profile) => profile.isDefault && !profile.imported)?.id
          ?? profiles.find((profile) => !profile.imported)?.id ?? profiles[0]?.id ?? '');
      }
    }, (error: unknown) => {
      if (current) onToast(error instanceof Error ? error.message : 'Could not read Chrome profiles', 'error');
    }).finally(() => { if (current) setChromeLoading(false); });
    return () => { current = false; };
  }, [chromeImportOpen, state.activeWorkspaceId]);
  const runDefaultBrowserAction = async (action: () => Promise<void>) => {
    try { await action(); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const configureUpdates = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const status = await window.privateBrowser.configureUpdateService(updateForm);
      setUpdateStatus(status);
      setUpdateForm({ endpoint: status.endpoint, accessToken: '' });
      setEditingUpdates(false);
      onToast('Private download service connected');
      await checkUpdates(false);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setUpdateForm((value) => ({ ...value, accessToken: '' })); }
  };
  const checkUpdates = async (notify = true) => {
    setChecking(true);
    setUpdateError(null);
    try {
      const result = await window.privateBrowser.checkForUpdates();
      setUpdateResult(result);
      if (notify) onToast(result.state === 'available' ? `Version ${result.latest.version} is available` : 'Private Browser is up to date');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateError(message);
      if (notify) onToast(message, 'error');
      return null;
    }
    finally { setChecking(false); }
  };
  const disconnectUpdates = async () => {
    try {
      const status = await window.privateBrowser.clearUpdateService();
      setUpdateStatus(status);
      setUpdateResult(null);
      setUpdateForm({ endpoint: status.endpoint, accessToken: '' });
      setEditingUpdates(false);
      onToast('Private download service disconnected');
      await checkUpdates(false);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const enrollThisDevice = async () => {
    try {
      const status = await window.privateBrowser.enrollUpdateDevice();
      if (!status) return;
      setUpdateStatus(status);
      setUpdateResult(null);
      setUpdateForm({ endpoint: status.endpoint, accessToken: '' });
      setEditingUpdates(false);
      onToast('This device is enrolled for private downloads.');
      await checkUpdates(false);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const openChromeImport = () => {
    setChromeResult(null);
    setChromeImportOpen(true);
  };
  const setChromeProfile = (id: string) => {
    setChromeProfileId(id);
    setChromeAccountSpaceId('');
    setChromeSettingsSelection({});
    setChromeResult(null);
  };
  const createChromeDestination = async () => {
    if (!chromeProfile || chromeProfile.imported) return;
    setChromeLoading(true);
    try {
      const label = chromeProfile.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'Chrome profile';
      const id = await window.privateBrowser.addLocalAccountSpace(workspace.id, label, 'indigo');
      setChromeAccountSpaceId(id);
    } catch (error) { onToast(error instanceof Error ? error.message : 'Could not create the Account Space', 'error'); }
    finally { setChromeLoading(false); }
  };
  const previewChrome = async () => {
    setChromeLoading(true);
    const request = ++chromeReviewRequest.current;
    try {
      const destination = state.accountSpaces.find((account) => account.id === chromeAccountSpaceId);
      if (!destination || destination.workspaceId === 'banking') throw new Error('Choose a non-Banking Account Space');
      setChromeResult(null);
      const review = await window.privateBrowser.previewChromeImport({
        profileId: chromeProfileId, workspaceId: destination.workspaceId, accountSpaceId: destination.id,
        bookmarks: chromeBookmarks && Boolean(chromeProfile?.hasBookmarks), history: chromeHistory && Boolean(chromeProfile?.hasHistory),
        settings: chromeProfile?.hasPreferences ? chromeSettingsSelection : undefined,
      });
      if (request === chromeReviewRequest.current) setChromeReview(review);
      else await window.privateBrowser.discardChromeImport(review.id);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setChromeLoading(false); }
  };
  const confirmChrome = async () => {
    if (!chromeReview) return;
    setChromeLoading(true);
    try {
      const result = await window.privateBrowser.confirmChromeImport(chromeReview.id);
      setChromeResult(result);
      if (result.imported.bookmarks + result.imported.history > 0 || result.appliedSettings?.length) {
        setChromeUndo(true);
        setChromeProfiles((current) => current.map((profile) => profile.id === chromeProfileId
          ? { ...profile, imported: true, importedInto: chromeReview.accountSpaceId } : profile));
        if (!ui.importedChromeData) onUiChange({ importedChromeData: true });
      }
      onToast(result.appliedSettings?.length ? 'Chrome import and selected workspace settings applied'
        : `Imported ${result.imported.bookmarks} bookmarks and ${result.imported.history} history entries`);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setChromeReview(undefined); setChromeLoading(false); }
  };
  const undoChrome = async () => {
    if (!chromeAccountSpaceId) return;
    setChromeLoading(true);
    try {
      const removed = await window.privateBrowser.undoChromeImport(chromeAccountSpaceId);
      setChromeUndo(false);
      setChromeResult(null);
      setChromeProfiles(await window.privateBrowser.listChromeProfiles());
      onToast(removed.settingsRestored ? 'Imported items removed and workspace settings restored'
        : `Removed ${removed.bookmarks} imported bookmarks and ${removed.history} history entries`);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setChromeLoading(false); }
  };
  const importBookmarkHtml = async () => {
    setChromeLoading(true);
    setBookmarkHtmlResult(undefined);
    try {
      const result = await window.privateBrowser.importBookmarkHtml(state.activeAccountSpaceId);
      if (!result) return;
      setBookmarkHtmlResult(result);
      onToast('Imported ' + result.imported + (result.imported === 1 ? ' bookmark.' : ' bookmarks.'));
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setChromeLoading(false); }
  };
  const exitSetup = () => {
    onSetupExit();
    setSettingsPage('overview');
  };
  if (settingsPage === 'setup') {
    return <SetupGuide state={state} isDefault={isDefault} firstLaunch={ui.offerSetupGuide}
      chromeImported={ui.importedChromeData} onAccounts={onManageAccounts} onVault={onOpenVault}
      onDefault={() => void runDefaultBrowserAction(window.privateBrowser.openDefaultBrowserSettings)}
      onPrivacy={() => {
        setReviewPrivacy(true);
        exitSetup();
      }}
      onSearch={() => {
        exitSetup();
        requestAnimationFrame(() => searchSection.current?.querySelector('select')?.focus());
      }}
      onImport={() => {
        exitSetup();
        void openChromeImport();
        requestAnimationFrame(() => chromeImportSection.current?.scrollIntoView({ block: 'nearest' }));
      }}
      onExit={exitSetup} onFinish={() => { onUiChange({ offerSetupGuide: false }); exitSetup(); }} />;
  }
  if (settingsPage === 'extensions' || settingsPage === 'passwords') {
    const passwords = settingsPage === 'passwords';
    const account = state.accountSpaces.find(item => item.id === state.activeAccountSpaceId);
    return <div className="side-panel">
      <button type="button" className="text-button" onClick={() => setSettingsPage('overview')}><ArrowLeft size={16} /> Settings</button>
      <PanelHeader icon={passwords ? LockKeyhole : Shield} eyebrow={account?.label ?? workspace.name} title={passwords ? 'Passwords' : 'Extensions'} />
      {passwords && state.activeWorkspaceId !== 'banking' ? <>
        <PasswordSettings key={state.activeAccountSpaceId} canImport={state.activeWorkspaceId !== 'development' && Boolean(account && !account.locked)} onOpenVault={onOpenVault} />
      </> : passwords ? <p>Choose an eligible Account Space to open Passwords.</p> : <section className="settings-card">
        <h3>Jumia + MarjaneMall Stock Checker</h3><strong>Version 0.5.2 · Blocked before activation</strong>
        <p>This version requests access across seller sites and saves an Accounting token in extension storage. Continue using the stock checker in Chrome.</p>
      </section>}
    </div>;
  }
  if (settingsPage === 'agents') return <AgentsPanel onBack={() => setSettingsPage('overview')} onToast={onToast} />;
  if (settingsPage === 'updates') {
    const runInstaller = (action: () => Promise<void>) => void action().catch((error: unknown) => {
      onToast(error instanceof Error ? error.message : String(error), 'error');
    });
    return <UpdatesPage
      status={updateStatus}
      result={updateResult}
      error={updateError}
      checking={checking}
      managed={state.managedUpdate}
      editingPrivate={editingUpdates}
      form={updateForm}
      onBack={() => { setUpdateForm((value) => ({ ...value, accessToken: '' })); setSettingsPage('overview'); }}
      onCheck={() => void checkUpdates()}
      onDownload={(version, sha256) => runInstaller(() => window.privateBrowser.downloadManagedUpdate(version, sha256))}
      onCancel={() => runInstaller(() => window.privateBrowser.cancelManagedUpdate())}
      onInstall={() => runInstaller(() => window.privateBrowser.installManagedUpdate())}
      onOpenDownload={() => void window.privateBrowser.openUpdatePage().catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'))}
      onOpenHistory={() => void window.privateBrowser.openReleaseHistory().catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'))}
      onOpenDeveloper={() => void window.privateBrowser.newTab('development', 'https://dr-badawi-abdalsalam.com/')}
      onEnroll={() => void enrollThisDevice()}
      onTogglePrivate={() => { setEditingUpdates((value) => !value); setUpdateForm((value) => ({ ...value, accessToken: '' })); }}
      onConfigure={configureUpdates}
      onFormChange={setUpdateForm}
      onDisconnect={() => void disconnectUpdates()}
    />;
  }
  return <div className="side-panel">
    <PanelHeader icon={Settings} eyebrow="Application" title="Settings" />
    {!fullView && <div className="panel-actions"><button type="button" onClick={onOpenFull}>Open full settings</button></div>}
    {fullView && <div className="settings-search">
      <label htmlFor="settings-search-input">Search settings</label>
      <input id="settings-search-input" type="search" value={settingsSearch} onChange={(event) => setSettingsSearch(event.target.value)} placeholder="Search Home, startup, theme…" />
      {settingsSearch.trim() && <div className="settings-search-results" role="region" aria-label="Matching settings" aria-live="polite">
        {settingsResults.length ? settingsResults.map(([label, id]) => <button type="button" key={label} onClick={() => jumpToSetting(id)}>{label}</button>) : <p>No matching settings.</p>}
      </div>}
    </div>}
    {state.activeWorkspaceId !== 'banking' && <div className="settings-card" id="setting-browser-setup">
      <div className="settings-row"><span><Settings size={17} /></span><div><strong>Browser setup</strong><small>Account Spaces, Chrome import, MyVault and optional services.</small></div>
        <button type="button" onClick={() => setSettingsPage('setup')}>Setup guide</button>
      </div>
    </div>}
    <div className="settings-card" id="setting-default-browser">
      <div className="settings-row"><span><Globe2 size={17} /></span><div><strong>Default browser</strong><small aria-live="polite">{isDefault === null ? 'Checking Windows association…' : isDefault ? 'Private Browser opens web links.' : 'Windows uses another browser for web links.'}</small></div>{isDefault && <b><Check size={14} /> Set</b>}</div>
      {!isDefault && <p className="import-note">In Windows Default apps, select Private Browser and choose Set default. If Windows lists individual link types, select Private Browser for HTTP and HTTPS.</p>}
      <div className="panel-actions">
        <button type="button" onClick={() => void runDefaultBrowserAction(window.privateBrowser.openDefaultBrowserSettings)}>Open Windows Default Apps</button>
        <button type="button" onClick={() => void runDefaultBrowserAction(window.privateBrowser.testDefaultBrowser)}>Test with a link</button>
      </div>
    </div>
    <div className="settings-card"><div className="panel-actions">
      {state.activeWorkspaceId !== 'banking' && <button type="button" onClick={() => setSettingsPage('passwords')}><LockKeyhole size={16} /> Passwords</button>}
      <button type="button" onClick={() => setSettingsPage('extensions')}><Shield size={16} /> Extensions</button>
    </div></div>
    <div ref={searchSection} className="workspace-behavior">
      <SearchHomeSettings key={workspace.id} workspace={workspace} settings={settings} currentPageUrl={currentPageUrl} onToast={onToast} />
    </div>
    <div id="setting-spellcheck"><WritingSettings key={workspace.id} workspace={workspace} writing={settings.spellcheck ?? DEFAULT_SPELLCHECK} available={state.availableSpellcheckLanguages} onToast={onToast} /></div>
    <div ref={chromeImportSection} id="setting-chrome-import" className="settings-card chrome-import-settings">
      <div className="settings-row"><span><Upload size={17} /></span><div><strong>Import from Chrome</strong><small>Bookmarks, bookmark folders and browsing history stay on this computer.</small></div><button onClick={() => {
        if (chromeImportOpen) { chromeReviewRequest.current += 1; setChromeReview(undefined); setChromeImportOpen(false); }
        else void openChromeImport();
      }}>{chromeImportOpen ? 'Close' : 'Import'}</button></div>
      {chromeImportOpen && <div className="chrome-import-form">
        {chromeReview ? <div className="import-review">
          <strong>Review Chrome import</strong>
          <p>Destination · {state.accountSpaces.find((account) => account.id === chromeReview.accountSpaceId)?.label ?? 'Account Space unavailable'}</p>
          <p>{chromeReview.result.imported.bookmarks} bookmarks · {chromeReview.result.imported.history} history entries to add</p>
          <p>{chromeReview.duplicates} duplicates · {chromeReview.unsupported} unsupported · {chromeReview.overLimit} over the storage limit</p>
          {chromeReview.historyRange && <p>History dates · {formatReleaseDate(chromeReview.historyRange.from)} to {formatReleaseDate(chromeReview.historyRange.through)}</p>}
          {chromeReview.settingsPatch && <div className="import-note">
            <strong>Settings for {workspace.name}</strong>
            {chromeReview.settingsPatch.searchEngine && chromeReview.settingsPatch.searchEngine !== 'custom'
              && <p>Search engine · {SEARCH_ENGINES[chromeReview.settingsPatch.searchEngine].label}</p>}
            {chromeReview.settingsPatch.homePage && <p>Home page · {chromeReview.settingsPatch.homePageUrl ?? 'New Tab'}</p>}
            {chromeReview.settingsPatch.startup && <p>On startup · {STARTUP_OPTIONS.find(([mode]) => mode === chromeReview.settingsPatch?.startup)?.[1]}</p>}
            {chromeReview.settingsPatch.startupPages?.length && <ul>{chromeReview.settingsPatch.startupPages.map((url) => <li key={url}>{url}</li>)}</ul>}
          </div>}
          {chromeReview.folders.length > 0 && <details>
            <summary>Bookmark folders</summary>
            <ul>{chromeReview.folders.map((folder) => <li key={JSON.stringify([folder.location, folder.path])}>
              {folder.location === 'bar' ? 'Bookmarks bar' : 'Other bookmarks'}{folder.path.length ? ' / ' + folder.path.join(' / ') : ''} · {folder.count}
            </li>)}</ul>
            {chromeReview.moreFolders > 0 && <p>{chromeReview.moreFolders} more folders</p>}
          </details>}
          {chromeReview.result.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          <div className="panel-actions">
            <button type="button" disabled={chromeLoading || (chromeReview.result.imported.bookmarks + chromeReview.result.imported.history === 0 && !chromeReview.settingsPatch)}
              onClick={() => void confirmChrome()}>Import selected data</button>
            <button type="button" disabled={chromeLoading} onClick={() => setChromeReview(undefined)}>Change selection</button>
          </div>
        </div> : chromeLoading && !chromeProfiles.length ? <div className="import-loading"><LoaderCircle className="spin" size={15} /> Detecting Chrome profiles…</div> : chromeProfiles.length > 0 ? <>
          <label><span>Chrome profile</span><select value={chromeProfileId} disabled={chromeLoading} onChange={(event) => setChromeProfile(event.target.value)}>{chromeProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}{profile.isDefault ? ' (Default)' : ''}{profile.imported ? ' · Imported' : ''}</option>)}</select></label>
          {chromeProfile?.imported && <p role="status">This Chrome profile has already been imported{importedChromeDestination ? ' into ' + importedChromeDestination.label : ''}.</p>}
          <label><span>Import into Account Space</span><select disabled={!chromeDestinations.length || chromeProfile?.imported || chromeLoading}
            value={chromeAccountSpaceId} onChange={(event) => setChromeAccountSpaceId(event.target.value as AccountSpaceId | '')}>
            <option value="">Choose a destination</option>
            {chromeDestinations.map((account) => <option value={account.id} key={account.id}>{account.label}</option>)}
          </select></label>
          {!chromeProfile?.imported && suggestedChromeDestination && <div className="panel-actions">
            <p className="import-note">Suggested destination · {suggestedChromeDestination.label}</p>
            <button type="button" disabled={chromeLoading} onClick={() => setChromeAccountSpaceId(suggestedChromeDestination.id)}>Use suggested destination</button>
          </div>}
          {chromeProfile && !chromeProfile.imported && !suggestedChromeDestination && chromeDestinations.length > 0
            && <button type="button" className="secondary-button" disabled={chromeLoading} onClick={() => void createChromeDestination()}>Create an Account Space for this profile</button>}
          {!chromeDestinations.length && <p className="import-note">Chrome data cannot be imported into Banking. Switch to another workspace first.</p>}
          <div className="import-checks">
            <label><input type="checkbox" disabled={!chromeProfile?.hasBookmarks || chromeProfile.imported} checked={Boolean(chromeProfile?.hasBookmarks && chromeBookmarks)} onChange={(event) => setChromeBookmarks(event.target.checked)} /> <span><strong>Bookmarks</strong><small>Includes the full Chrome bookmarks bar and folder hierarchy.</small></span></label>
            <label><input type="checkbox" disabled={!chromeProfile?.hasHistory || chromeProfile.imported} checked={Boolean(chromeProfile?.hasHistory && chromeHistory)} onChange={(event) => setChromeHistory(event.target.checked)} /> <span><strong>Browsing history</strong><small>Up to 10,000 recent Chrome pages.</small></span></label>
          </div>
          {chromeProfile?.hasPreferences && !chromeProfile.imported && <fieldset className="import-checks">
            <legend>Optional settings for {workspace.name}</legend>
            {CHROME_SETTINGS.map(([key, label]) => <label key={key}><input type="checkbox" checked={Boolean(chromeSettingsSelection[key])}
              onChange={(event) => setChromeSettingsSelection((selection) => ({ ...selection, [key]: event.target.checked }))} /> <span>{label}</span></label>)}
          </fieldset>}
          <button className="primary-button full" disabled={chromeLoading || !chromeAccountSpaceId || !hasChromeSelection || chromeProfile?.imported} onClick={() => void previewChrome()}>{chromeLoading ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />} Preview import</button>
        </> : !chromeLoading ? <p className="import-note">{state.activeWorkspaceId === 'banking'
          ? 'Chrome data cannot be imported into Banking. Switch to another workspace first.'
          : 'Choose a bookmark HTML export below, or open Chrome once to create a local profile.'}</p> : null}
        <div className="password-import-row"><div><strong>Bookmark HTML file</strong><small>Imports saved web addresses and folders into the current Account Space.</small></div>
          <button type="button" disabled={chromeLoading || state.activeWorkspaceId === 'banking'} onClick={() => void importBookmarkHtml()}>Choose HTML</button>
        </div>
        {bookmarkHtmlResult && <p className="import-note" role="status">{bookmarkHtmlResult.imported} {bookmarkHtmlResult.imported === 1 ? 'bookmark' : 'bookmarks'} imported · {bookmarkHtmlResult.skipped} skipped</p>}
        {chromeUndo && <div className="panel-actions">
          <button type="button" disabled={chromeLoading} onClick={() => void undoChrome()}>Undo last Chrome import</button>
          <small className="import-note">Available this session. Bookmarks and workspace settings you edited stay.</small>
        </div>}
        <ChromePasswordImportWizard key={state.activeAccountSpaceId} buttonLabel="Choose CSV"
          disabled={chromeLoading || state.activeWorkspaceId === 'banking' || state.activeWorkspaceId === 'development'} />
        <p className="import-limit"><Shield size={13} /> Cookies, signed-in sessions, payment cards, extensions and Chrome account tokens are intentionally not copied.</p>
        {chromeResult && <div className="import-result"><Check size={15} /><div><strong>Import complete</strong><small>{chromeResult.imported.bookmarks} bookmarks · {chromeResult.imported.history} history · {chromeResult.imported.passwords} passwords</small>{chromeResult.skipped.bookmarks + chromeResult.skipped.history + chromeResult.skipped.passwords > 0 && <small>{chromeResult.skipped.bookmarks + chromeResult.skipped.history + chromeResult.skipped.passwords} duplicate or unsafe entries skipped</small>}{chromeResult.warnings.map((warning) => <small className="warning" key={warning}>{warning}</small>)}</div></div>}
      </div>}
    </div>
    <div className="settings-card" id="setting-appearance"><div className="settings-row"><span><Palette size={17} /></span><div><strong>Appearance</strong><small>Theme for the browser frame, menus and the New Tab page.</small></div></div>
      <div className="segmented" role="radiogroup" aria-label="Theme">{THEME_OPTIONS.map(([theme, label]) => <button type="button" key={theme} role="radio" aria-checked={ui.theme === theme} className={ui.theme === theme ? 'active' : ''} onClick={() => onUiChange({ theme })}>{label}</button>)}</div>
    </div>
    <fieldset className="settings-card screen-privacy-settings">
      <legend>Screen privacy</legend>
      <label><input type="checkbox" checked={Boolean(ui.lockOnWindowsSession)}
        onChange={(event) => onUiChange({ lockOnWindowsSession: event.currentTarget.checked })} /> Lock Private Browser when Windows locks</label>
      <label>Lock after device inactivity
        <select value={ui.idleLockMinutes ?? 0} onChange={(event) => onUiChange({ idleLockMinutes: Number(event.currentTarget.value) })}>
          {IDLE_LOCK_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{minutes ? minutes + ' minutes' : 'Off'}</option>)}
        </select>
      </label>
      <p>Locking closes live pages and side apps, locks MyVault, and disconnects Developer Bridge and Agent Mode. Tabs reload after Windows unlocks.</p>
      <label><input type="checkbox" checked={Boolean(ui.maskTodayIdentity)}
        onChange={(event) => onUiChange({ maskTodayIdentity: event.currentTarget.checked })} /> Mask Account Space identity on New Tab</label>
      <p>Hides the Account Space label, avatar, bookmarks, shortcuts and recent pages while New Tab is open.</p>
    </fieldset>
    <fieldset className="settings-card screen-privacy-settings">
      <legend>Memory Saver</legend>
      <label>Sleep inactive tabs after
        <select value={ui.memorySaverMinutes ?? 0} onChange={(event) => onUiChange({ memorySaverMinutes: Number(event.currentTarget.value) })}>
          {MEMORY_SAVER_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{minutes ? minutes + ' minutes' : 'Off'}</option>)}
        </select>
      </label>
      <p>Eligible inactive pages reload when selected. Use Site information to keep a site awake in its Account Space.</p>
    </fieldset>
    <Suspense fallback={null}><BrowsingPrivacySettings state={state} onToast={onToast} reveal={reviewPrivacy} onReveal={() => setReviewPrivacy(false)} /></Suspense>
    <div className="settings-card"><div className="settings-row"><span><Bookmark size={17} /></span><div><strong>Bookmarks bar</strong><small>Where the bookmarks bar appears. Shortcut: Ctrl+Shift+B.</small></div></div>
      <div className="segmented" role="radiogroup" aria-label="Bookmarks bar">{BOOKMARK_BAR_OPTIONS.map(([mode, label]) => <button type="button" key={mode} role="radio" aria-checked={ui.bookmarkBarMode === mode} className={ui.bookmarkBarMode === mode ? 'active' : ''} onClick={() => onUiChange({ bookmarkBarMode: mode })}>{label}</button>)}</div>
    </div>
    <div className="settings-card update-settings"><div className="settings-row"><span><RefreshCw size={17} /></span><div><strong>App updates</strong><small>{checking ? 'Checking the latest stable release…' : updateError ? 'Latest-version check unavailable' : updateResult?.state === 'available' ? `Version ${updateResult.latest.version} is ready` : `Version ${updateResult?.currentVersion ?? updateStatus?.currentVersion ?? ''} is current`}</small></div>{checking ? <b className="pending"><LoaderCircle className="spin" size={13} /> Checking</b> : updateError ? <button onClick={() => setSettingsPage('updates')}>Review</button> : updateResult?.state === 'available' ? <button className="update-ready-button" onClick={() => setSettingsPage('updates')}>Update</button> : <button onClick={() => setSettingsPage('updates')}>Open</button>}</div></div>
    <div className="settings-card"><div className="settings-row"><span><ShieldCheck size={17} /></span><div><strong>Security baseline</strong><small>Sandboxed pages, isolated sessions, strict IPC and encrypted secrets.</small></div>{encryptionAvailable === null ? <b className="pending">Checking…</b> : encryptionAvailable ? <b><Check size={14} /> Active</b> : <b className="failing"><X size={14} /> Encryption unavailable</b>}</div></div>
    <div className="settings-card"><div className="settings-row"><span><Bot size={17} /></span><div><strong>Agents</strong><small>Claude Code and Codex</small></div><button onClick={() => setSettingsPage('agents')}>Open Agents</button></div></div>
    <div className="about-card"><span><ShieldCheck size={23} /></span><div><strong>Private Browser</strong><small>{updateStatus?.currentVersion ? `Version ${updateStatus.currentVersion} · Digitronics` : 'Digitronics'}</small></div></div>
  </div>;
}

interface UpdatesPageProps {
  status: UpdateServiceStatus | null;
  result: UpdateCheckResult | null;
  error: string | null;
  checking: boolean;
  managed?: ManagedUpdateStatus;
  editingPrivate: boolean;
  form: UpdateServiceInput;
  onBack: () => void;
  onCheck: () => void;
  onDownload: (version: string, sha256: string) => void;
  onCancel: () => void;
  onInstall: () => void;
  onOpenDownload: () => void;
  onOpenHistory: () => void;
  onOpenDeveloper: () => void;
  onTogglePrivate: () => void;
  onEnroll: () => void;
  onConfigure: (event: FormEvent) => void;
  onFormChange: (value: UpdateServiceInput) => void;
  onDisconnect: () => void;
}

function UpdatesPage({ status, result, error, checking, managed, editingPrivate, form, onBack, onCheck, onDownload, onCancel, onInstall, onOpenDownload, onOpenHistory, onOpenDeveloper, onTogglePrivate, onEnroll, onConfigure, onFormChange, onDisconnect }: UpdatesPageProps) {
  const latest = result?.latest;
  const available = result?.state === 'available';
  const state = checking ? 'checking' : error ? 'error' : available ? 'available' : result ? 'current' : 'checking';
  const title = state === 'checking' ? 'Checking for updates…' : state === 'error' ? 'Could not verify the latest version' : state === 'available' ? `Version ${latest?.version} is available` : 'Private Browser is up to date';
  const description = state === 'checking'
    ? 'Comparing this installation with the latest stable release in D1.'
    : state === 'error'
      ? error ?? 'The update service could not be reached.'
      : state === 'available'
        ? managed ? 'Download the installer here and choose when to open it.'
          : 'A newer Windows installer is ready on the download page. Its checksum is checked before Private Browser will open it.'
        : `Version ${result?.currentVersion ?? status?.currentVersion ?? '—'} is the latest stable release.`;
  const installerFailure = managed?.phase === 'failed' ? managed.failure : undefined;
  const updateDiagnostic = state === 'error' ? 'PB-UPDATE-CHECK' : installerFailure && installerDiagnostics[installerFailure];

  return <div className="side-panel updates-page" data-testid="updates-page">
    <button className="updates-back" aria-label="Back to Settings" onClick={onBack}><ArrowLeft size={14} /> Settings</button>
    <PanelHeader icon={RefreshCw} eyebrow="Stable release channel" title="App updates" />
    <section className={`updates-hero state-${state}`} aria-live="polite" aria-busy={checking}>
      <span className="updates-status-icon">{state === 'checking' ? <LoaderCircle className="spin" size={22} /> : state === 'error' ? <TriangleAlert size={22} /> : state === 'available' ? <Download size={22} /> : <ShieldCheck size={22} />}</span>
      <small>{state === 'available' ? 'UPDATE AVAILABLE' : state === 'current' ? 'YOU HAVE THE LATEST VERSION' : state === 'error' ? 'CHECK INCOMPLETE' : 'CHECKING CLOUD RELEASE'}</small>
      <h3>{title}</h3>
      <p>{description}</p>
      <div className="version-comparison" aria-label="Installed and latest versions">
        <span><small>Installed</small><strong>v{result?.currentVersion ?? status?.currentVersion ?? '—'}</strong></span>
        <ChevronRight size={15} />
        <span><small>Latest stable</small><strong>{latest ? `v${latest.version}` : 'Checking…'}</strong></span>
      </div>
      {managed && <ManagedInstallerStatus status={managed} />}
      {updateDiagnostic && <SafeDiagnostics reason={updateDiagnostic} />}
      <div className="updates-primary-actions">
        {state === 'available' && !managed && !status?.deviceEnrolled && <button className="updates-primary" onClick={onOpenDownload}><Download size={15} /> Open verified download</button>}
        {state === 'available' && managed && latest && <>
          {managed.phase === 'ready' && managed.version === latest.version
            ? <button className="updates-primary" onClick={onInstall}>Install when ready</button>
            : ['idle', 'failed', 'installed'].includes(managed.phase) || (managed.phase === 'ready' && managed.version !== latest.version)
              ? <button className="updates-primary" onClick={() => onDownload(latest.version, latest.sha256)}><Download size={15} /> Download update</button>
              : null}
          {['preparing', 'downloading'].includes(managed.phase) && <button className="updates-secondary" onClick={onCancel}>Cancel download</button>}
          {managed.phase === 'failed' && <button className="updates-secondary" onClick={onCheck}><RefreshCw size={15} /> Check again</button>}
          {!status?.deviceEnrolled && <button className="updates-secondary" onClick={onOpenDownload}><ExternalLink size={14} /> Release page</button>}
        </>}
        {state === 'current' && <button className="updates-primary" onClick={onCheck}><RefreshCw size={15} /> Check again</button>}
        {state === 'error' && <button className="updates-primary" onClick={onCheck}><RefreshCw size={15} /> Try again</button>}
        {state !== 'available' && state !== 'checking' && !status?.deviceEnrolled && <button className="updates-secondary" onClick={onOpenDownload}><ExternalLink size={14} /> Release page</button>}
      </div>
    </section>

    {latest && <section className="updates-detail-card" aria-labelledby="release-details-title">
      <div className="updates-section-heading"><div><small>RELEASE DETAILS</small><h3 id="release-details-title">Private Browser {latest.version}</h3></div><span>Build {latest.buildNumber}</span></div>
      <dl className="release-metadata">
        <div><dt>Published</dt><dd><time dateTime={latest.publishedAt}>{formatReleaseDate(latest.publishedAt)}</time></dd></div>
        <div><dt>Installer</dt><dd>{humanBytes(latest.sizeBytes)} · Windows x64</dd></div>
        <div><dt>Source</dt><dd><code>{latest.commitSha.slice(0, 12)}</code></dd></div>
      </dl>
      <div className="release-notes">
        <small>{state === 'available' ? 'WHAT CHANGED SINCE YOUR VERSION' : 'LATEST RELEASE HIGHLIGHTS'}</small>
        {state === 'available' && <p>Highlights from version {latest.version}. See release history for earlier versions.</p>}
        <p>{latest.releaseNotes || 'No highlights were published for this release.'}</p>
        {!status?.deviceEnrolled && <button className="text-button" type="button" onClick={onOpenHistory}><ExternalLink size={14} /> Release history</button>}
      </div>
      <div className="release-checksum"><ShieldCheck size={14} /><div><small>SHA-256 CHECKSUM</small><code>{latest.sha256}</code></div></div>
      <p className="updates-verified-note">Private Browser remembers this checksum and verifies the downloaded installer before it can be opened.</p>
      <small className="updates-checked-at">Checked {timeAgo(result.checkedAt)} · Automatically checked every 24 hours</small>
    </section>}

    <section className="updates-detail-card developer-update-card">
      <span><Code2 size={17} /></span><div><small>DEVELOPER</small><strong>Dr. Badawi Abdalsalam</strong><p>Software Architect · Casablanca, Morocco</p></div><button aria-label="Open developer website" onClick={onOpenDeveloper}><ExternalLink size={14} /></button>
    </section>

    <section className="updates-private-card">
      <div className="updates-private-heading"><div><strong>Private downloads</strong><p>{status?.deviceEnrolled ? 'Windows protects this device’s credential.' : status?.configured ? 'Using the configured access token.' : 'Use a one-time code from the release owner to enroll this device.'}</p></div><span className={status?.configured ? 'connected' : ''}>{status?.deviceEnrolled ? 'Device enrolled' : status?.configured ? 'Connected' : 'Public'}</span></div>
      {status?.error && <p className="updates-private-error">{status.error === 'configuration-corrupt' ? 'The saved private configuration is unreadable. Public checks remain available.' : 'Windows encryption is unavailable, so private credentials cannot be stored.'}</p>}
      {editingPrivate && <form className="update-form" onSubmit={onConfigure}>
        <input aria-label="Private update service URL" type="url" required placeholder="https://private-browser-downloads.example.workers.dev" value={form.endpoint} onChange={(event) => onFormChange({ ...form, endpoint: event.target.value })} />
        <input aria-label="Private download access token" type="password" required minLength={32} placeholder="Download access token" value={form.accessToken} onChange={(event) => onFormChange({ ...form, accessToken: event.target.value })} />
        <button className="primary-button" type="submit"><LockKeyhole size={14} /> Encrypt and connect</button>
      </form>}
      <div className="update-actions">
        {!status?.deviceEnrolled && <button type="button" onClick={onEnroll}>Enroll this device</button>}
        <button onClick={onTogglePrivate}>{editingPrivate ? 'Cancel' : status?.configured ? 'Change service' : 'Connect private service'}</button>
        {status?.configured && <button className="danger" onClick={onDisconnect}>Disconnect</button>}
      </div>
    </section>
  </div>;
}

const installerDiagnostics = {
  release: 'PB-UPDATE-RELEASE',
  verification: 'PB-UPDATE-VERIFY',
  storage: 'PB-UPDATE-SAVE',
  launch: 'PB-UPDATE-OPEN',
  cancelled: undefined,
} satisfies Record<NonNullable<ManagedUpdateStatus['failure']>, DiagnosticReason | undefined>;

function ManagedInstallerStatus({ status }: { status: ManagedUpdateStatus }) {
  switch (status.phase) {
    case 'idle': return null;
    case 'preparing': return <p role="status">Checking the release before downloading…</p>;
    case 'downloading': return <div>
      <progress aria-label="Installer download" value={status.receivedBytes ?? 0} max={status.totalBytes || 1} />
      <p>{humanBytes(status.receivedBytes ?? 0)} of {humanBytes(status.totalBytes ?? 0)}</p>
    </div>;
    case 'verifying': return <p role="status">Verifying the installer…</p>;
    case 'ready': return <div>
      <p role="status">Checksum verified. Save your work before opening the installer. Private Browser may close during installation.</p>
      {status.publisher?.state === 'valid' && <p>Windows verified the publisher{status.publisher.name ? ' ' + status.publisher.name : ''}.</p>}
      {status.publisher?.state === 'unsigned' && <p>Windows found no publisher signature.</p>}
      {status.publisher?.state === 'untrusted' && <p>Windows did not verify the publisher signature.</p>}
      {status.publisher?.state === 'unavailable' && <p>Windows publisher verification is unavailable.</p>}
    </div>;
    case 'launched': return <p role="status">Follow the Windows installer. After it finishes, reopen Private Browser.</p>;
    case 'installed': return <p role="status">Version {status.version} is installed.</p>;
    case 'failed': return <p role="alert">{status.message ?? 'The update could not be completed.'}</p>;
  }
}

/**
 * Search engine, Home page and startup. The main process validates and normalizes
 * every value; a refusal comes back as a toast and the typed text stays put.
 */
function WritingSettings({ workspace, writing, available, onToast }: {
  workspace: Workspace;
  writing: SpellcheckSettings;
  available: SpellcheckLanguage[];
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const [saving, setSaving] = useState(false);
  const languages = writing.languages.filter((language) => available.includes(language));
  const save = async (next: SpellcheckSettings) => {
    setSaving(true);
    try {
      await window.privateBrowser.setBrowserSettings({ spellcheck: { ...next, languages: next.languages.filter((language) => available.includes(language)) } }, workspace.id);
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not save spellcheck settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return <fieldset className="settings-card writing-settings" aria-describedby="spelling-description" disabled={saving}>
    <legend>Spellcheck</legend>
    <p id="spelling-description">Checks spelling on this device. The browser may download dictionaries. These choices apply to {workspace.name}.</p>
    <label><input type="checkbox" checked={writing.enabled} onChange={(event) => void save({ ...writing, enabled: event.target.checked })} /> Check spelling</label>
    {writing.enabled && <div className="writing-languages" role="group" aria-label="Spellcheck languages">
      {(Object.entries(SPELLCHECK_LANGUAGES) as [SpellcheckLanguage, string][]).map(([value, label]) => {
        const supported = available.includes(value);
        return <label key={value}><input type="checkbox" checked={languages.includes(value)} disabled={!supported} onChange={(event) => {
          const existing = languages.filter((language) => language !== value);
          void save({ ...writing, languages: event.target.checked ? [...existing, value] : existing });
        }} /> {label}{!supported && ' (unavailable on this device)'}</label>;
      })}
      {languages.length > 0 ? <button type="button" onClick={() => void save({ ...writing, languages: [] })}>Use Windows languages</button>
        : <small>Using Windows languages</small>}
    </div>}
  </fieldset>;
}

function SearchHomeSettings({ workspace, settings, currentPageUrl, onToast }: { workspace: Workspace; settings: BrowserSettings; currentPageUrl?: string; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [customOpen, setCustomOpen] = useState(settings.searchEngine === 'custom');
  const [template, setTemplate] = useState(settings.customSearchTemplate ?? '');
  const [homeEditing, setHomeEditing] = useState(settings.homePage === 'url');
  const [homeUrl, setHomeUrl] = useState(settings.homePageUrl ?? '');
  const [newTabEditing, setNewTabEditing] = useState(settings.newTab === 'url');
  const [newTabUrl, setNewTabUrl] = useState(settings.newTabUrl ?? '');
  const [startupEditing, setStartupEditing] = useState(false);
  const storedPages = settings.startupPages?.join('\n') ?? '';
  const storedKeywords = settings.siteKeywords?.map(({ keyword, template }) => keyword + ' ' + template).join('\n') ?? '';
  const [pages, setPages] = useState(storedPages);
  const [keywords, setKeywords] = useState(storedKeywords);
  useEffect(() => { setCustomOpen(settings.searchEngine === 'custom'); setTemplate(settings.customSearchTemplate ?? ''); }, [settings.searchEngine, settings.customSearchTemplate]);
  useEffect(() => { setHomeEditing(settings.homePage === 'url'); setHomeUrl(settings.homePageUrl ?? ''); }, [settings.homePage, settings.homePageUrl]);
  useEffect(() => { setNewTabEditing(settings.newTab === 'url'); setNewTabUrl(settings.newTabUrl ?? ''); }, [settings.newTab, settings.newTabUrl]);
  useEffect(() => { setPages(storedPages); }, [storedPages]);
  useEffect(() => setKeywords(storedKeywords), [storedKeywords]);
  const save = async (patch: BrowserSettingsPatch, done?: string) => {
    try {
      await window.privateBrowser.setBrowserSettings(patch, workspace.id);
      if (done) onToast(done);
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const chooseEngine = (value: string) => {
    if (value === 'custom') { setCustomOpen(true); return; }
    setCustomOpen(false);
    void save({ searchEngine: value as PresetSearchEngineId });
  };
  const saveTemplate = (event: FormEvent) => { event.preventDefault(); void save({ searchEngine: 'custom', customSearchTemplate: template }, 'Search engine saved'); };
  const saveHome = (event: FormEvent) => { event.preventDefault(); void save({ homePage: 'url', homePageUrl: homeUrl }, 'Home page saved'); };
  const saveNewTabUrl = (event: FormEvent) => { event.preventDefault(); void save({ newTab: 'url', newTabUrl }, 'New Tab address saved'); };
  const savePages = (event: FormEvent) => {
    event.preventDefault();
    void save({ startupPages: pages.split('\n').map((line) => line.trim()).filter(Boolean) }, 'Startup pages saved');
  };
  const saveKeywords = (event: FormEvent) => {
    event.preventDefault();
    const siteKeywords = keywords.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [, keyword = '', template = ''] = /^(\S+)\s+(.+)$/.exec(line) ?? [];
      return { keyword, template };
    });
    void save({ siteKeywords }, 'Site keywords saved');
  };
  return <>
    <div className="settings-card" id="setting-search-engine"><div className="settings-row"><span><Search size={17} /></span><div><strong>Search engine</strong><small>Used for address-bar searches in {workspace.name}.</small></div></div>
      <label className="settings-field"><span>Search with</span><select aria-label="Search engine" value={customOpen ? 'custom' : settings.searchEngine} onChange={(event) => chooseEngine(event.target.value)}>
        {(Object.keys(SEARCH_ENGINES) as PresetSearchEngineId[]).map((id) => <option value={id} key={id}>{SEARCH_ENGINES[id].label}</option>)}
        <option value="custom">Custom…</option>
      </select></label>
      {customOpen && <form className="settings-inline-form" onSubmit={saveTemplate}>
        <input aria-label="Custom search address" inputMode="url" required maxLength={2048} placeholder="https://search.example.com/?q=%s" value={template} onChange={(event) => setTemplate(event.target.value)} spellCheck={false} />
        <button type="submit" aria-label="Save search address">Save</button>
        <small>Must start with https:// and contain %s where the search words go.</small>
      </form>}
    </div>
    {workspace.protected ? <p className="import-note">Banking opens the local New Tab page. Startup pages and site keywords are unavailable here.</p> : <>
    <div className="settings-card" id="setting-home-page"><div className="settings-row"><span><Home size={17} /></span><div><strong>Home page</strong><small>What Home and Alt+Home open in {workspace.name}.</small></div></div>
      <div className="segmented" role="radiogroup" aria-label="Home page">{HOME_PAGE_OPTIONS.map(([mode, label]) => { const active = (homeEditing ? 'url' : settings.homePage) === mode; return <button type="button" key={mode} role="radio" aria-checked={active} className={active ? 'active' : ''} onClick={() => { if (mode === 'url') { setHomeEditing(true); return; } setHomeEditing(false); void save({ homePage: 'new-tab' }); }}>{label}</button>; })}</div>
      {homeEditing && <form className="settings-inline-form" onSubmit={saveHome}>
        <input aria-label="Home page address" inputMode="url" required maxLength={2048} placeholder="tenten.ma" value={homeUrl} onChange={(event) => setHomeUrl(event.target.value)} spellCheck={false} />
        <button type="submit" aria-label="Save Home page">Save</button>
      </form>}
      {homeEditing && currentPageUrl && <button type="button" className="secondary-button" onClick={() => { setHomeUrl(currentPageUrl); void save({ homePage: 'url', homePageUrl: currentPageUrl }, 'Home page saved'); }}>Use current page</button>}
    </div>
    <div className="settings-card" id="setting-new-tabs"><div className="settings-row"><span><Home size={17} /></span><div><strong>New tabs</strong><small>Used by the plus button, Ctrl+T and the browser menu in {workspace.name}.</small></div></div>
      <div className="segmented" role="radiogroup" aria-label="New tabs">{([['start', 'Start page'], ['blank', 'Blank tab'], ['url', 'Web address']] as const).map(([mode, label]) => {
        const selected = (newTabEditing ? 'url' : settings.newTab) === mode;
        return <button type="button" key={mode} role="radio" aria-checked={selected} className={selected ? 'active' : ''} onClick={() => {
          if (mode === 'url') { setNewTabEditing(true); return; }
          setNewTabEditing(false); void save({ newTab: mode });
        }}>{label}</button>;
      })}</div>
      {newTabEditing && <form className="settings-inline-form" onSubmit={saveNewTabUrl}>
        <input aria-label="New Tab address" inputMode="url" required maxLength={2048} placeholder="example.com" value={newTabUrl} onChange={(event) => setNewTabUrl(event.target.value)} spellCheck={false} />
        <button type="submit" aria-label="Save New Tab address">Save</button>
      </form>}
    </div>
    <div className="settings-card" id="setting-startup"><div className="settings-row"><span><RefreshCw size={17} /></span><div><strong>On startup</strong><small>Applies on the next cold launch of {workspace.name}.</small></div></div>
      <div className="segmented" role="radiogroup" aria-label="On startup">{STARTUP_OPTIONS.map(([mode, label]) => {
        const selected = settings.startup === mode;
        return <button type="button" key={mode} role="radio" aria-checked={selected} className={selected ? 'active' : ''} onClick={() => {
          setStartupEditing(false);
          void save({ startup: mode });
        }}>{label}</button>;
      })}</div>
      <label><input type="checkbox" checked={settings.startupHome === true} onChange={(event) => void save({ startupHome: event.target.checked })} /> Also open Home after the startup decision</label>
      <label><input type="checkbox" checked={settings.startupNewTab === true} onChange={(event) => void save({ startupNewTab: event.target.checked })} /> Also open a New Tab after the startup decision</label>
      <button type="button" className="secondary-button" onClick={() => setStartupEditing((value) => !value)}>{startupEditing ? 'Hide startup pages' : 'Edit startup pages'}</button>
      {startupEditing && <form className="workspace-settings-form" onSubmit={savePages}>
        <label>Startup addresses<textarea rows={3} maxLength={MAX_STARTUP_PAGES * (MAX_SETTING_URL_LENGTH + 1)}
          value={pages} onChange={(event) => setPages(event.currentTarget.value)} spellCheck={false} /></label>
        <small>Enter one web address per line. Up to eight pages.</small>
        <button type="submit" className="secondary-button" disabled={!pages.trim()}>Save startup pages</button>
      </form>}
    </div>
    <div className="settings-card" id="setting-site-keywords">
      <div className="settings-row"><span><Globe2 size={17} /></span><div><strong>Site keywords</strong><small>Type a keyword and your search words, then press Enter.</small></div></div>
      <form className="workspace-settings-form" onSubmit={saveKeywords}>
        <label>Keywords and search addresses<textarea rows={3} maxLength={MAX_SITE_KEYWORDS * (MAX_SETTING_URL_LENGTH + 18)}
          value={keywords} onChange={(event) => setKeywords(event.currentTarget.value)}
          placeholder="gh https://github.com/search?q=%s" spellCheck={false} /></label>
        <small>Enter one keyword and HTTPS search address per line. Use %s for the search words.</small>
        <button type="submit" className="secondary-button">Save site keywords</button>
      </form>
    </div>
    </>}
  </>;
}


function PasswordSettings({ canImport, onOpenVault }: { canImport: boolean; onOpenVault: () => void }) {
  const [vault, setVault] = useState<'checking' | 'ready' | 'locked' | 'unavailable'>('checking');
  const [launch, setLaunch] = useState<'idle' | 'opening' | 'requested' | 'failed'>('idle');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!canImport) return;
    let current = true;
    void window.privateBrowser.listVault().then(status => {
      if (current) setVault(status.lifecycle === 'unlocked' ? 'ready' : 'locked');
    }).catch(() => { if (current) setVault('unavailable'); });
    return () => { current = false; };
  }, [canImport]);
  async function openChrome() {
    setLaunch('opening');
    try {
      await window.privateBrowser.openGooglePasswordManager();
      setLaunch('requested');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chrome could not open.');
      setLaunch('failed');
    }
  }
  return <>
    <section className="settings-card">
      <h3>Google Password Manager</h3><p>Open your live Google vault in Chrome. Choose Work in Chrome’s profile menu if needed.</p>
      <button type="button" disabled={launch === 'opening'} onClick={() => void openChrome()}>Open Google Password Manager</button>
      <p role="status">{launch === 'opening' ? 'Opening Chrome…' : launch === 'requested' ? 'Chrome launch requested. Complete sign-in in Chrome.' : ''}</p>
      {launch === 'failed' && <p role="alert">{error}</p>}
    </section>
    <section className="settings-card"><h3>MyVault</h3>
      <p>Import a one-time copy. Later changes in Google stay in Google.</p>
      {canImport ? <>
        <p>If your organization disables password export, continue using the live vault in Chrome.</p>
        {vault === 'ready' ? <ChromePasswordImportWizard buttonLabel="Import Google passwords into MyVault" />
          : <p role="status">{vault === 'checking' ? 'Checking MyVault…' : vault === 'locked' ? 'Open and unlock MyVault to import passwords.' : 'MyVault status is unavailable.'}</p>}
        <button type="button" className="text-button" onClick={onOpenVault}>Open MyVault</button>
      </> : <p>Choose an unlocked Personal, Digitronics or TenTen Account Space to import passwords.</p>}
    </section>
  </>;
}
