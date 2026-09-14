import { useState } from 'react';
import { Code2, Globe2, Landmark, Layers, LockKeyhole, ScrollText, Search, Settings, Shield, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { AccountSpaceSummary, BrowserSnapshot, BrowserTab, Workspace } from '../../electron/types';
import { domainFromUrl } from '../lib/format';
import { BrandMark } from './BrandMark';
import { MenuHeading, MenuItem, MenuSeparator, MenuSurface } from './Menu';

function StatusRow({ ok, icon: Icon, title, detail }: { ok: boolean; icon: typeof Shield; title: string; detail: string }) {
  return (
    <div className={`status-row ${ok ? 'ok' : 'warn'}`}>
      <span className="status-row-icon" aria-hidden="true"><Icon size={16} /></span>
      <div><strong>{title}</strong><small>{detail}</small></div>
    </div>
  );
}

export function ShieldStatusMenu({ anchor, state, workspace, onClose, onToggleTrackers, onOpenPrivacy, onOpenSettings }: {
  anchor: HTMLElement | null;
  state: BrowserSnapshot;
  workspace: Workspace;
  onClose: () => void;
  onToggleTrackers: () => void;
  onOpenPrivacy: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <MenuSurface anchor={anchor} label="Protection status" role="dialog" className="shield-menu" onClose={onClose}>
      <div className="shield-menu-header">
        <BrandMark size={34} />
        <div><strong>Private Browser</strong><small>{workspace.protected ? `${workspace.name} · protected workspace` : 'Local protection active'}</small></div>
      </div>
      <div className="status-list">
        <StatusRow ok icon={Layers} title="Isolated Account Spaces" detail={`${state.accountSpaces.length} separate containers for cookies, storage and sign-ins`} />
        <StatusRow ok={state.trackerBlocking} icon={state.trackerBlocking ? ShieldCheck : ShieldAlert} title={state.trackerBlocking ? 'Tracker blocking is on' : 'Tracker blocking is paused'} detail={state.trackerBlocking ? 'Known trackers are blocked in every space' : 'Known trackers can load until you turn this back on'} />
        <StatusRow ok icon={LockKeyhole} title="Websites are sandboxed" detail="Pages never reach the browser's own controls or your files" />
        {workspace.protected && <StatusRow ok icon={Landmark} title="Banking protections" detail="No AI page reading, downloads or pop-ups in this workspace" />}
      </div>
      <MenuSeparator />
      <MenuItem role="menuitemcheckbox" checked={state.trackerBlocking} label="Block trackers" keepOpen onSelect={onToggleTrackers} />
      <MenuItem icon={ScrollText} label="Privacy log" hint={`${state.privacyLog.length} recorded events`} onSelect={onOpenPrivacy} />
      <MenuItem icon={Settings} label="Security settings" onSelect={onOpenSettings} />
    </MenuSurface>
  );
}

export function SiteInfoMenu({ anchor, tab, account, trackerBlocking, onClose, onOpenPrivacy, onResetZoom, onToggleDeveloperTools }: {
  anchor: HTMLElement | null;
  tab: BrowserTab;
  account: AccountSpaceSummary;
  trackerBlocking: boolean;
  onClose: () => void;
  onOpenPrivacy: () => void;
  onResetZoom: () => void;
  onToggleDeveloperTools: () => void;
}) {
  const host = domainFromUrl(tab.url);
  const encrypted = tab.url.startsWith('https:');
  // Only an https URL may be described as encrypted. Plain-HTTP loopback pages
  // carry no warning chip (they are local development servers), but they are
  // still unencrypted and must never be called secure.
  const status = tab.isHome
    ? { ok: true, icon: Search, title: 'Private Browser page', detail: 'Search privately or enter an address.' }
    : tab.securityWarning === 'insecure'
      ? { ok: false, icon: TriangleAlert, title: 'Connection is not secure', detail: `Don't enter passwords or payment details on ${host}. Information you send could be read or changed.` }
      : tab.securityWarning === 'idn'
        ? { ok: false, icon: TriangleAlert, title: 'Check this address carefully', detail: `${host} uses international characters that can imitate another website's name.` }
        : encrypted
          ? { ok: true, icon: LockKeyhole, title: 'Connection is secure', detail: `Your information is encrypted on its way to ${host}.` }
          : { ok: false, icon: Code2, title: 'Local development page', detail: `${host} is served from this computer without encryption. Use it only for your own development work.` };
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
        {!tab.isHome && <div><dt>Address</dt><dd className="site-info-url">{tab.url}</dd></div>}
      </dl>
      <MenuSeparator />
      {zoom !== 100 && <MenuItem icon={Globe2} label={`Reset zoom (${zoom}%)`} onSelect={onResetZoom} />}
      {!tab.isHome && <MenuItem icon={Code2} label="Developer tools" shortcut="F12" disabled={!tab.developerToolsAllowed} onSelect={onToggleDeveloperTools} />}
      <MenuItem icon={ScrollText} label="Privacy log" onSelect={onOpenPrivacy} />
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
