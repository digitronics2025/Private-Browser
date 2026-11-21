import type { FormEvent, RefObject } from 'react';
import { useEffect, useState } from 'react';
import { ArrowLeft, Asterisk, ArrowRight, Home, KeyRound, LockKeyhole, MoreVertical, PanelRight, RefreshCw, Search, SlidersHorizontal, Sparkles, Star, TriangleAlert, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { AccountSpaceSummary, AddressMatch, BrowserTab, Workspace } from '../../electron/types';
import { MAX_ADDRESS_QUERY_LENGTH } from '../../electron/address-matches';
import { AccountAvatar, accountNeedsAction } from '../lib/accounts';
import { useOverlayLayer } from './overlay';

export interface NavigationToolbarProps {
  /** "Search Google or enter address" — names the engine chosen in Settings. */
  searchPrompt: string;
  tab: BrowserTab;
  workspace: Workspace;
  account: AccountSpaceSummary;
  address: string;
  addressRef: RefObject<HTMLInputElement>;
  bookmarked: boolean;
  vaultAvailable: boolean;
  sidePanelOpen: boolean;
  assistantOpen: boolean;
  claudeOpen: boolean;
  siteInfoButtonRef: RefObject<HTMLButtonElement>;
  profileButtonRef: RefObject<HTMLButtonElement>;
  menuButtonRef: RefObject<HTMLButtonElement>;
  siteInfoOpen: boolean;
  zoomOpen: boolean;
  zoomButtonRef: RefObject<HTMLButtonElement>;
  profileOpen: boolean;
  menuOpen: boolean;
  onAddressChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  onOpenAddressMatch: (match: AddressMatch) => void;
  onBack: () => void;
  onForward: () => void;
  onReloadOrStop: () => void;
  onHome: () => void;
  onSiteInfo: () => void;
  onToggleBookmark: () => void;
  onOpenVault: () => void;
  onZoomMenu: () => void;
  onToggleSidePanel: () => void;
  onAssistant: () => void;
  onClaude: () => void;
  onProfile: () => void;
  onMenu: () => void;
}

export function NavigationToolbar(props: NavigationToolbarProps) {
  const { tab, account, workspace } = props;
  const zoom = tab.zoomPercent ?? 100;
  const warning = tab.securityWarning;
  const needsAction = accountNeedsAction(account);
  const [draftTabId, setDraftTabId] = useState<string>();
  const [response, setResponse] = useState<{ tabId: string; query: string; matches: AddressMatch[] }>();
  const [selected, setSelected] = useState(-1);
  const query = props.address.trim();
  const matches = draftTabId === tab.id && response?.tabId === tab.id && response.query === query ? response.matches : [];
  const ready = useOverlayLayer(matches.length > 0);
  const expanded = matches.length > 0 && ready;

  useEffect(() => {
    if (draftTabId !== tab.id || query.length < 2 || query.length > MAX_ADDRESS_QUERY_LENGTH) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void window.privateBrowser.addressMatches?.(account.id, query).then((matches) => {
        if (current && Array.isArray(matches)) {
          setSelected(-1);
          setResponse({ tabId: tab.id, query, matches });
        }
      }).catch(() => undefined);
    }, 90);
    return () => { current = false; window.clearTimeout(timer); };
  }, [account.id, draftTabId, query, tab.id]);

  useEffect(() => {
    if (expanded && selected >= 0) document.getElementById('address-match-' + selected)?.scrollIntoView({ block: 'nearest' });
  }, [expanded, selected]);

  const closeMatches = () => {
    setDraftTabId(undefined);
    setResponse(undefined);
    setSelected(-1);
  };
  const chooseMatch = (match: AddressMatch) => {
    closeMatches();
    props.onOpenAddressMatch(match);
  };
  return (
    <nav className="toolbar" aria-label="Navigation">
      <button type="button" className="toolbar-button" aria-label="Back" title="Back (Alt+Left)" disabled={!tab.canGoBack} onClick={props.onBack}><ArrowLeft size={18} /></button>
      <button type="button" className="toolbar-button" aria-label="Forward" title="Forward (Alt+Right)" disabled={!tab.canGoForward} onClick={props.onForward}><ArrowRight size={18} /></button>
      <button type="button" className="toolbar-button" aria-label={tab.loading ? 'Stop loading' : 'Reload'} title={tab.loading ? 'Stop loading' : 'Reload (Ctrl+R)'} disabled={tab.isHome && !tab.loading} onClick={props.onReloadOrStop}>
        {tab.loading ? <X size={18} /> : <RefreshCw size={17} />}
      </button>
      <button type="button" className="toolbar-button optional" aria-label="Home" title="Home (Alt+Home)" onClick={props.onHome}><Home size={18} /></button>

      <form className={`omnibox ${warning ? 'has-warning' : ''}`} onSubmit={(event) => {
        const match = matches[selected];
        if (match) {
          event.preventDefault();
          chooseMatch(match);
        } else {
          closeMatches();
          props.onSubmit(event);
        }
      }} role="search">
        <button
          ref={props.siteInfoButtonRef}
          type="button"
          className={`omnibox-site-info ${warning ? 'warn' : ''}`}
          aria-label={tab.isHome ? 'Search information' : warning ? 'View site information: connection warning' : 'View site information'}
          aria-haspopup="dialog"
          aria-expanded={props.siteInfoOpen}
          title="View site information"
          onClick={props.onSiteInfo}
        >
          {tab.isHome ? <Search size={16} /> : warning ? <TriangleAlert size={16} /> : <SlidersHorizontal size={16} />}
        </button>
        {!tab.isHome && warning && (
          <span className="security-chip" role="status" title={warning === 'idn' ? 'Internationalized domain: verify this address carefully' : 'Connection is not encrypted'}>
            {warning === 'idn' ? 'Check domain' : 'Not secure'}
          </span>
        )}
        <input
          ref={props.addressRef}
          role="combobox"
          aria-label="Address and search bar"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? 'address-matches' : undefined}
          aria-activedescendant={expanded && selected >= 0 ? 'address-match-' + selected : undefined}
          value={props.address}
          onChange={(event) => {
            setDraftTabId(tab.id);
            setResponse(undefined);
            setSelected(-1);
            props.onAddressChange(event.target.value);
          }}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={closeMatches}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape' && draftTabId === tab.id) {
              event.preventDefault();
              event.stopPropagation();
              closeMatches();
            }
            if (matches.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              setSelected((current) => event.key === 'ArrowDown'
                ? (current + 1) % matches.length
                : (current <= 0 ? matches.length - 1 : current - 1));
            }
          }}
          placeholder={props.searchPrompt}
          spellCheck={false}
          autoComplete="off"
        />
        {expanded && <div className="address-matches" id="address-matches" role="listbox" aria-label="Local address matches">
          {matches.map((match, index) => <div
            key={match.source + '-' + match.id}
            id={'address-match-' + index}
            role="option"
            aria-selected={selected === index}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => chooseMatch(match)}
          >
            <strong>{match.title || match.url}</strong>
            <small>{match.source === 'tab' ? 'Switch to tab' : match.source === 'bookmark' ? 'Bookmark' : 'History'} · {match.url}</small>
          </div>)}
        </div>}
        {(zoom !== 100 || props.zoomOpen) && !tab.isHome && (
          <button ref={props.zoomButtonRef} type="button" className={`omnibox-action ${props.zoomOpen ? 'active' : ''}`} aria-label={`Zoom: ${zoom}%`} aria-haspopup="dialog" aria-expanded={props.zoomOpen} title={`Zoom: ${zoom}%`} onClick={props.onZoomMenu}>
            {zoom > 100 ? <ZoomIn size={16} /> : <ZoomOut size={16} />}
          </button>
        )}
        {props.vaultAvailable && (
          <button type="button" className="omnibox-action" aria-label="Open MyVault" title="Passwords and MyVault" onClick={props.onOpenVault}><KeyRound size={16} /></button>
        )}
        {!tab.isHome && (
          <button type="button" className={`omnibox-action ${props.bookmarked ? 'active' : ''}`} aria-label={props.bookmarked ? 'Remove bookmark' : 'Bookmark this tab'} aria-pressed={props.bookmarked} title={props.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this tab (Ctrl+D)'} onClick={props.onToggleBookmark}>
            <Star size={16} fill={props.bookmarked ? 'currentColor' : 'none'} />
          </button>
        )}
      </form>

      <button type="button" className={`toolbar-button ${props.sidePanelOpen ? 'selected' : ''}`} aria-label="Side panel" aria-pressed={props.sidePanelOpen} title="Show side panel" onClick={props.onToggleSidePanel}><PanelRight size={18} /></button>
      <button type="button" className={`toolbar-button optional ${props.claudeOpen ? 'selected' : ''}`} aria-label="Claude" aria-pressed={props.claudeOpen} title="Claude" onClick={props.onClaude}><Asterisk size={18} /></button>
      <button type="button" className={`toolbar-button optional ${props.assistantOpen ? 'selected' : ''}`} aria-label="AI assistant" aria-pressed={props.assistantOpen} title="Private AI assistant" onClick={props.onAssistant}><Sparkles size={18} /></button>
      <button
        ref={props.profileButtonRef}
        type="button"
        className={`profile-button ring-${account.color}${workspace.protected ? ' protected-profile' : ''}${props.profileOpen ? ' open' : ''}`}
        aria-label={`Account Space: ${account.label}${needsAction ? ', action required' : ''}`}
        aria-description={`Workspace: ${workspace.name}${workspace.protected ? ', protected' : ''}`}
        aria-haspopup="menu"
        aria-expanded={props.profileOpen}
        title={`${workspace.name} / ${account.label}${account.email ? ` · ${account.email}` : ''}`}
        onClick={props.onProfile}
      >
        {workspace.protected ? <LockKeyhole className="profile-lock" size={18} aria-hidden="true" /> : <AccountAvatar account={account} />}
        <span className="profile-identity" aria-hidden="true">
          <small>{workspace.name}</small>
          {account.label !== workspace.name && <strong>{account.label}</strong>}
        </span>
        {needsAction && <span className="profile-badge" aria-hidden="true">!</span>}
      </button>
      <button ref={props.menuButtonRef} type="button" className={`toolbar-button ${props.menuOpen ? 'selected' : ''}`} aria-label="Browser menu" aria-haspopup="menu" aria-expanded={props.menuOpen} title="Customize and control Private Browser" onClick={props.onMenu}>
        <MoreVertical size={18} />
      </button>
    </nav>
  );
}
