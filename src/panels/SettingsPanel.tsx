import { FormEvent, useEffect, useState } from 'react';
import { ArrowLeft, Bookmark, Home, Search, Palette, Check, ChevronRight, Code2, Download, ExternalLink, Globe2, LoaderCircle, LockKeyhole, RefreshCw, Settings, Shield, ShieldCheck, Upload, TriangleAlert, X } from 'lucide-react';
import type { AccountSpaceId, BrowserSettings, BrowserSettingsPatch, BrowserSnapshot, ChromeImportResult, ChromeProfileSource, UpdateCheckResult, UpdateServiceInput, UpdateServiceStatus, UiPreferences, UiPreferencesPatch } from '../../electron/types';
import { PanelHeader } from './common';
import { formatReleaseDate, humanBytes, timeAgo } from '../lib/format';
import { SEARCH_ENGINES, type PresetSearchEngineId } from '../../electron/browser-settings';

const THEME_OPTIONS = [['system', 'Match Windows'], ['light', 'Light'], ['dark', 'Dark']] as const;
const BOOKMARK_BAR_OPTIONS = [['always', 'Always'], ['new-tab', 'New Tab only'], ['hidden', 'Hidden']] as const;
const HOME_PAGE_OPTIONS = [['new-tab', 'New Tab page'], ['url', 'Web address']] as const;
const STARTUP_OPTIONS = [['continue', 'Continue where you left off'], ['home', 'Also open Home page']] as const;

export function SettingsPanel({ state, ui, settings, onUiChange, onToast }: { state: BrowserSnapshot; ui: UiPreferences; settings: BrowserSettings; onUiChange: (patch: UiPreferencesPatch) => void; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [isDefault, setIsDefault] = useState(false);
  const [settingsPage, setSettingsPage] = useState<'overview' | 'updates'>('overview');
  const [updateStatus, setUpdateStatus] = useState<UpdateServiceStatus | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [editingUpdates, setEditingUpdates] = useState(false);
  const [checking, setChecking] = useState(true);
  const [updateForm, setUpdateForm] = useState<UpdateServiceInput>({ endpoint: '', accessToken: '' });
  const [chromeProfiles, setChromeProfiles] = useState<ChromeProfileSource[]>([]);
  const [chromeProfileId, setChromeProfileId] = useState('');
  const [chromeAccountSpaceId, setChromeAccountSpaceId] = useState(() => {
    const active = state.accountSpaces.find((account) => account.id === state.activeAccountSpaceId && account.workspaceId !== 'banking');
    return active?.id ?? state.accountSpaces.find((account) => account.workspaceId !== 'banking')?.id ?? state.activeAccountSpaceId;
  });
  const [chromeBookmarks, setChromeBookmarks] = useState(true);
  const [chromeHistory, setChromeHistory] = useState(true);
  const [chromeImportOpen, setChromeImportOpen] = useState(false);
  const [chromeLoading, setChromeLoading] = useState(false);
  const [chromeResult, setChromeResult] = useState<ChromeImportResult | null>(null);
  const chromeDestinations = state.accountSpaces.filter((account) => account.workspaceId === state.activeWorkspaceId && account.workspaceId !== 'banking');
  // null while the first status is still in flight — better than claiming
  // 'Active' before anything has been checked, which is what it used to do.
  const encryptionAvailable = updateStatus ? updateStatus.error !== 'os-encryption-unavailable' : null;
  useEffect(() => {
    void window.privateBrowser.getDefaultBrowserStatus().then(setIsDefault).catch(() => undefined);
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
    if (!chromeDestinations.some((account) => account.id === chromeAccountSpaceId) && chromeDestinations[0]) setChromeAccountSpaceId(chromeDestinations[0].id);
  }, [state.activeWorkspaceId, state.activeAccountSpaceId, state.accountSpaces]);
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
      const destination = state.accountSpaces.find((account) => account.id === chromeAccountSpaceId);
      if (!destination || destination.workspaceId === 'banking') throw new Error('Choose a non-Banking Account Space');
      const result = await window.privateBrowser.importChrome({ profileId: chromeProfileId, workspaceId: destination.workspaceId, accountSpaceId: destination.id, bookmarks: chromeBookmarks, history: chromeHistory });
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
  if (settingsPage === 'updates') {
    return <UpdatesPage
      status={updateStatus}
      result={updateResult}
      error={updateError}
      checking={checking}
      editingPrivate={editingUpdates}
      form={updateForm}
      onBack={() => { setUpdateForm((value) => ({ ...value, accessToken: '' })); setSettingsPage('overview'); }}
      onCheck={() => void checkUpdates()}
      onOpenDownload={() => void window.privateBrowser.openUpdatePage().catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'))}
      onOpenDeveloper={() => void window.privateBrowser.newTab('development', 'https://dr-badawi-abdalsalam.com/')}
      onTogglePrivate={() => { setEditingUpdates((value) => !value); setUpdateForm((value) => ({ ...value, accessToken: '' })); }}
      onConfigure={configureUpdates}
      onFormChange={setUpdateForm}
      onDisconnect={() => void disconnectUpdates()}
    />;
  }
  return <div className="side-panel">
    <PanelHeader icon={Settings} eyebrow="Application" title="Settings" />
    <div className="settings-card"><div className="settings-row"><span><Globe2 size={17} /></span><div><strong>Default browser</strong><small>{isDefault ? 'Private Browser opens web links.' : 'Use Private Browser for HTTP and HTTPS links.'}</small></div>{isDefault ? <b><Check size={14} /> Set</b> : <button onClick={() => void makeDefault()}>Set default</button>}</div></div>
    <SearchHomeSettings settings={settings} onToast={onToast} />
    <div className="settings-card chrome-import-settings">
      <div className="settings-row"><span><Upload size={17} /></span><div><strong>Import from Chrome</strong><small>Bookmarks, bookmark folders and browsing history stay on this computer.</small></div><button onClick={() => chromeImportOpen ? setChromeImportOpen(false) : void openChromeImport()}>{chromeImportOpen ? 'Close' : 'Import'}</button></div>
      {chromeImportOpen && <div className="chrome-import-form">
        {chromeLoading && !chromeProfiles.length ? <div className="import-loading"><LoaderCircle className="spin" size={15} /> Detecting Chrome profiles…</div> : chromeProfiles.length > 0 ? <>
          <label><span>Chrome profile</span><select value={chromeProfileId} onChange={(event) => setChromeProfileId(event.target.value)}>{chromeProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}{profile.isDefault ? ' (Default)' : ''}</option>)}</select></label>
          <label><span>Import into Account Space</span><select disabled={!chromeDestinations.length} value={chromeAccountSpaceId} onChange={(event) => setChromeAccountSpaceId(event.target.value as AccountSpaceId)}>{chromeDestinations.map((account) => <option value={account.id} key={account.id}>{account.label}</option>)}</select></label>
          {!chromeDestinations.length && <p className="import-note">Chrome data cannot be imported into Banking. Switch to another workspace first.</p>}
          <div className="import-checks">
            <label><input type="checkbox" checked={chromeBookmarks} onChange={(event) => setChromeBookmarks(event.target.checked)} /> <span><strong>Bookmarks</strong><small>Includes the full Chrome bookmarks bar and folder hierarchy.</small></span></label>
            <label><input type="checkbox" checked={chromeHistory} onChange={(event) => setChromeHistory(event.target.checked)} /> <span><strong>Browsing history</strong><small>Up to 10,000 recent Chrome pages.</small></span></label>
          </div>
          <button className="primary-button full" disabled={chromeLoading || !chromeDestinations.length || (!chromeBookmarks && !chromeHistory)} onClick={() => void importChrome()}>{chromeLoading ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />} Import selected data</button>
        </> : !chromeLoading ? <p className="import-note">Install or open Chrome once so a local profile exists, then try again.</p> : null}
        <div className="password-import-row"><div><strong>Saved passwords</strong><small>Chrome protects direct access. Export passwords as CSV, then select that file here. Secrets go straight into MyVault and never enter the page.</small></div><button disabled={chromeLoading} onClick={() => void importChromePasswords()}>Choose CSV</button></div>
        <p className="import-limit"><Shield size={13} /> Cookies, signed-in sessions, payment cards, extensions and Chrome account tokens are intentionally not copied.</p>
        {chromeResult && <div className="import-result"><Check size={15} /><div><strong>Import complete</strong><small>{chromeResult.imported.bookmarks} bookmarks · {chromeResult.imported.history} history · {chromeResult.imported.passwords} passwords</small>{chromeResult.skipped.bookmarks + chromeResult.skipped.history + chromeResult.skipped.passwords > 0 && <small>{chromeResult.skipped.bookmarks + chromeResult.skipped.history + chromeResult.skipped.passwords} duplicate or unsafe entries skipped</small>}{chromeResult.warnings.map((warning) => <small className="warning" key={warning}>{warning}</small>)}</div></div>}
      </div>}
    </div>
    <div className="settings-card"><div className="settings-row"><span><Palette size={17} /></span><div><strong>Appearance</strong><small>Theme for the browser frame, menus and the New Tab page.</small></div></div>
      <div className="segmented" role="radiogroup" aria-label="Theme">{THEME_OPTIONS.map(([theme, label]) => <button type="button" key={theme} role="radio" aria-checked={ui.theme === theme} className={ui.theme === theme ? 'active' : ''} onClick={() => onUiChange({ theme })}>{label}</button>)}</div>
    </div>
    <div className="settings-card"><div className="settings-row"><span><Bookmark size={17} /></span><div><strong>Bookmarks bar</strong><small>Where the bookmarks bar appears. Shortcut: Ctrl+Shift+B.</small></div></div>
      <div className="segmented" role="radiogroup" aria-label="Bookmarks bar">{BOOKMARK_BAR_OPTIONS.map(([mode, label]) => <button type="button" key={mode} role="radio" aria-checked={ui.bookmarkBarMode === mode} className={ui.bookmarkBarMode === mode ? 'active' : ''} onClick={() => onUiChange({ bookmarkBarMode: mode })}>{label}</button>)}</div>
    </div>
    <div className="settings-card update-settings"><div className="settings-row"><span><RefreshCw size={17} /></span><div><strong>App updates</strong><small>{checking ? 'Checking the latest stable release…' : updateError ? 'Latest-version check unavailable' : updateResult?.state === 'available' ? `Version ${updateResult.latest.version} is ready` : `Version ${updateResult?.currentVersion ?? updateStatus?.currentVersion ?? ''} is current`}</small></div>{checking ? <b className="pending"><LoaderCircle className="spin" size={13} /> Checking</b> : updateError ? <button onClick={() => setSettingsPage('updates')}>Review</button> : updateResult?.state === 'available' ? <button className="update-ready-button" onClick={() => setSettingsPage('updates')}>Update</button> : <button onClick={() => setSettingsPage('updates')}>Open</button>}</div></div>
    <div className="settings-card"><div className="settings-row"><span><ShieldCheck size={17} /></span><div><strong>Security baseline</strong><small>Sandboxed pages, isolated sessions, strict IPC and encrypted secrets.</small></div>{encryptionAvailable === null ? <b className="pending">Checking…</b> : encryptionAvailable ? <b><Check size={14} /> Active</b> : <b className="failing"><X size={14} /> Encryption unavailable</b>}</div></div>
    <div className="about-card"><span><ShieldCheck size={23} /></span><div><strong>Private Browser</strong><small>{updateStatus?.currentVersion ? `Version ${updateStatus.currentVersion} · Digitronics` : 'Digitronics'}</small></div></div>
  </div>;
}

interface UpdatesPageProps {
  status: UpdateServiceStatus | null;
  result: UpdateCheckResult | null;
  error: string | null;
  checking: boolean;
  editingPrivate: boolean;
  form: UpdateServiceInput;
  onBack: () => void;
  onCheck: () => void;
  onOpenDownload: () => void;
  onOpenDeveloper: () => void;
  onTogglePrivate: () => void;
  onConfigure: (event: FormEvent) => void;
  onFormChange: (value: UpdateServiceInput) => void;
  onDisconnect: () => void;
}

function UpdatesPage({ status, result, error, checking, editingPrivate, form, onBack, onCheck, onOpenDownload, onOpenDeveloper, onTogglePrivate, onConfigure, onFormChange, onDisconnect }: UpdatesPageProps) {
  const latest = result?.latest;
  const available = result?.state === 'available';
  const state = checking ? 'checking' : error ? 'error' : available ? 'available' : result ? 'current' : 'checking';
  const title = state === 'checking' ? 'Checking for updates…' : state === 'error' ? 'Could not verify the latest version' : state === 'available' ? `Version ${latest?.version} is available` : 'Private Browser is up to date';
  const description = state === 'checking'
    ? 'Comparing this installation with the latest stable release in D1.'
    : state === 'error'
      ? error ?? 'The update service could not be reached.'
      : state === 'available'
        ? 'A newer Windows installer is ready on the public download page. Its checksum is checked before Private Browser will open it.'
        : `Version ${result?.currentVersion ?? status?.currentVersion ?? '—'} is the latest stable release.`;

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
      <div className="updates-primary-actions">
        {state === 'available' && <button className="updates-primary" onClick={onOpenDownload}><Download size={15} /> Open verified download</button>}
        {state === 'current' && <button className="updates-primary" onClick={onCheck}><RefreshCw size={15} /> Check again</button>}
        {state === 'error' && <button className="updates-primary" onClick={onCheck}><RefreshCw size={15} /> Try again</button>}
        {state !== 'available' && state !== 'checking' && <button className="updates-secondary" onClick={onOpenDownload}><ExternalLink size={14} /> Release page</button>}
      </div>
    </section>

    {latest && <section className="updates-detail-card" aria-labelledby="release-details-title">
      <div className="updates-section-heading"><div><small>RELEASE DETAILS</small><h3 id="release-details-title">Private Browser {latest.version}</h3></div><span>Build {latest.buildNumber}</span></div>
      <dl className="release-metadata">
        <div><dt>Published</dt><dd><time dateTime={latest.publishedAt}>{formatReleaseDate(latest.publishedAt)}</time></dd></div>
        <div><dt>Installer</dt><dd>{humanBytes(latest.sizeBytes)} · Windows x64</dd></div>
        <div><dt>Source</dt><dd><code>{latest.commitSha.slice(0, 12)}</code></dd></div>
      </dl>
      <div className="release-notes"><small>WHAT'S NEW</small><p>{latest.releaseNotes || 'Stability and security improvements.'}</p></div>
      <div className="release-checksum"><ShieldCheck size={14} /><div><small>SHA-256 CHECKSUM</small><code>{latest.sha256}</code></div></div>
      <p className="updates-verified-note">Private Browser remembers this checksum and verifies the downloaded installer before it can be opened.</p>
      <small className="updates-checked-at">Checked {timeAgo(result.checkedAt)} · Automatically checked every 24 hours</small>
    </section>}

    <section className="updates-detail-card developer-update-card">
      <span><Code2 size={17} /></span><div><small>DEVELOPER</small><strong>Dr. Badawi Abdalsalam</strong><p>Software Architect · Casablanca, Morocco</p></div><button aria-label="Open developer website" onClick={onOpenDeveloper}><ExternalLink size={14} /></button>
    </section>

    <section className="updates-private-card">
      <div className="updates-private-heading"><div><small>ADVANCED</small><strong>Private update service</strong><p>{status?.configured ? 'Using an encrypted access token for the private manifest.' : 'Public stable checks are active. A private service is optional.'}</p></div><span className={status?.configured ? 'connected' : ''}>{status?.configured ? 'Connected' : 'Public'}</span></div>
      {status?.error && <p className="updates-private-error">{status.error === 'configuration-corrupt' ? 'The saved private configuration is unreadable. Public checks remain available.' : 'Windows encryption is unavailable, so private credentials cannot be stored.'}</p>}
      {editingPrivate && <form className="update-form" onSubmit={onConfigure}>
        <input aria-label="Private update service URL" type="url" required placeholder="https://private-browser-downloads.example.workers.dev" value={form.endpoint} onChange={(event) => onFormChange({ ...form, endpoint: event.target.value })} />
        <input aria-label="Private download access token" type="password" required minLength={32} placeholder="Download access token" value={form.accessToken} onChange={(event) => onFormChange({ ...form, accessToken: event.target.value })} />
        <button className="primary-button" type="submit"><LockKeyhole size={14} /> Encrypt and connect</button>
      </form>}
      <div className="update-actions">
        <button onClick={onTogglePrivate}>{editingPrivate ? 'Cancel' : status?.configured ? 'Change service' : 'Connect private service'}</button>
        {status?.configured && <button className="danger" onClick={onDisconnect}>Disconnect</button>}
      </div>
    </section>
  </div>;
}

/**
 * Search engine, Home page and startup. The main process validates and normalizes
 * every value; a refusal comes back as a toast and the typed text stays put.
 */
function SearchHomeSettings({ settings, onToast }: { settings: BrowserSettings; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [customOpen, setCustomOpen] = useState(settings.searchEngine === 'custom');
  const [template, setTemplate] = useState(settings.customSearchTemplate ?? '');
  const [homeEditing, setHomeEditing] = useState(settings.homePage === 'url');
  const [homeUrl, setHomeUrl] = useState(settings.homePageUrl ?? '');
  useEffect(() => { setCustomOpen(settings.searchEngine === 'custom'); setTemplate(settings.customSearchTemplate ?? ''); }, [settings.searchEngine, settings.customSearchTemplate]);
  useEffect(() => { setHomeEditing(settings.homePage === 'url'); setHomeUrl(settings.homePageUrl ?? ''); }, [settings.homePage, settings.homePageUrl]);
  const save = async (patch: BrowserSettingsPatch, done?: string) => {
    try {
      await window.privateBrowser.setBrowserSettings(patch);
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
  return <>
    <div className="settings-card"><div className="settings-row"><span><Search size={17} /></span><div><strong>Search engine</strong><small>Used when what you type in the address bar is not a web address.</small></div></div>
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
    <div className="settings-card"><div className="settings-row"><span><Home size={17} /></span><div><strong>Home page</strong><small>What the Home button and Alt+Home open. Banking always opens the New Tab page.</small></div></div>
      <div className="segmented" role="radiogroup" aria-label="Home page">{HOME_PAGE_OPTIONS.map(([mode, label]) => { const active = (homeEditing ? 'url' : settings.homePage) === mode; return <button type="button" key={mode} role="radio" aria-checked={active} className={active ? 'active' : ''} onClick={() => { if (mode === 'url') { setHomeEditing(true); return; } setHomeEditing(false); void save({ homePage: 'new-tab' }); }}>{label}</button>; })}</div>
      {homeEditing && <form className="settings-inline-form" onSubmit={saveHome}>
        <input aria-label="Home page address" inputMode="url" required maxLength={2048} placeholder="tenten.ma" value={homeUrl} onChange={(event) => setHomeUrl(event.target.value)} spellCheck={false} />
        <button type="submit" aria-label="Save Home page">Save</button>
      </form>}
    </div>
    <div className="settings-card"><div className="settings-row"><span><RefreshCw size={17} /></span><div><strong>On startup</strong><small>Your open tabs always come back. Choose whether the Home page opens as well.</small></div></div>
      <div className="segmented" role="radiogroup" aria-label="On startup">{STARTUP_OPTIONS.map(([mode, label]) => <button type="button" key={mode} role="radio" aria-checked={settings.startup === mode} className={settings.startup === mode ? 'active' : ''} onClick={() => void save({ startup: mode })}>{label}</button>)}</div>
    </div>
  </>;
}
