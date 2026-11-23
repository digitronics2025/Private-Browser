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
  const details = useRef<HTMLDetailsElement>(null);
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

  useEffect(() => {
    if (tab.popupBlockedReason && details.current) {
      details.current.open = true;
      setOpen(true);
    }
  }, [tab.popupBlockedReason]);

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

  const setPopupPreference = async (decision: 'ask' | 'allow' | 'block') => {
    readGeneration.current += 1;
    setBusy(true);
    setAnnouncement('');
    try {
      setRows(await window.privateBrowser.setPopupPreference(tab.id, origin, decision));
      setAnnouncement(decision === 'ask' ? 'Pop-up choice reset to Ask.' : `Pop-ups set to ${decision} for this Account Space and site.`);
      summary.current?.focus();
    } catch (error) { setAnnouncement(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  if (!origin || origin === 'null') return null;
  return <details ref={details} className="site-permissions" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary ref={summary}>Site permissions</summary>
    {open && <div>
      {tab.popupBlockedReason && <div className="popup-blocked-indicator" role="status">
        <strong>{tab.popupBlockedReason === 'preference' ? 'Blocked by your preference'
          : tab.popupBlockedReason === 'banking' ? 'Blocked by Banking policy' : 'Blocked by a browser security rule'}</strong>
        <small>{tab.popupBlockedReason === 'preference' ? 'Change Pop-ups below if you want to allow this site.'
          : tab.popupBlockedReason === 'banking' ? 'This cannot be changed for a Banking Account Space.' : 'Changing this site preference will not override the security rule.'}</small>
      </div>}
      <div className="site-permission-rows">
        {rows?.map((row) => <div className="site-permission-row" key={row.capability}>
          <span><strong>{permissionLabels[row.capability]}</strong>
            <small>{row.capability === 'popups' && row.decision === 'blocked-preference' ? 'Blocked by your preference'
              : row.capability === 'popups' && row.decision === 'blocked' ? 'Blocked by browser security'
                : row.decision === 'allowed' ? 'Grant allowed · ' + permissionDuration[row.duration] : row.decision === 'ask' ? 'Ask' : 'Blocked'}</small></span>
          {row.capability === 'popups' ? <select aria-label="Pop-ups" disabled={busy || tab.workspaceId === 'banking' || row.decision === 'blocked'}
            value={row.decision === 'allowed' ? 'allow' : row.decision === 'blocked-preference' ? 'block' : 'ask'}
            onChange={(event) => void setPopupPreference(event.currentTarget.value as 'ask' | 'allow' | 'block')}>
            <option value="ask">Ask</option><option value="allow">Allow</option><option value="block">Block</option>
          </select> : row.decision === 'allowed' && <button type="button" className="text-button" aria-label={'Revoke ' + permissionLabels[row.capability]}
            disabled={busy} onClick={() => void revoke(row.capability)}>Revoke</button>}
        </div>)}
      </div>
      <div role="status">{announcement || (!rows ? 'Checking site permissions…' : '')}</div>
    </div>}
  </details>;
}
