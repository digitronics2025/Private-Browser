import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { ChevronDown, Globe2, LoaderCircle, Plus, Volume2, VolumeX, X } from 'lucide-react';
import type { BrowserTab } from '../../electron/types';
import { BrandMark } from './BrandMark';

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
}

/**
 * The top row of the window: brand/protection button, tabs, new-tab button and
 * the empty draggable area. The native Windows caption buttons are drawn by the
 * title-bar overlay into the space this strip leaves free on the right.
 */
export function WindowTabStrip({ tabs, activeTabId, shieldButtonRef, tabSearchButtonRef, shieldOpen, tabSearchOpen, onShield, onTabSearch, onActivate, onClose, onNewTab, onMove, onMute }: WindowTabStripProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => {
    tabRefs.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>, tab: BrowserTab, index: number) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    if (tab.id !== activeTabId) onActivate(tab.id);
    const rects = tabs.map((candidate) => tabRefs.current.get(candidate.id)?.getBoundingClientRect());
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
    if (drag.active && drag.to !== drag.from) onMove(drag.id, drag.to);
    setDrag(null);
  };

  const shiftFor = (index: number): number => {
    if (!drag?.active || index === drag.from) return 0;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.width;
    if (drag.from > drag.to && index >= drag.to && index < drag.from) return drag.width;
    return 0;
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, tab: BrowserTab, index: number) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onActivate(tab.id);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      onClose(tab.id);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      const target = tabs[next];
      tabRefs.current.get(target.id)?.focus();
      onActivate(target.id);
    }
  };

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
      <div className="tab-scroller" ref={scrollerRef} onWheel={(event) => { if (scrollerRef.current && event.deltaY) scrollerRef.current.scrollLeft += event.deltaY; }}>
        <div className="tab-list" role="tablist" aria-label="Open tabs">
          {tabs.map((tab, index) => {
            const active = tab.id === activeTabId;
            const dragging = drag?.active && drag.id === tab.id;
            const title = tab.isHome ? 'New tab' : tab.title || 'Untitled';
            return (
              <div
                key={tab.id}
                ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id); }}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                aria-label={`${title}${tab.loading ? ', loading' : ''}${tab.audible && !tab.muted ? ', playing audio' : ''}${tab.muted ? ', muted' : ''}`}
                title={title}
                className={`browser-tab ${active ? 'active' : ''} ${dragging ? 'dragging' : ''} ${drag?.active ? 'reordering' : ''}`}
                style={{ transform: dragging ? `translateX(${drag.dx}px)` : shiftFor(index) ? `translateX(${shiftFor(index)}px)` : undefined }}
                onPointerDown={(event) => beginDrag(event, tab, index)}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={() => setDrag(null)}
                onLostPointerCapture={() => setDrag(null)}
                onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
                onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab.id); } }}
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
              </div>
            );
          })}
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
    </header>
  );
}
