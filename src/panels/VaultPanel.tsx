import { useEffect, useState } from 'react';
import { Clock3, Cloud, Copy, Eye, FileDown, KeyRound, LockKeyhole, Plus, RefreshCw, Search, ShieldCheck, Trash2, Zap } from 'lucide-react';
import type { VaultItemMeta, VaultStatus, WorkspaceId } from '../../electron/types';
import { EmptyState, PanelHeader } from './common';
import { domainFromUrl } from '../lib/format';

export function VaultPanel({ workspaceId, activeOrigin, onOpenFull, onToast }: { workspaceId: WorkspaceId; activeOrigin?: string; onOpenFull?: () => void; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [items, setItems] = useState<VaultItemMeta[]>([]);
  const [status, setStatus] = useState<VaultStatus>({ available: true, items: [] });
  const [query, setQuery] = useState('');
  const [secondsRemaining, setSecondsRemaining] = useState(30 - (Math.floor(Date.now() / 1000) % 30));
  const [formShape, setFormShape] = useState({ hasUsername: false, hasPassword: false });
  const [conflictReview, setConflictReview] = useState<{ local: VaultItemMeta[]; cloud: VaultItemMeta[] }>();
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const load = async () => {
    try { const result = await window.privateBrowser.listVault(); setItems(result.items); setStatus(result); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  useEffect(() => { void load(); return window.privateBrowser.onVaultState(() => void load()); }, []);
  useEffect(() => { const timer = window.setInterval(() => setSecondsRemaining(30 - (Math.floor(Date.now() / 1000) % 30)), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { void window.privateBrowser.getVaultMigrationStatus().then((value) => setLegacyAvailable(value.legacyAvailable)); }, []);
  useEffect(() => { if (activeOrigin && workspaceId !== 'banking') void window.privateBrowser.inspectVaultFormShape().then(setFormShape).catch(() => setFormShape({ hasUsername: false, hasPassword: false })); else setFormShape({ hasUsername: false, hasPassword: false }); }, [activeOrigin, workspaceId]);
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
  const add = async () => { try { const result = await window.privateBrowser.openVaultEditor(activeOrigin); if (result) { await load(); onToast('Login encrypted in MyVault'); } } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const saveFromPage = async () => { try { const result = await window.privateBrowser.requestSaveFromPage(); if (result) { await load(); onToast('Captured login encrypted in MyVault'); } } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const sync = async () => { try { const result = await window.privateBrowser.syncVaultNow(); setStatus(result); setItems(result.items); onToast('MyVault synchronized'); } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const resolveConflict = async (choice: 'cloud' | 'local') => { try { const result = await window.privateBrowser.resolveVaultConflict(choice); setConflictReview(undefined); setStatus(result); setItems(result.items); onToast(`Kept the ${choice} vault`); } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const visibleItems = items.filter((item) => [item.label, item.username, item.url].some((value) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  return (
    <div className="side-panel">
      <PanelHeader icon={KeyRound} eyebrow="MyVault broker" title="MyVault" />
      {onOpenFull && <button className="text-button" onClick={onOpenFull}><Eye size={14} /> Open full metadata view</button>}
      <div className={`vault-health ${status.available ? '' : 'warning'}`}><ShieldCheck size={16} /><div><strong>{status.lifecycle === 'unlocked' ? 'Unlocked on this device' : status.lifecycle === 'recovery-required' ? 'Recovery required' : status.lifecycle === 'unconfigured' ? 'Connection required' : 'Locked'}</strong><span>{status.sync === 'dirty' ? 'Encrypted changes are waiting to sync.' : status.lifecycle === 'unlocked' && workspaceId !== 'banking' ? 'Saved logins autofill matching HTTPS sign-in pages.' : 'Passwords stay outside this interface and browser pages.'}</span></div></div>
      {status.lifecycle === 'unconfigured' && <button className="primary-button full" onClick={() => void window.privateBrowser.requestVaultPairing().then((result) => { setStatus(result); setItems(result.items); }).catch((error) => onToast(error.message, 'error'))}><Cloud size={16} /> Connect with one-time code</button>}
      {status.lifecycle === 'recovery-required' && <button className="recovery-button" onClick={() => void window.privateBrowser.acknowledgeVaultRecovery().then((result) => { setStatus(result); setItems(result.items); })}>Keep recovery copy and continue</button>}
      {status.lifecycle === 'locked' && <button className="primary-button full" onClick={() => void unlock()}><LockKeyhole size={16} /> Unlock in secure window</button>}
      {status.lifecycle === 'unlocked' && <div className="credential-actions"><button className="primary-button" onClick={() => void add()}><Plus size={16} /> Add login</button><button onClick={() => void sync()}><RefreshCw size={14} /> Sync</button><button onClick={() => void lock()}><LockKeyhole size={14} /> Lock</button></div>}
      {status.lifecycle === 'conflict' && <div className="permission-card"><strong>Choose which encrypted vault wins</strong><p>MyVault never merges or overwrites a conflict automatically.</p><div className="credential-actions"><button onClick={() => void window.privateBrowser.getVaultConflictReview().then(setConflictReview)}>Review metadata</button><button onClick={() => void resolveConflict('cloud')}>Keep cloud</button><button onClick={() => void resolveConflict('local')}>Keep local</button></div></div>}
      {conflictReview && <div className="context-card"><strong>Local ({conflictReview.local.length}) / Cloud ({conflictReview.cloud.length})</strong><p>{[...new Set([...conflictReview.local, ...conflictReview.cloud].map((item) => `${item.label} — ${item.username}`))].join('\n')}</p></div>}
      {status.lifecycle === 'unlocked' && formShape.hasPassword && <button className="primary-button full" onClick={() => void saveFromPage()}><ShieldCheck size={15} /> {formShape.hasUsername ? 'Save or update this login' : 'Save password from this page'}</button>}
      {status.lifecycle === 'unlocked' && legacyAvailable && <div className="permission-card"><strong>Old Private Browser vault found</strong><p>Migration makes and verifies an encrypted backup first. The old ciphertext remains until you separately remove it.</p><button className="primary-button full" onClick={() => void window.privateBrowser.migrateLegacyVault().then((report) => { onToast(`${report.validatedCount} legacy records validated`); void load(); }).catch((error) => onToast(error.message, 'error'))}>Migrate into MyVault</button><button className="text-button danger-text" onClick={() => void window.privateBrowser.cleanupLegacyVault().then((removed) => { if (removed) { setLegacyAvailable(false); onToast('Old ciphertext removed; backup retained'); } })}>Remove old ciphertext after verification</button></div>}
      {status.lifecycle === 'unlocked' && workspaceId !== 'banking' && <button className="text-button" onClick={() => void window.privateBrowser.importChromePasswords().then((report) => { onToast(`${report.imported.passwords} Chrome passwords imported; CSV retained`); void load(); }).catch((error) => onToast(error.message, 'error'))}><FileDown size={14} /> Import Chrome password CSV</button>}
      {status.lifecycle === 'unlocked' && <><label className="vault-search"><Search size={14} /><input aria-label="Search MyVault metadata" placeholder="Search logins" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{workspaceId !== 'banking' && <div className="credential-actions"><button onClick={() => void window.privateBrowser.copyGeneratedCredential('password').then(() => onToast('Generated password copied'))}>Password</button><button onClick={() => void window.privateBrowser.copyGeneratedCredential('passphrase').then(() => onToast('Generated passphrase copied'))}>Passphrase</button><button onClick={() => void window.privateBrowser.copyGeneratedCredential('pin').then(() => onToast('Generated PIN copied'))}>PIN</button></div>}</>}
      <div className="credential-list">
        {visibleItems.map((item) => <div className="credential-card" key={item.id}>
          <div className="credential-top"><span className="site-badge">{item.label.slice(0, 1).toUpperCase()}</span><div><strong>{item.label}</strong><small>{domainFromUrl(item.url)} · {item.username}</small></div></div>
          <div className="credential-actions">
            <button onClick={() => void window.privateBrowser.autofill(item.id).then(() => onToast('Credential filled')).catch((error) => onToast(error.message, 'error'))}><Zap size={14} /> Fill</button>
            {workspaceId !== 'banking' && <button onClick={() => void copyPassword(item.id)}><Copy size={14} /> Password</button>}
            {workspaceId !== 'banking' && item.hasTotp && <button onClick={() => void copyTotp(item.id)}><Clock3 size={14} /> Code {secondsRemaining}s</button>}
            <button className="danger" title="Delete" onClick={() => void window.privateBrowser.requestVaultDelete(item.id).then(load)}><Trash2 size={14} /></button>
          </div>
        </div>)}
        {!items.length && status.lifecycle === 'unlocked' && <EmptyState icon={KeyRound} text="No logins in MyVault yet." />}
      </div>
    </div>
  );
}
