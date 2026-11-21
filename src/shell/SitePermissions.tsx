import { useEffect, useRef, useState } from 'react';
import type { BrowserTab, PermissionCapability, SitePermissionStatus } from '../../electron/types';
import { permissionDuration, permissionLabels } from '../lib/permission-labels';

const capturePermissions = new Set<PermissionCapability>(['camera', 'microphone', 'camera-and-microphone', 'display-capture']);

export function SitePermissions({ tab }: { tab: BrowserTab }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SitePermissionStatus[]>();
  const [announcement, setAnnouncement] = useState('');
  const [busy, setBusy] = useState(false);
  const readGeneration = useRef(0);
  const summary = useRef<HTMLElement>(null);
  const origin = URL.canParse(tab.url) ? new URL(tab.url).origin : '';

  useEffect(() => {
    if (!open || !origin) return;
    setRows(undefined);
    setAnnouncement('');
    const request = ++readGeneration.current;
    void window.privateBrowser.getSitePermissions(tab.id, origin).then((value) => {
      if (request === readGeneration.current) setRows(value);
    }).catch((error: unknown) => {
      if (request === readGeneration.current) setAnnouncement(error instanceof Error ? error.message : String(error));
    });
    return () => { readGeneration.current += 1; };
  }, [open, origin, tab.id]);

  const revoke = async (capability: PermissionCapability) => {
    readGeneration.current += 1;
    setBusy(true);
    setAnnouncement('');
    try {
      setRows(await window.privateBrowser.revokeSitePermission(tab.id, origin, capability));
      setAnnouncement(capturePermissions.has(capability)
        ? permissionLabels[capability] + ' revoked. Close the tab to stop any active capture.'
        : permissionLabels[capability] + ' revoked. The site will ask again.');
      summary.current?.focus();
    } catch (error) { setAnnouncement(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  if (!origin || origin === 'null') return null;
  return <details className="site-permissions" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary ref={summary}>Site permissions</summary>
    {open && <div>
      <div className="site-permission-rows">
        {rows?.map((row) => <div className="site-permission-row" key={row.capability}>
          <span><strong>{permissionLabels[row.capability]}</strong>
            <small>{row.decision === 'allowed' ? 'Grant allowed · ' + permissionDuration[row.duration] : row.decision === 'ask' ? 'Ask' : 'Blocked'}</small></span>
          {row.decision === 'allowed' && <button type="button" className="text-button" aria-label={'Revoke ' + permissionLabels[row.capability]}
            disabled={busy} onClick={() => void revoke(row.capability)}>Revoke</button>}
        </div>)}
      </div>
      <div role="status">{announcement || (!rows ? 'Checking site permissions…' : '')}</div>
    </div>}
  </details>;
}
