import { useState } from 'react';
import { Code2, Globe2, Landmark, Minus, Moon, Plus, Layers, LockKeyhole, ScrollText, Search, Settings, Shield, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { AccountSpaceSummary, BrowserSnapshot, BrowserTab, TrackerCategory, Workspace } from '../../electron/types';
import { inspectWebAddress, MAX_ADDRESS_CHECK_LENGTH, type AddressCheck, type AddressClue } from '../../electron/security';
import { domainFromUrl } from '../lib/format';
import { BrandMark } from './BrandMark';
import { MenuHeading, MenuItem, MenuSeparator, MenuSurface } from './Menu';
import { SitePermissions } from './SitePermissions';

function StatusRow({ ok, icon: Icon, title, detail }: { ok: boolean; icon: typeof Shield; title: string; detail: string }) {
  return (
    <div className={`status-row ${ok ? 'ok' : 'warn'}`}>
      <span className="status-row-icon" aria-hidden="true"><Icon size={16} /></span>
      <div><strong>{title}</strong><small>{detail}</small></div>
    </div>
  );
}

const trackerLabels: ReadonlyArray<[TrackerCategory, string]> = [
  ['advertising', 'Advertising'], ['analytics', 'Analytics'], ['social', 'Social'], ['telemetry', 'Telemetry'],
];

export function ShieldStatusMenu({ anchor, state, workspace, onClose, onToggleTrackers, onCompatibility, onOpenPrivacy, onOpenSettings }: {
  anchor: HTMLElement | null;
  state: BrowserSnapshot;
  workspace: Workspace;
  onClose: () => void;
  onToggleTrackers: () => void;
  onCompatibility: (origin: string, paused: boolean) => void;
  onOpenPrivacy: () => void;
  onOpenSettings: () => void;
}) {
  const site = state.trackerSite;
  const blocking = site?.blocking ?? state.trackerBlocking;
  const counts = trackerLabels.flatMap(([id, label]) => site?.counts[id] ? [[label, site.counts[id]] as const] : []);
  const total = counts.reduce((sum, [, count]) => sum + count, 0);
  return (
    <MenuSurface anchor={anchor} label="Protection status" role="dialog" className="shield-menu" onClose={onClose}>
      <div className="shield-menu-header">
        <BrandMark size={34} />
        <div><strong>Private Browser</strong><small>{workspace.protected ? `${workspace.name} · protected workspace` : 'Local protection active'}</small></div>
      </div>
      <div className="status-list">
        <StatusRow ok icon={Layers} title="Isolated Account Spaces" detail={`${state.accountSpaces.length} separate containers for cookies, storage and sign-ins`} />
        <StatusRow ok={blocking} icon={blocking ? ShieldCheck : ShieldAlert} title={blocking ? 'Tracker blocking is on' : 'Tracker blocking is paused'}
          detail={workspace.protected ? 'Tracker blocking stays on in Banking' : site?.pausedUntil
            ? 'Compatibility is on for this site' : state.trackerBlocking ? 'Known tracker domains are blocked' : 'Regular Account Spaces can load known trackers'} />
        <StatusRow ok icon={LockKeyhole} title="Websites are sandboxed" detail="Pages never reach the browser's own controls or your files" />
        {workspace.protected && <StatusRow ok icon={Landmark} title="Banking protections" detail="No AI page reading, downloads or pop-ups in this workspace" />}
      </div>
      {site && <section className="tracker-site" aria-label="Current site tracking">
        <strong><bdi>{site.origin}</bdi></strong>
        <p>{total} known tracker {total === 1 ? 'request' : 'requests'} blocked this session</p>
        {counts.length > 0 && <ul>{counts.map(([label, count]) => <li key={label}>{label} {count}</li>)}</ul>}
        {site.pausedUntil && <p>Protection resumes at <time dateTime={new Date(site.pausedUntil).toISOString()}>
          {new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(site.pausedUntil)}
        </time>.</p>}
        {(site.canPause || site.pausedUntil) && <button type="button" className="secondary-button"
          onClick={() => onCompatibility(site.origin, !site.pausedUntil)}>
          {site.pausedUntil ? 'Turn protection back on' : 'Pause for this site for 10 minutes'}
        </button>}
      </section>}
      <MenuSeparator />
      {!workspace.protected && <MenuItem role="menuitemcheckbox" checked={state.trackerBlocking} label="Block trackers" keepOpen onSelect={onToggleTrackers} />}
      <MenuItem icon={ScrollText} label="Privacy log" hint={`${state.privacyLog.length} recorded events`} onSelect={onOpenPrivacy} />
      <MenuItem icon={Settings} label="Security settings" onSelect={onOpenSettings} />
    </MenuSurface>
  );
}

function siteConnectionStatus(tab: BrowserTab, host: string) {
  if (tab.isHome) return { ok: true, icon: Search, title: 'Private Browser page', detail: 'Search or enter an address.' };
  if (tab.problem === 'certificate') return { ok: false, icon: TriangleAlert, title: 'Site certificate could not be verified',
    detail: 'Private Browser blocked this connection. Check the address before trying again.' };
  if (tab.securityWarning === 'insecure') return { ok: false, icon: TriangleAlert, title: 'Connection is not secure',
    detail: `Don't enter passwords or payment details on ${host}. Information you send could be read or changed.` };
  if (tab.securityWarning === 'idn') return { ok: false, icon: TriangleAlert, title: 'Check this address carefully',
    detail: `${host} uses international characters that can imitate another website's name.` };
  if (tab.url.startsWith('https:')) return { ok: true, icon: LockKeyhole, title: 'Connection is secure',
    detail: `Your information is encrypted on its way to ${host}.` };
  return { ok: false, icon: Code2, title: 'Local development page',
    detail: `${host} is served from this computer without encryption. Use it only for your own development work.` };
}

export function SiteInfoMenu({ anchor, tab, account, trackerBlocking, keepSiteAwake, onClose, onOpenPrivacy, onResetZoom, onToggleDeveloperTools }: {
  anchor: HTMLElement | null;
  tab: BrowserTab;
  account: AccountSpaceSummary;
  trackerBlocking: boolean;
  keepSiteAwake?: { enabled: boolean; toggle: () => void };
  onClose: () => void;
  onOpenPrivacy: () => void;
  onResetZoom: () => void;
  onToggleDeveloperTools: () => void;
}) {
  const address = tab.isHome ? undefined : inspectWebAddress(tab.url);
  const current = address && 'host' in address ? address : undefined;
  const status = siteConnectionStatus(tab, current?.host ?? domainFromUrl(tab.url));
  const zoom = tab.zoomPercent ?? 100;
  return (
    <MenuSurface anchor={anchor} label="Site information" role="dialog" className="site-info-menu" onClose={onClose}>
      <div className={`site-info-status ${status.ok ? 'ok' : 'warn'}`}>
        <span aria-hidden="true"><status.icon size={18} /></span>
        <div><strong>{status.title}</strong><p>{status.detail}</p></div>
      </div>
      <dl className="site-info-facts">
        <div><dt>Account Space</dt><dd>{account.label}</dd></div>
        <div><dt>Tracker blocking</dt><dd>{trackerBlocking ? 'On' : 'Paused'}</dd></div>
        {current && <>
          <div><dt>Host</dt><dd><bdi dir="ltr">{current.host}</bdi></dd></div>
          <div><dt>Destination</dt><dd className="site-info-url"><bdi dir="ltr">{current.destination}</bdi></dd></div>
        </>}
      </dl>
      <AddressCheckPanel key={'address:' + tab.id + ':' + tab.url} initialAddress={current?.destination ?? ''} />
      {!tab.isHome && <SitePermissions key={tab.id + ':' + tab.url} tab={tab} />}
      <MenuSeparator />
      {keepSiteAwake && <MenuItem icon={Moon} role="menuitemcheckbox" checked={keepSiteAwake.enabled} keepOpen
        label="Keep this site awake" onSelect={keepSiteAwake.toggle} />}
      {zoom !== 100 && <MenuItem icon={Globe2} label={`Reset view (${zoom}%)`} onSelect={onResetZoom} />}
      {!tab.isHome && <MenuItem icon={Code2} label="Developer tools" shortcut="F12" disabled={!tab.developerToolsAllowed} onSelect={onToggleDeveloperTools} />}
      <MenuItem icon={ScrollText} label="Privacy log" onSelect={onOpenPrivacy} />
    </MenuSurface>
  );
}

const ADDRESS_CLUES: Record<AddressClue, string> = {
  unencrypted: 'HTTP leaves information sent to this address unencrypted.',
  international: 'This host contains international characters. Compare the full host with the site you expect.',
  'ip-address': 'This host is an IP address.',
  'custom-port': 'This address uses a non-default port.',
};

function AddressCheckPanel({ initialAddress }: { initialAddress: string }) {
  const [expanded, setExpanded] = useState(false);
  const [input, setInput] = useState(initialAddress);
  const [result, setResult] = useState<AddressCheck>();
  return <details className="site-address-check" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>Check this address</summary>
    {expanded && <form onSubmit={(event) => { event.preventDefault(); setResult(inspectWebAddress(input)); }}>
      <label>Address to check<input type="text" value={input} maxLength={MAX_ADDRESS_CHECK_LENGTH} autoComplete="off"
        spellCheck={false} onChange={(event) => { setInput(event.currentTarget.value); setResult(undefined); }} /></label>
      <button type="submit" disabled={!input.trim()}>Check locally</button>
      <p>This check stays on this device. Verify the site before sharing information.</p>
      {result && <div role="status">
        {'issue' in result ? <p>{result.issue === 'credentials' ? 'This address contains sign-in details. Use the site address alone.' : 'Enter an HTTP or HTTPS website address.'}</p> : <>
          <dl className="site-info-facts">
            <div><dt>Host</dt><dd><bdi dir="ltr">{result.host}</bdi></dd></div>
            <div><dt>Destination</dt><dd className="site-info-url"><bdi dir="ltr">{result.destination}</bdi></dd></div>
          </dl>
          {result.clues.length ? <ul>{result.clues.map((clue) => <li key={clue}>{ADDRESS_CLUES[clue]}</li>)}</ul>
            : <p>No address warnings detected by this check.</p>}
        </>}
      </div>}
    </form>}
  </details>;
}

export function ZoomMenu({ anchor, zoom, onZoom, onClose }: {
  anchor: HTMLElement | null;
  zoom: number;
  onZoom: (direction: 'in' | 'out' | 'reset') => void;
  onClose: () => void;
}) {
  return (
    <MenuSurface anchor={anchor} placement="bottom-end" label="Page zoom" role="dialog" className="zoom-menu" onClose={onClose}>
      <div className="menu-zoom-row" role="group" aria-label="Zoom">
        <output className="menu-zoom-label" aria-live="polite">Zoom: {zoom}%</output>
        <button type="button" aria-label="Zoom out" title="Zoom out (Ctrl+-)" onClick={() => onZoom('out')}><Minus size={15} /></button>
        <button type="button" aria-label="Zoom in" title="Zoom in (Ctrl++)" onClick={() => onZoom('in')}><Plus size={15} /></button>
        <button type="button" className="zoom-reset" title="Reset to 100% (Ctrl+0)" disabled={zoom === 100} onClick={() => onZoom('reset')}>Reset view</button>
      </div>
    </MenuSurface>
  );
}

export function TabSearchMenu({ anchor, tabs, activeTabId, onActivate, onClose }: {
  anchor: HTMLElement | null;
  tabs: BrowserTab[];
  activeTabId: string;
  onActivate: (tabId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const matches = tabs.filter((tab) => !needle || `${tab.title} ${tab.url}`.toLocaleLowerCase().includes(needle));
  return (
    <MenuSurface anchor={anchor} placement="bottom-end" label="Search tabs" role="dialog" className="tab-search-menu" onClose={onClose}>
      <label className="menu-search">
        <Search size={16} aria-hidden="true" />
        <input
          aria-label="Search open tabs"
          placeholder="Search tabs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && matches[0]) {
              event.preventDefault();
              onActivate(matches[0].id);
              onClose();
            }
          }}
        />
      </label>
      <MenuHeading>Open tabs · {tabs.length}</MenuHeading>
      <div className="tab-search-results">
        {matches.map((tab) => (
          <MenuItem
            key={tab.id}
            role="menuitemradio"
            checked={tab.id === activeTabId}
            leading={tab.favicon ? <img src={tab.favicon} alt="" /> : <Globe2 size={16} />}
            label={tab.isHome ? 'New tab' : tab.title || 'Untitled'}
            hint={tab.isHome ? 'Private Browser' : domainFromUrl(tab.url)}
            onSelect={() => onActivate(tab.id)}
          />
        ))}
        {!matches.length && <p className="menu-empty">No open tab matches “{query}”.</p>}
      </div>
    </MenuSurface>
  );
}
