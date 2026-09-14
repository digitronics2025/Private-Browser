import { FormEvent, useEffect, useRef, useState } from 'react';
import { Cloud, CalendarDays, ExternalLink, HardDrive, KeyRound, LoaderCircle, LogOut, LockKeyhole, Mail, Plus, RefreshCw, Shield, Trash2, TriangleAlert, UsersRound, X } from 'lucide-react';
import type { AccountSpaceColor, BrowserSnapshot, GoogleModule, GoogleOperationResult } from '../../electron/types';
import { AccountAvatar } from '../lib/accounts';

const ACCOUNT_COLORS: AccountSpaceColor[] = ['indigo', 'sky', 'emerald', 'amber', 'rose', 'violet', 'slate'];
const GOOGLE_MODULE_OPTIONS: Array<{ id: GoogleModule; label: string; detail: string; highRisk?: boolean }> = [
  { id: 'gmail-metadata', label: 'Gmail overview', detail: 'Unread count and recent headers' },
  { id: 'gmail-read', label: 'Gmail search & read', detail: 'Read mail when you explicitly search', highRisk: true },
  { id: 'gmail-send', label: 'Gmail send', detail: 'Compose locally; confirm every send', highRisk: true },
  { id: 'drive-files', label: 'Drive app files', detail: 'Files created or opened by this app' },
  { id: 'drive-metadata', label: 'Whole-Drive metadata', detail: 'Recent files and search', highRisk: true },
  { id: 'drive-read', label: 'Whole-Drive read', detail: 'Read ordinary Drive files', highRisk: true },
  { id: 'calendar-read', label: 'Calendar read', detail: 'Upcoming events and search' },
  { id: 'calendar-write', label: 'Calendar write', detail: 'Confirm every event change', highRisk: true },
  { id: 'contacts-read', label: 'Contacts', detail: 'Memory-only recipient picker' },
  { id: 'encrypted-backup', label: 'Encrypted backup', detail: 'Ciphertext in Drive app data' },
];

export function AccountManager({ state, onClose, onToast }: { state: BrowserSnapshot; onClose: () => void; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const accounts = state.accountSpaces.filter((account) => account.workspaceId === state.activeWorkspaceId).sort((a, b) => a.order - b.order);
  const [selectedId, setSelectedId] = useState(state.activeAccountSpaceId);
  const selected = accounts.find((account) => account.id === selectedId) ?? accounts[0];
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState<AccountSpaceColor>('indigo');
  const [editLabel, setEditLabel] = useState(selected?.label ?? '');
  const [modules, setModules] = useState<GoogleModule[]>(selected?.enabledModules ?? []);
  const [browserId, setBrowserId] = useState(state.externalBrowsers[0]?.id ?? 'edge');
  const [clientId, setClientId] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [recoveryVerification, setRecoveryVerification] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => { dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  useEffect(() => { if (selected) { setEditLabel(selected.label); setModules(selected.enabledModules); } }, [selected?.id, selected?.label]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, []);
  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try { await action(); if (success) onToast(success); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };
  const requireGoogleSuccess = async (operation: Promise<GoogleOperationResult>) => {
    const result = await operation;
    if (!result.ok) throw new Error(result.error?.message ?? 'Google operation failed');
    return result;
  };
  const addLocal = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => { await window.privateBrowser.addLocalAccountSpace(state.activeWorkspaceId, newLabel, newColor); setNewLabel(''); }, 'Local Account Space added');
  };
  const addGoogle = () => {
    void run(async () => {
      const id = await window.privateBrowser.addLocalAccountSpace(state.activeWorkspaceId, newLabel, newColor);
      setSelectedId(id);
      setNewLabel('');
      await requireGoogleSuccess(window.privateBrowser.connectGoogleAccount(id, ['identity'], browserId));
    }, 'Google Account Space added');
  };
  const reorder = (direction: -1 | 1) => {
    if (!selected) return;
    const index = accounts.findIndex((account) => account.id === selected.id);
    const target = index + direction;
    if (target < 0 || target >= accounts.length) return;
    const ids = accounts.map((account) => account.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void run(() => window.privateBrowser.reorderAccountSpaces(state.activeWorkspaceId, ids), 'Account order updated');
  };
  if (!selected) return null;
  return <div className="modal-backdrop" role="presentation">
    <div className="account-manager" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="account-manager-title">
      <header><div><span>PRIVATE CONTAINERS</span><h2 id="account-manager-title">Account Spaces</h2><p>Independent website sessions and Google grants inside {state.workspaces.find((item) => item.id === state.activeWorkspaceId)?.name}.</p></div><button className="icon-button" aria-label="Close Account Space manager" onClick={onClose}><X size={18} /></button></header>
      <div className="manager-body">
        <aside className="account-rail">
          {accounts.map((account) => <button className={account.id === selected.id ? 'active' : ''} key={account.id} onClick={() => setSelectedId(account.id)}><AccountAvatar account={account} /><span><strong>{account.label}</strong><small>{account.email ?? 'Local only'}</small></span>{account.locked && <LockKeyhole size={13} />}</button>)}
          <form className="add-account-form" onSubmit={addLocal}><label>New Account Space<input aria-label="New Account Space label" maxLength={80} required value={newLabel} onChange={(event) => setNewLabel(event.target.value)} placeholder="e.g. Client account" /></label><div className="color-row">{ACCOUNT_COLORS.map((color) => <button aria-label={`Use ${color}`} aria-pressed={newColor === color} type="button" className={`color-swatch account-${color} ${newColor === color ? 'active' : ''}`} key={color} onClick={() => setNewColor(color)} />)}</div><div className="add-account-actions"><button className="secondary-button" type="submit" disabled={busy}><Plus size={14} /> Add local</button><button className="secondary-button" type="button" disabled={busy || !state.googleConfiguration.configured || !state.externalBrowsers.length || !newLabel.trim()} onClick={addGoogle}><ExternalLink size={14} /> Add Google</button></div></form>
        </aside>
        <main className="account-detail">
          <section className="account-identity"><AccountAvatar account={selected} /><div><span>{selected.kind === 'google' ? 'GOOGLE ACCOUNT SPACE' : 'LOCAL ACCOUNT SPACE'}</span><h2>{selected.displayName ?? selected.label}</h2><p>{selected.email ?? 'No Google API connection. Website sessions remain independent.'}</p></div><span className={`status-chip status-${selected.googleConnection}`}>{selected.googleConnection.replaceAll('-', ' ')}</span></section>
          <section className="manager-section"><div className="manager-section-heading"><div><h3>Identity & appearance</h3><p>The label and colour are local and never enter plaintext browser state.</p></div><div className="reorder-actions"><button aria-label="Move Account Space earlier" onClick={() => reorder(-1)}>↑</button><button aria-label="Move Account Space later" onClick={() => reorder(1)}>↓</button></div></div><form className="identity-form" onSubmit={(event) => { event.preventDefault(); void run(() => window.privateBrowser.updateAccountSpace(selected.id, editLabel, selected.color), 'Account Space renamed'); }}><input aria-label="Account Space label" maxLength={80} value={editLabel} onChange={(event) => setEditLabel(event.target.value)} /><button className="secondary-button" disabled={busy || editLabel.trim() === selected.label}>Save</button></form><div className="edit-color-row" aria-label="Account Space colour">{ACCOUNT_COLORS.map((color) => <button aria-label={`Change colour to ${color}`} aria-pressed={selected.color === color} type="button" className={`color-swatch account-${color} ${selected.color === color ? 'active' : ''}`} key={color} onClick={() => void run(() => window.privateBrowser.updateAccountSpace(selected.id, undefined, color), 'Account colour updated')} />)}</div></section>
          <section className="manager-section"><div className="manager-section-heading"><div><h3>Google API connection</h3><p>Website status: {selected.websiteStatus.replaceAll('-', ' ')} · API status: {selected.googleConnection.replaceAll('-', ' ')}.</p></div></div>
            {!state.googleConfiguration.configured && <form className="google-config" onSubmit={(event) => { event.preventDefault(); void run(async () => { await window.privateBrowser.configureGoogle(clientId); setClientId(''); }, 'Desktop OAuth client configured'); }}><TriangleAlert size={16} /><p>Google integration needs configuration. Enter only a Desktop OAuth client ID—never a client secret.</p><input aria-label="Google Desktop OAuth client ID" value={clientId} onChange={(event) => setClientId(event.target.value)} placeholder="Desktop client ID" required /><button className="secondary-button" disabled={busy}>Save</button></form>}
            <div className="module-grid">{GOOGLE_MODULE_OPTIONS.map((module) => <label key={module.id} className={module.highRisk ? 'high-risk' : ''}><input type="checkbox" checked={modules.includes(module.id)} onChange={(event) => setModules((current) => event.target.checked ? [...new Set([...current, module.id])] : current.filter((item) => item !== module.id))} /><span><strong>{module.label}{module.highRisk ? ' · expanded access' : ''}</strong><small>{module.detail}</small></span></label>)}</div>
            <div className="google-actions"><select aria-label="External browser" value={browserId} onChange={(event) => setBrowserId(event.target.value as typeof browserId)}>{state.externalBrowsers.map((browser) => <option value={browser.id} key={browser.id}>{browser.name}</option>)}</select><button className="primary-button" disabled={busy || !state.googleConfiguration.configured || !state.externalBrowsers.length} onClick={() => void run(() => requireGoogleSuccess(window.privateBrowser.connectGoogleAccount(selected.id, ['identity', ...modules.filter((item) => item !== 'identity')], browserId)), 'Google consent completed')}>{busy ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={14} />} {selected.googleConnection === 'connected' ? 'Reconnect with selected access' : 'Connect in external browser'}</button>{selected.kind === 'google' && <button className="secondary-button danger-text" disabled={busy} onClick={() => { if (window.confirm(`Disconnect Google API access for ${selected.email ?? selected.label}? Website cookies will stay.`)) void run(() => requireGoogleSuccess(window.privateBrowser.disconnectGoogleAccount(selected.id, false)), 'Google API disconnected'); }}><LogOut size={14} /> Disconnect API</button>}</div>
          </section>
          <section className="manager-section"><div className="manager-section-heading"><div><h3>Open Google services</h3><p>Each launcher stays inside this Account Space’s isolated website partition.</p></div></div><div className="service-launchers"><button onClick={() => void run(() => window.privateBrowser.openInAccountSpace(selected.id, 'https://mail.google.com/'))}><Mail size={16} /> Gmail</button><button onClick={() => void run(() => window.privateBrowser.openInAccountSpace(selected.id, 'https://drive.google.com/'))}><HardDrive size={16} /> Drive</button><button onClick={() => void run(() => window.privateBrowser.openInAccountSpace(selected.id, 'https://calendar.google.com/'))}><CalendarDays size={16} /> Calendar</button><button onClick={() => void run(() => window.privateBrowser.openInAccountSpace(selected.id, 'https://contacts.google.com/'))}><UsersRound size={16} /> Contacts</button></div></section>
          {selected.enabledModules.includes('encrypted-backup') && <section className="manager-section"><div className="manager-section-heading"><div><h3>Encrypted app-data backup</h3><p>Google receives AES-256-GCM ciphertext only. My Vault, cookies, tokens, bodies, attachments, downloads and privacy logs are excluded.</p></div></div>{!recoveryCode ? <div className="backup-actions">{!selected.backupEnabled && <button className="secondary-button" onClick={() => void run(async () => setRecoveryCode(await window.privateBrowser.createBackupRecoveryCode(selected.id)))}><KeyRound size={14} /> Create recovery code</button>}{selected.backupEnabled && <button className="secondary-button" onClick={() => void run(() => window.privateBrowser.uploadBackup(selected.id, crypto.randomUUID()), 'Encrypted backup uploaded')}><Cloud size={14} /> Back up now</button>}</div> : <div className="recovery-code"><strong>Save this once-only recovery code</strong><code>{recoveryCode}</code><p>Verify it before backup is enabled. It cannot be recovered by Google or Digitronics.</p><input aria-label="Verify recovery code" value={recoveryVerification} onChange={(event) => setRecoveryVerification(event.target.value)} placeholder="Enter the complete recovery code" /><button className="primary-button" disabled={recoveryVerification !== recoveryCode} onClick={() => void run(async () => { await window.privateBrowser.verifyAndEnableBackup(selected.id, recoveryVerification, true, false); setRecoveryCode(''); setRecoveryVerification(''); }, 'Encrypted backup enabled')}>Verify and enable</button></div>}</section>}
          <section className="manager-section danger-zone"><div><h3>Operational privacy</h3><p>Lock closes live views and connections. It is not a second Windows authentication boundary.</p></div><div className="danger-actions"><button onClick={() => void run(() => window.privateBrowser.setAccountSpaceLocked(selected.id, !selected.locked), selected.locked ? 'Account Space reopened' : 'Account Space locked')}>{selected.locked ? <RefreshCw size={14} /> : <LockKeyhole size={14} />} {selected.locked ? 'Reopen' : 'Lock'}</button><button onClick={() => { if (window.confirm(`Clear website data and history for “${selected.label}” only?`)) void run(() => window.privateBrowser.clearAccountSpaceData(selected.id), 'Account Space data cleared'); }}><Shield size={14} /> Clear data</button><button className="destructive-button" disabled={accounts.length <= 1} onClick={() => { if (window.confirm(`Delete Account Space “${selected.label}”? This removes its tabs, history, permissions and Google grant after session erasure.`)) void run(() => window.privateBrowser.deleteAccountSpace(selected.id, 'DELETE_ACCOUNT_SPACE'), 'Account Space deleted'); }}><Trash2 size={14} /> Delete</button></div></section>
        </main>
      </div>
    </div>
  </div>;
}
