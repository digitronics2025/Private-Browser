import { useEffect, useState } from 'react';
import type { AccountSpaceId, PermissionCapability, PermissionGrantSummary } from '../../electron/types';
import { permissionDuration, permissionLabels } from '../lib/permission-labels';

export function AccountPermissionGrants({ accountSpaceId }: { accountSpaceId: AccountSpaceId }) {
  const [open, setOpen] = useState(false);
  const [grants, setGrants] = useState<PermissionGrantSummary[]>();
  const [error, setError] = useState('');
  const [origin, setOrigin] = useState('');
  const [capability, setCapability] = useState('');

  useEffect(() => {
    if (!open) return;
    let current = true;
    setGrants(undefined);
    setError('');
    void window.privateBrowser.listAccountPermissionGrants(accountSpaceId).then((result) => {
      if (current) setGrants(result);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { current = false; };
  }, [accountSpaceId, open]);

  const visible = grants?.filter((item) => (!capability || item.capability === capability)
    && item.origin.toLowerCase().includes(origin.trim().toLowerCase()));
  return <details className="manager-section account-permissions" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Site permission grants</summary>
    {open && <div>
      <div className="permission-filters">
        <label>Filter by origin<input type="search" value={origin} maxLength={200} onChange={(event) => setOrigin(event.currentTarget.value)} /></label>
        <label>Filter by capability<select value={capability} onChange={(event) => setCapability(event.currentTarget.value)}>
          <option value="">All capabilities</option>
          {(Object.keys(permissionLabels) as PermissionCapability[]).map((key) => <option key={key} value={key}>{permissionLabels[key]}</option>)}
        </select></label>
      </div>
      {visible?.length ? <ul className="account-grants">
        {visible.map((item) => <li key={item.origin + '|' + item.capability}>
          <strong>{item.origin}</strong><span>{permissionLabels[item.capability]} · {permissionDuration[item.duration]}</span>
        </li>)}
      </ul> : <p role="status">{error || (!visible ? 'Loading permission grants…' : grants?.length ? 'No grants match your filters.' : 'This Account Space has no reusable site grants.')}</p>}
    </div>}
  </details>;
}
