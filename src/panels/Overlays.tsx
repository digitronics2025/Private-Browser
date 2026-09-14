import { useEffect, useRef, useState } from 'react';
import { Shield, TriangleAlert } from 'lucide-react';
import type { BrowserSnapshot, PermissionDecision } from '../../electron/types';

export function PermissionOverlay({ state, onRespond }: { state: BrowserSnapshot; onRespond: (decision: PermissionDecision, sourceId?: string) => void }) {
  const prompt = state.pendingPermission!;
  const account = state.accountSpaces.find((item) => item.id === prompt.accountSpaceId);
  const [sourceId, setSourceId] = useState(prompt.displaySources?.[0]?.id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, []);
  return <div className="modal-backdrop permission-backdrop"><div className="permission-dialog" ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="permission-title"><span className="permission-icon"><Shield size={23} /></span><small>{account?.label ?? 'Account Space'} · exact origin</small><h2 id="permission-title">Allow {prompt.capability.replaceAll('-', ' ')}?</h2><p><strong>{prompt.origin}</strong> requested this capability. The choice applies only to this Account Space and exact origin.</p>{prompt.displaySources && <select aria-label="Display source" value={sourceId} onChange={(event) => setSourceId(event.target.value)}>{prompt.displaySources.map((source) => <option value={source.id} key={source.id}>{source.name}</option>)}</select>}<div className="permission-actions"><button onClick={() => onRespond('deny')}>Deny</button><button onClick={() => onRespond('allow-once', sourceId)}>Allow once</button><button onClick={() => onRespond('allow-session', sourceId)}>This session</button><button className="primary-button" onClick={() => onRespond('allow-always', sourceId)}>Always here</button></div></div></div>;
}

export function RecoveryOverlay({ state }: { state: BrowserSnapshot }) {
  const recovery = state.recovery!;
  const act = (action: typeof recovery.actions[number]) => {
    let confirmation: string | undefined;
    if (action === 'restore-v1' && !window.confirm('Restore the preserved version-1 browser state? The current unreadable v2 manifest will be preserved separately.')) return;
    if (action === 'restore-v1') confirmation = 'RESTORE_V1';
    if (action === 'fresh-start' && !window.confirm(`Fresh start ${recovery.scope === 'account-space' ? 'this corrupt Account Space' : 'the browser state'}? Existing unreadable files will be preserved, but a new empty state will open.`)) return;
    if (action === 'fresh-start') confirmation = 'FRESH_START';
    void window.privateBrowser.performRecoveryAction(action, confirmation);
  };
  return <div className="modal-backdrop recovery-backdrop"><div className="permission-dialog recovery-dialog" role="alertdialog" aria-modal="true"><span className="permission-icon danger"><TriangleAlert size={23} /></span><small>READ-ONLY RECOVERY</small><h2>Browser data needs attention</h2><p>The original data was preserved{recovery.backupAvailable ? ' with a timestamped backup' : ''}. Writes stay disabled so one bad file cannot damage other Account Spaces.</p><div className="recovery-options">{recovery.actions.map((action) => <button key={action} onClick={() => act(action)}>{action.replaceAll('-', ' ')}</button>)}</div><p className="recovery-note">Retry restarts without replacing anything. Restore and fresh start always require explicit confirmation.</p></div></div>;
}
