import type { FormEvent, RefObject } from 'react';
import { ArrowLeft, ArrowRight, Home, KeyRound, MoreVertical, PanelRight, RefreshCw, Search, SlidersHorizontal, Sparkles, Star, TriangleAlert, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { AccountSpaceSummary, BrowserTab } from '../../electron/types';
import { AccountAvatar, accountNeedsAction } from '../lib/accounts';

export interface NavigationToolbarProps {
  tab: BrowserTab;
  account: AccountSpaceSummary;
  address: string;
  addressRef: RefObject<HTMLInputElement>;
  bookmarked: boolean;
  vaultAvailable: boolean;
  sidePanelOpen: boolean;
  assistantOpen: boolean;
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
  onProfile: () => void;
  onMenu: () => void;
}

export function NavigationToolbar(props: NavigationToolbarProps) {
  const { tab, account } = props;
  const zoom = tab.zoomPercent ?? 100;
  const warning = tab.securityWarning;
  const needsAction = accountNeedsAction(account);
  return (
    <nav className="toolbar" aria-label="Navigation">
      <button type="button" className="toolbar-button" aria-label="Back" title="Back (Alt+Left)" disabled={!tab.canGoBack} onClick={props.onBack}><ArrowLeft size={18} /></button>
      <button type="button" className="toolbar-button" aria-label="Forward" title="Forward (Alt+Right)" disabled={!tab.canGoForward} onClick={props.onForward}><ArrowRight size={18} /></button>
      <button type="button" className="toolbar-button" aria-label={tab.loading ? 'Stop loading' : 'Reload'} title={tab.loading ? 'Stop loading' : 'Reload (Ctrl+R)'} disabled={tab.isHome && !tab.loading} onClick={props.onReloadOrStop}>
        {tab.loading ? <X size={18} /> : <RefreshCw size={17} />}
      </button>
      <button type="button" className="toolbar-button optional" aria-label="Home" title="New Tab page (Alt+Home)" onClick={props.onHome}><Home size={18} /></button>

      <form className={`omnibox ${warning ? 'has-warning' : ''}`} onSubmit={props.onSubmit} role="search">
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
          aria-label="Address and search bar"
          value={props.address}
          onChange={(event) => props.onAddressChange(event.target.value)}
          onFocus={(event) => event.currentTarget.select()}
          placeholder="Search privately or enter address"
          spellCheck={false}
          autoComplete="off"
        />
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
      <button type="button" className={`toolbar-button optional ${props.assistantOpen ? 'selected' : ''}`} aria-label="AI assistant" aria-pressed={props.assistantOpen} title="Private AI assistant" onClick={props.onAssistant}><Sparkles size={18} /></button>
      <button
        ref={props.profileButtonRef}
        type="button"
        className={`profile-button ring-${account.color} ${props.profileOpen ? 'open' : ''}`}
        aria-label={`Account Space: ${account.label}${needsAction ? ', action required' : ''}`}
        aria-haspopup="menu"
        aria-expanded={props.profileOpen}
        title={`${account.label}${account.email ? ` · ${account.email}` : ''}`}
        onClick={props.onProfile}
      >
        <AccountAvatar account={account} />
        {needsAction && <span className="profile-badge" aria-hidden="true">!</span>}
      </button>
      <button ref={props.menuButtonRef} type="button" className={`toolbar-button ${props.menuOpen ? 'selected' : ''}`} aria-label="Browser menu" aria-haspopup="menu" aria-expanded={props.menuOpen} title="Customize and control Private Browser" onClick={props.onMenu}>
        <MoreVertical size={18} />
      </button>
    </nav>
  );
}
