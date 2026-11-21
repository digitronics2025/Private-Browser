import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { ChevronDown, ChevronRight, Globe2, LoaderCircle, Pin, Plus, Volume2, VolumeX, X } from 'lucide-react';
import type { BrowserTab, TabBatchScope, TabGroup, TabOrganizationAction } from '../../electron/types';
import { tabBatchTargets } from '../../electron/tab-organization';
import { BrandMark } from './BrandMark';
import { MenuItem, MenuSurface, SubmenuItem } from './Menu';

interface DragState {
  id: string;
  from: number;
  to: number;
  startX: number;
  dx: number;
  width: number;
  centers: number[];
  pointerId: number;
  active: boolean;
}

export interface WindowTabStripProps {
  tabs: BrowserTab[];
  activeTabId: string;
  groups: TabGroup[];
  shieldButtonRef: RefObject<HTMLButtonElement>;
  tabSearchButtonRef: RefObject<HTMLButtonElement>;
  shieldOpen: boolean;
  tabSearchOpen: boolean;
  onShield: () => void;
  onTabSearch: () => void;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNewTab: () => void;
  onMove: (tabId: string, toIndex: number) => void;
  onMute: (tabId: string, muted: boolean) => void;
  onOrganize: (action: TabOrganizationAction) => void;
  onCreateGroup: (tabId: string) => void;
  onDuplicate: (id: string) => void;
  onCopyAddress: (url: string) => void;
  onCloseBatch: (id: string, scope: TabBatchScope, confirmedIds: string[]) => void;
}

/**
 * The top row of the window: brand/protection button, tabs, new-tab button and
 * the empty draggable area. The native Windows caption buttons are drawn by the
 * title-bar overlay into the space this strip leaves free on the right.
 */
export function WindowTabStrip({ tabs, groups, activeTabId, shieldButtonRef, tabSearchButtonRef, shieldOpen, tabSearchOpen, onShield, onTabSearch, onActivate, onClose, onNewTab, onMove, onMute, onOrganize, onCreateGroup, onDuplicate, onCopyAddress, onCloseBatch }: WindowTabStripProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{ tabId: string; point?: { x: number; y: number } }>();
  const tabMenu = tabs.find((tab) => tab.id === menu?.tabId);
  const batchActions: Array<{ scope: TabBatchScope; label: string }> = [
    { scope: 'other', label: 'Close other tabs' },
    { scope: 'right', label: 'Close tabs to the right' },
    { scope: 'group', label: 'Close tab group' },
  ];
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const visibleTabs = tabs.filter((tab) => tab.id === activeTabId || !tab.groupId || !groupsById.get(tab.groupId)?.collapsed);

  useEffect(() => {
    tabRefs.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, tab: BrowserTab, index: number) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    if (tab.id !== activeTabId) onActivate(tab.id);
    const rects = visibleTabs.map((candidate) => tabRefs.current.get(candidate.id)?.getBoundingClientRect());
    if (rects.some((rect) => !rect)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      id: tab.id,
      from: index,
      to: index,
      startX: event.clientX,
      dx: 0,
      width: rects[index]!.width,
      centers: rects.map((rect) => rect!.left + rect!.width / 2),
      pointerId: event.pointerId,
      active: false,
    });
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dx = event.clientX - drag.startX;
    if (!drag.active && Math.abs(dx) < 5) return;
    const center = drag.centers[drag.from] + dx;
    const to = drag.centers.filter((value, index) => index !== drag.from && value < center).length;
    setDrag({ ...drag, dx, to, active: true });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const target = visibleTabs[drag.to];
    if (target && drag.active && drag.to !== drag.from) onMove(drag.id, tabs.findIndex((tab) => tab.id === target.id));
    setDrag(null);
  };

  const shiftFor = (index: number): number => {
    if (!drag?.active || index === drag.from) return 0;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.width;
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return drag.width;
    return 0;
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, tab: BrowserTab, index: number) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      setMenu({ tabId: tab.id });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate(tab.id);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      onClose(tab.id);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? visibleTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length;
      const target = visibleTabs[next];
      tabRefs.current.get(target.id)?.focus();
      onActivate(target.id);
    }
  };

  const tabElements = tabs.map((tab, orderedIndex) => {
    const active = tab.id === activeTabId;
    const dragging = drag?.active && drag.id === tab.id;
    const title = tab.isHome ? 'New tab' : tab.title || 'Untitled';
    const group = tab.groupId ? groupsById.get(tab.groupId) : undefined;
    const groupStart = group && tabs[orderedIndex - 1]?.groupId !== group.id;
    const index = visibleTabs.findIndex((candidate) => candidate.id === tab.id);
    return (
      <Fragment key={tab.id}>
      {groupStart && <button type="button" className="tab-group-toggle" aria-expanded={!group.collapsed}
        onClick={() => onOrganize({ kind: 'collapse-group', groupId: group.id, collapsed: !group.collapsed })}>
        {group.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}{group.name}
      </button>}
      {index >= 0 && <div
        ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id); }}
        role="tab"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        aria-label={`${title}${tab.loading ? ', loading' : ''}${tab.audible && !tab.muted ? ', playing audio' : ''}${tab.muted ? ', muted' : ''}`}
        title={title}
        className={`browser-tab ${active ? 'active' : ''} ${dragging ? 'dragging' : ''} ${drag?.active ? 'reordering' : ''} ${tab.pinned ? 'pinned' : ''} ${group ? 'grouped' : ''}`}
        style={{ transform: dragging ? `translateX(${drag.dx}px)` : shiftFor(index) ? `translateX(${shiftFor(index)}px)` : undefined }}
        onPointerDown={(event) => beginDrag(event, tab, index)}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={() => setDrag(null)}
        onLostPointerCapture={() => setDrag(null)}
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
        onContextMenu={(event) => { event.preventDefault(); setMenu({ tabId: tab.id, point: { x: event.clientX, y: event.clientY } }); }}
        onKeyDown={(event) => onTabKeyDown(event, tab, index)}
      >
        <span className="tab-icon" aria-hidden="true">
          {tab.loading ? <LoaderCircle className="spin" size={15} /> : tab.isHome ? <BrandMark size={16} /> : tab.favicon ? <img src={tab.favicon} alt="" draggable={false} /> : <Globe2 size={15} />}
        </span>
        <span className="tab-title">{title}</span>
        {(tab.audible || tab.muted) && (
          <button type="button" className="tab-audio" aria-label={tab.muted ? `Unmute ${title}` : `Mute ${title}`} title={tab.muted ? 'Unmute tab' : 'Mute tab'} onClick={(event) => { event.stopPropagation(); onMute(tab.id, !tab.muted); }}>
            {tab.muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
        )}
        <button type="button" className="tab-close" tabIndex={active ? 0 : -1} aria-label={`Close ${title}`} title="Close tab (Ctrl+W)" onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}>
          <X size={14} />
        </button>
      </div>}
      </Fragment>
    );
  });
  const pinnedCount = tabs.filter((tab) => tab.pinned).length;

  return (
    <header className="tab-strip">
      <button
        ref={shieldButtonRef}
        type="button"
        className="strip-button shield-button"
        aria-label="Private Browser protection status"
        aria-haspopup="dialog"
        aria-expanded={shieldOpen}
        title="Protection status"
        onClick={onShield}
      >
        <BrandMark size={20} />
      </button>
      <div className="tab-strip-content" role="tablist" aria-label="Open tabs">
        {pinnedCount > 0 && <div className="tab-scroller pinned-tabs" onWheel={(event) => { if (event.deltaY) event.currentTarget.scrollLeft += event.deltaY; }}>
          <div className="tab-list">{tabElements.slice(0, pinnedCount)}</div>
        </div>}
        <div className="tab-scroller" ref={scrollerRef} onWheel={(event) => { if (scrollerRef.current && event.deltaY) scrollerRef.current.scrollLeft += event.deltaY; }}>
          <div className="tab-list">{tabElements.slice(pinnedCount)}</div>
        </div>
      </div>
      <button type="button" className="strip-button new-tab-button" aria-label="New tab" title="New tab (Ctrl+T)" onClick={onNewTab}>
        <Plus size={18} />
      </button>
      <div className="tab-strip-drag" aria-hidden="true" />
      <button
        ref={tabSearchButtonRef}
        type="button"
        className="strip-button tab-search-button"
        aria-label="Search tabs"
        aria-haspopup="dialog"
        aria-expanded={tabSearchOpen}
        title="Search tabs (Ctrl+Shift+A)"
        onClick={onTabSearch}
      >
        <ChevronDown size={16} />
      </button>
      <div className="caption-buttons-space" aria-hidden="true" />
      {tabMenu && menu && <MenuSurface label="Tab actions" anchor={tabRefs.current.get(tabMenu.id)} point={menu.point} onClose={() => setMenu(undefined)}>
        <MenuItem label="Duplicate tab" onSelect={() => onDuplicate(tabMenu.id)} />
        <MenuItem label="Copy address" disabled={tabMenu.isHome} onSelect={() => onCopyAddress(tabMenu.url)} />
        <MenuItem icon={Pin} label={tabMenu.pinned ? 'Unpin tab' : 'Pin tab'} onSelect={() => onOrganize({ kind: 'pin', tabId: tabMenu.id, pinned: !tabMenu.pinned })} />
        <SubmenuItem id="move-tab-group" label="Move to group">
          <MenuItem label="New group…" onSelect={() => onCreateGroup(tabMenu.id)} />
          {groups.map((group) => <MenuItem key={group.id} label={group.name} disabled={tabMenu.groupId === group.id}
            onSelect={() => onOrganize({ kind: 'move-to-group', tabId: tabMenu.id, groupId: group.id })} />)}
          {tabMenu.groupId && <MenuItem label="Remove from group" onSelect={() => onOrganize({ kind: 'move-to-group', tabId: tabMenu.id, groupId: null })} />}
        </SubmenuItem>
        {tabMenu.workspaceId !== 'banking' && batchActions.map(({ scope, label }) => {
          if (scope === 'group' && !tabMenu.groupId) return null;
          const targets = tabBatchTargets(tabs, tabMenu.id, scope);
          return <MenuItem key={scope} label={label} hint={targets.length + (targets.length === 1 ? ' tab' : ' tabs')}
            disabled={!targets.length} onSelect={() => onCloseBatch(tabMenu.id, scope, targets.map((tab) => tab.id))} />;
        })}
      </MenuSurface>}
    </header>
  );
}
