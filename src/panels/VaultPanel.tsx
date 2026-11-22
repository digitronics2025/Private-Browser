import { useEffect, useState } from 'react';
import { Clock3, Cloud, Copy, Eye, Fingerprint, KeyRound, LockKeyhole, Plus, RefreshCw, Search, ShieldCheck, Trash2, Zap } from 'lucide-react';
import type { AccountSpaceId, VaultConflictReview, VaultConflictSide, VaultFillReadiness, VaultItemMeta, VaultStatus, WorkspaceId } from '../../electron/types';
import { EmptyState, PanelHeader } from './common';
import { domainFromUrl } from '../lib/format';
import { VaultHealthPanel } from './VaultHealthPanel';
import { ChromePasswordImportWizard } from './ChromePasswordImportWizard';

const fillReadinessText: Record<VaultFillReadiness, [string, string]> = {
  locked: ['Vault locked', 'Unlock MyVault to check for a saved login.'],
  connect: ['Connect MyVault', 'Use the one-time code to connect this browser.'],
  'no-match': ['No matching sign-in', 'Choose Add login or save the login from this website.'],
  unsupported: ['This form is unsupported', 'Open the site’s HTTPS sign-in page, then check again.'],
  manual: ['Banking requires manual approval', 'Choose Fill on a saved login and confirm the site in the secure window.'],
  'choose-login': ['Choose a saved login', 'Use the login picker or choose Fill beside the matching login.'],
  ready: ['Matching sign-in available', 'Use Fill beside the saved login if the form still needs it.'],
  unavailable: ['MyVault fill is unavailable', 'Check Setup and recovery or enter your login directly on the site.'],
};

export function VaultPanel({ accountId, workspaceId, activeOrigin, onOpenFull, onToast }: { accountId: AccountSpaceId; workspaceId: WorkspaceId; activeOrigin?: string; onOpenFull?: () => void; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [items, setItems] = useState<VaultItemMeta[]>([]);
  const [status, setStatus] = useState<VaultStatus>({ available: true, items: [] });
  const [query, setQuery] = useState('');
  const [secondsRemaining, setSecondsRemaining] = useState(30 - (Math.floor(Date.now() / 1000) % 30));
  const [clipboardDeadline, setClipboardDeadline] = useState<number>();
  const clipboardSeconds = workspaceId === 'banking' ? 0 : Math.max(0, Math.ceil(((clipboardDeadline ?? 0) - Date.now()) / 1000));
  const [formShape, setFormShape] = useState({ hasUsername: false, hasPassword: false });
  const [fillReadiness, setFillReadiness] = useState<VaultFillReadiness>();
  const [fillCheck, setFillCheck] = useState(0);
  const [conflictReview, setConflictReview] = useState<VaultConflictReview>();
  const [conflictBusy, setConflictBusy] = useState(false);
  const [legacyAvailable, setLegacyAvailable] = useState(false);
  const load = async () => {
    try { const result = await window.privateBrowser.listVault(); setItems(result.items); setStatus(result); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  useEffect(() => { void load(); return window.privateBrowser.onVaultState(() => void load()); }, []);
  useEffect(() => { setConflictReview(undefined); }, [accountId, status.lifecycle, status.generation]);
  useEffect(() => { const timer = window.setInterval(() => setSecondsRemaining(30 - (Math.floor(Date.now() / 1000) % 30)), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    let current = true;
    void window.privateBrowser.vaultClipboardDeadline().then((deadline) => { if (current) setClipboardDeadline(deadline); }).catch(() => undefined);
    return () => { current = false; };
  }, [accountId, status.lifecycle]);
  useEffect(() => { void window.privateBrowser.getVaultMigrationStatus().then((value) => setLegacyAvailable(value.legacyAvailable)); }, []);
  useEffect(() => { if (activeOrigin && workspaceId !== 'banking') void window.privateBrowser.inspectVaultFormShape().then(setFormShape).catch(() => setFormShape({ hasUsername: false, hasPassword: false })); else setFormShape({ hasUsername: false, hasPassword: false }); }, [activeOrigin, workspaceId]);
  useEffect(() => {
    let current = true;
    setFillReadiness(undefined);
    void window.privateBrowser.vaultFillReadiness().then((readiness) => {
      if (current) setFillReadiness(readiness);
    }).catch(() => { if (current) setFillReadiness('unavailable'); });
    return () => { current = false; };
  }, [activeOrigin, workspaceId, status.lifecycle, status.generation, fillCheck]);
  const copyPassword = async (id: string) => {
    try { await window.privateBrowser.copyPassword(id); setClipboardDeadline(await window.privateBrowser.vaultClipboardDeadline()); onToast('Password copied'); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const copyTotp = async (id: string) => {
    try { const { secondsRemaining } = await window.privateBrowser.copyTotp(id); setClipboardDeadline(await window.privateBrowser.vaultClipboardDeadline()); onToast(`Authenticator code copied · ${secondsRemaining}s remaining`); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const copyGenerated = async (kind: 'password' | 'passphrase' | 'pin') => {
    try { await window.privateBrowser.copyGeneratedCredential(kind); setClipboardDeadline(await window.privateBrowser.vaultClipboardDeadline()); onToast('Generated value copied'); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const clearClipboard = async () => {
    try {
      const cleared = await window.privateBrowser.clearVaultClipboard();
      setClipboardDeadline(undefined);
      onToast(cleared ? 'Vault copy cleared' : 'No vault copy was cleared');
    } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const unlock = async () => { try { const result = await window.privateBrowser.requestVaultUnlock(); setStatus(result); setItems(result.items); } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const hello = async (action: () => Promise<VaultStatus>, done?: { message: string; when: VaultStatus['platformUnlock'] }) => { try { const result = await action(); setStatus(result); setItems(result.items); if (done && result.platformUnlock === done.when) onToast(done.message); } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const lock = async () => { try { const result = await window.privateBrowser.lockVault(); setStatus(result); setItems([]); } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const add = async () => { try { const result = await window.privateBrowser.openVaultEditor(activeOrigin); if (result) { await load(); onToast('Login encrypted in MyVault'); } } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const saveFromPage = async () => { try { const result = await window.privateBrowser.requestSaveFromPage(); if (result) { await load(); onToast('Captured login encrypted in MyVault'); } } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const sync = async () => { try { const result = await window.privateBrowser.syncVaultNow(); setStatus(result); setItems(result.items); onToast('MyVault synchronized'); } catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); } };
  const conflictAction = async (action: () => Promise<void>) => {
    setConflictBusy(true);
    try { await action(); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setConflictBusy(false); }
  };
  const resolveConflict = (choice: 'cloud' | 'local') => {
    if (!conflictReview || conflictBusy) return;
    const id = conflictReview.id;
    setConflictReview(undefined);
    void conflictAction(async () => {
      const result = await window.privateBrowser.resolveVaultConflict(choice, id);
      setStatus(result);
      setItems(result.items);
      onToast(`Kept the ${choice} vault. Both encrypted recovery copies are saved.`);
    });
  };
  const visibleItems = items.filter((item) => [item.label, item.username, item.url].some((value) => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  return (
    <div className="side-panel">
      <PanelHeader icon={KeyRound} eyebrow="MyVault broker" title="MyVault" />
      {onOpenFull && <button className="text-button" onClick={onOpenFull}><Eye size={14} /> Open full metadata view</button>}
      {clipboardSeconds > 0 && <div className="permission-card">
        <span>Vault clipboard clears in {clipboardSeconds}s</span>
        <button className="text-button" type="button" onClick={() => void clearClipboard()}>Clear now</button>
      </div>}
      <div className={`vault-health ${status.available ? '' : 'warning'}`}><ShieldCheck size={16} /><div><strong>{status.lifecycle === 'unlocked' ? 'Unlocked on this device' : status.lifecycle === 'recovery-required' ? 'Recovery required' : status.lifecycle === 'unconfigured' ? 'Connection required' : 'Locked'}</strong><span>{status.sync === 'dirty' ? 'Encrypted changes are waiting to sync.' : status.lifecycle === 'unlocked' && workspaceId !== 'banking' ? 'Saved logins autofill matching HTTPS sign-in pages.' : status.lifecycle === 'unlocked' ? 'Fill asks you to confirm the site first. Passwords are never copied or saved from pages here.' : 'Passwords stay outside this interface and browser pages.'}</span></div></div>
      <details className="vault-setup-guide settings-card">
        <summary>Setup and recovery</summary>
        <dl>
          <div><dt>Enrollment code expired</dt><dd>On an authorized MyVault device, generate a fresh code. In Private Browser choose Connect with one-time code and enter it in the secure window.</dd></div>
          <div><dt>Windows Hello unavailable</dt><dd>{status.platformUnlock === 'enrolled'
            ? 'Hello is enrolled. If it fails, choose Use master password instead.'
            : 'Choose Unlock in secure window and use your master password. If Hello is available after unlocking, choose Turn on Windows Hello unlock.'}</dd></div>
          <div><dt>Master password forgotten</dt><dd>Try an already enrolled Windows Hello unlock. Keep your encrypted vault and recovery copies while you check recovery options on an authorized MyVault device.</dd></div>
          <div><dt>Offline</dt><dd>Unlock a paired vault in the secure window. When the connection returns, use Sync to send pending encrypted changes.</dd></div>
          <div><dt>Device access revoked</dt><dd>Review this browser’s device authorization from an authorized MyVault device. Preserve the local encrypted vault and any unsynced changes while resolving access.</dd></div>
          <div><dt>Website passkeys</dt><dd>Start from your account’s security settings on the website. Choose its passkey option and follow the Windows Security prompt for the device, phone or security key where you keep the passkey. On Windows 11, use Settings → Accounts → Passkeys to view passkeys saved to this PC. MyVault’s Windows Hello option unlocks the vault.</dd></div>
        </dl>
      </details>
      {fillReadiness && <div className="settings-card vault-fill-readiness">
        <div role="status"><strong>{fillReadinessText[fillReadiness][0]}</strong><p>{fillReadinessText[fillReadiness][1]}</p></div>
        {status.lifecycle === 'unlocked' && activeOrigin && <button type="button" className="text-button" onClick={() => setFillCheck((value) => value + 1)}>Check this page again</button>}
      </div>}
      {status.lifecycle === 'unconfigured' && <button className="primary-button full" onClick={() => void window.privateBrowser.requestVaultPairing().then((result) => { setStatus(result); setItems(result.items); }).catch((error) => onToast(error.message, 'error'))}><Cloud size={16} /> Connect with one-time code</button>}
      {status.lifecycle === 'recovery-required' && <button className="recovery-button" onClick={() => void window.privateBrowser.acknowledgeVaultRecovery().then((result) => { setStatus(result); setItems(result.items); }).catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'))}>Keep recovery copy and continue</button>}
      {status.lifecycle === 'locked' && status.platformUnlock === 'enrolled' && <><button className="primary-button full" onClick={() => void hello(() => window.privateBrowser.unlockVaultWithHello())}><Fingerprint size={16} /> Unlock with Windows Hello</button><button className="text-button" onClick={() => void unlock()}><LockKeyhole size={14} /> Use master password instead</button></>}
      {status.lifecycle === 'locked' && status.platformUnlock !== 'enrolled' && <button className="primary-button full" onClick={() => void unlock()}><LockKeyhole size={16} /> Unlock in secure window</button>}
      {status.lifecycle === 'unlocked' && <div className="credential-actions"><button className="primary-button" onClick={() => void add()}><Plus size={16} /> Add login</button><button onClick={() => void sync()}><RefreshCw size={14} /> Sync</button><button onClick={() => void lock()}><LockKeyhole size={14} /> Lock</button></div>}
      {status.lifecycle === 'unlocked' && status.platformUnlock === 'available' && <button className="text-button vault-hello-toggle" onClick={() => void hello(() => window.privateBrowser.enableVaultHello(), { message: 'Windows Hello can now unlock MyVault', when: 'enrolled' })}><Fingerprint size={14} /> Turn on Windows Hello unlock</button>}
      {status.lifecycle === 'unlocked' && status.platformUnlock === 'enrolled' && <button className="text-button vault-hello-toggle" onClick={() => void hello(() => window.privateBrowser.disableVaultHello(), { message: 'Windows Hello unlock turned off', when: 'available' })}><Fingerprint size={14} /> Turn off Windows Hello unlock</button>}
      {status.lifecycle === 'conflict' && <section className="permission-card vault-conflict" aria-label="MyVault sync conflict" aria-busy={conflictBusy}>
        <strong>Review both vault copies</strong>
        <p>Private Browser saves both encrypted copies before applying your choice.</p>
        {conflictReview ? <>
          <ConflictSide heading="This computer" copy={conflictReview.local} />
          <ConflictSide heading={`Cloud version ${conflictReview.cloudVersion}`} copy={conflictReview.cloud} />
          <div className="credential-actions">
            <button disabled={conflictBusy} onClick={() => resolveConflict('cloud')}>Keep cloud copy</button>
            <button disabled={conflictBusy} onClick={() => resolveConflict('local')}>Keep local copy</button>
            <button disabled={conflictBusy} onClick={() => setConflictReview(undefined)}>Cancel review</button>
          </div>
        </> : <button disabled={conflictBusy} onClick={() => void conflictAction(async () => {
          setConflictReview(await window.privateBrowser.getVaultConflictReview());
        })}>Review versions</button>}
      </section>}
      {status.conflictRecoveryAvailable && <button className="text-button" onClick={() => void conflictAction(() => window.privateBrowser.showVaultConflictRecovery())}>Show conflict recovery files</button>}
      {status.lifecycle === 'unlocked' && formShape.hasPassword && <button className="primary-button full" onClick={() => void saveFromPage()}><ShieldCheck size={15} /> {formShape.hasUsername ? 'Save or update this login' : 'Save password from this page'}</button>}
      {status.lifecycle === 'unlocked' && legacyAvailable && <div className="permission-card"><strong>Old Private Browser vault found</strong><p>Migration makes and verifies an encrypted backup first. The old ciphertext remains until you separately remove it.</p><button className="primary-button full" onClick={() => void window.privateBrowser.migrateLegacyVault().then((report) => { onToast(`${report.validatedCount} legacy records validated`); void load(); }).catch((error) => onToast(error.message, 'error'))}>Migrate into MyVault</button><button className="text-button danger-text" onClick={() => void window.privateBrowser.cleanupLegacyVault().then((removed) => { if (removed) { setLegacyAvailable(false); onToast('Old ciphertext removed; backup retained'); } }).catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'))}>Remove old ciphertext after verification</button></div>}
      {status.lifecycle === 'unlocked' && workspaceId !== 'banking' && workspaceId !== 'development'
        && <ChromePasswordImportWizard key={'chrome-password:' + accountId + ':' + status.generation} onImported={() => { void load(); }} />}
      {status.lifecycle === 'unlocked' && <><label className="vault-search"><Search size={14} /><input aria-label="Search MyVault metadata" placeholder="Search logins" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{workspaceId !== 'banking' && <div className="credential-actions"><button onClick={() => void copyGenerated('password')}>Password</button><button onClick={() => void copyGenerated('passphrase')}>Passphrase</button><button onClick={() => void copyGenerated('pin')}>PIN</button></div>}</>}
      {status.lifecycle === 'unlocked' && workspaceId !== 'banking' && workspaceId !== 'development'
        && <VaultHealthPanel key={accountId + ':' + status.generation} accountId={accountId} items={items} onChange={load} onToast={onToast} />}
      <div className="credential-list">
        {visibleItems.map((item) => <div className="credential-card" key={item.id}>
          <div className="credential-top"><span className="site-badge">{item.label.slice(0, 1).toUpperCase()}</span><div><strong>{item.label}</strong><small>{domainFromUrl(item.url)} · {item.username}</small></div></div>
          <div className="credential-actions">
            <button onClick={() => void window.privateBrowser.autofill(item.id).then(() => onToast('Credential filled')).catch((error) => onToast(error.message, 'error'))}><Zap size={14} /> Fill</button>
            {workspaceId !== 'banking' && <button onClick={() => void copyPassword(item.id)}><Copy size={14} /> Password</button>}
            {workspaceId !== 'banking' && item.hasTotp && <button onClick={() => void copyTotp(item.id)}><Clock3 size={14} /> Code {secondsRemaining}s</button>}
            <button className="danger" title="Delete" onClick={() => void window.privateBrowser.requestVaultDelete(item.id).then(load).catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'))}><Trash2 size={14} /></button>
          </div>
        </div>)}
        {!items.length && status.lifecycle === 'unlocked' && <EmptyState icon={KeyRound} text="No logins in MyVault yet." />}
      </div>
      {status.lifecycle === 'unlocked' && workspaceId !== 'banking' && <button className="text-button" type="button" onClick={() => {
        void window.privateBrowser.resetVaultPicks(accountId)
          .then((cleared) => onToast(cleared ? 'Remembered picks cleared for this Account Space' : 'This Account Space has no remembered picks'))
          .catch((error) => onToast(error instanceof Error ? error.message : 'Could not clear the remembered picks.', 'error'));
      }}>Reset remembered picks</button>}
    </div>
  );
}

function ConflictSide({ heading, copy }: { heading: string; copy: VaultConflictSide }) {
  const [visible, setVisible] = useState(20);
  return <div className="context-card">
    <strong>{heading}</strong>
    <p>{copy.entries} entries · Updated <time dateTime={copy.updatedAt}>{new Date(copy.updatedAt).toLocaleString()}</time></p>
    {copy.changes.length ? <ul>{copy.changes.slice(0, visible).map((item) => <li key={item.id}>
      <span>{item.label}{item.username ? ` · ${item.username}` : ''}</span>
      <small>{item.kind === 'only-copy' ? 'Only in this copy' : 'Different entry metadata'}</small>
    </li>)}</ul> : <p>Entry metadata matches the other copy.</p>}
    {copy.changes.length > visible && <button type="button" className="text-button" onClick={() => setVisible((count) => count + 20)}>Show 20 more</button>}
  </div>;
}
