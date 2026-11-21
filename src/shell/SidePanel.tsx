import { useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Asterisk, NotebookPen, Code2, Download, KeyRound, PanelRightClose, Pin, PinOff, ShieldCheck, Sparkles, X, Zap } from 'lucide-react';
import type { PinnablePanelTool, SidePanelTool } from '../../electron/types';
import { isPinnablePanelTool, PINNABLE_PANEL_TOOLS } from '../../electron/ui-preferences';
import { clampSidePanelWidth, SIDE_PANEL } from '../../electron/chrome-layout';
import { OverlayContext } from './overlay';
import { SIDE_PANEL_NAMES } from './side-panel-tools';

const icons: Record<PinnablePanelTool, typeof Sparkles> = {
  easynote: NotebookPen, claude: Asterisk, assistant: Sparkles, developer: Code2,
  vault: KeyRound, automations: Zap, downloads: Download, privacy: ShieldCheck,
};

export function SidePanel({ tool, pins, width, compact, activeDownloads, onSelectTool, onPinTool, onClose, onToggleCompact, onLiveWidth, onCommitWidth, children }: {
  tool: SidePanelTool;
  pins?: PinnablePanelTool[];
  width: number;
  compact: boolean;
  activeDownloads: number;
  onSelectTool: (tool: SidePanelTool) => void;
  onPinTool: (tool: PinnablePanelTool, enabled: boolean) => void;
  onClose: () => void;
  onToggleCompact: () => void;
  onLiveWidth: (width: number | null) => void;
  onCommitWidth: (width: number) => void;
  children: ReactNode;
}) {
  const overlay = useContext(OverlayContext);
  const release = useRef<(() => void) | null>(null);
  const start = useRef({ x: 0, width });
  const [resizing, setResizing] = useState(false);
  const liveWidth = useRef(width);
  const orderedTools = [...new Set([...(pins ?? []), ...PINNABLE_PANEL_TOOLS])];
  const canPin = pins !== undefined && isPinnablePanelTool(tool);
  const pinned = canPin && pins.includes(tool);

  const callbacks = useRef({ onLiveWidth, onCommitWidth });
  callbacks.current = { onLiveWidth, onCommitWidth };
  const detach = useRef<(() => void) | null>(null);
  const pinnedToolCount = pins?.length;
  useEffect(() => {
    document.getElementById(`side-panel-tab-${tool}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tool, pinnedToolCount]);
  // Closing the panel mid-drag must still unfreeze the page and drop the live
  // width; before, the overlay stayed held and the page stayed hidden (F-68).
  useEffect(() => () => {
    const dragging = release.current !== null;
    detach.current?.();
    release.current?.();
    release.current = null;
    if (dragging) callbacks.current.onLiveWidth(null);
  }, []);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || release.current) return;
    event.preventDefault();
    // Track the drag on the window rather than relying on pointer capture alone:
    // capture can be lost while the page freezes underneath, and a lost capture
    // must not silently turn the drag into a no-op.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* window listeners still track the drag */ }
    // The page view would swallow the pointer as soon as it crosses into it, so
    // freeze the page for the length of the drag.
    release.current = overlay.acquire();
    start.current = { x: event.clientX, width };
    liveWidth.current = width;
    setResizing(true);
    const pointerId = event.pointerId;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      liveWidth.current = clampSidePanelWidth(start.current.width + (start.current.x - moveEvent.clientX), window.innerWidth);
      callbacks.current.onLiveWidth(liveWidth.current);
    };
    const end = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== pointerId) return;
      detach.current?.();
      callbacks.current.onCommitWidth(liveWidth.current);
      callbacks.current.onLiveWidth(null);
      release.current?.();
      release.current = null;
      setResizing(false);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    detach.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      detach.current = null;
    };
  };
  const onSeparatorKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      onCommitWidth(event.key === 'Home' ? SIDE_PANEL.max : SIDE_PANEL.min);
    } else if (delta) {
      event.preventDefault();
      onCommitWidth(clampSidePanelWidth(width + delta, window.innerWidth));
    }
  };

  const onTabKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const index = isPinnablePanelTool(tool) ? orderedTools.indexOf(tool) : 0;
    const next = orderedTools[(index + (event.key === 'ArrowRight' ? 1 : -1) + orderedTools.length) % orderedTools.length];
    onSelectTool(next);
  };

  return (
    <aside className={`side-panel-shell ${resizing ? 'resizing' : ''}`} aria-label="Side panel">
      {!compact && <div
        className="side-panel-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side panel"
        aria-valuemin={SIDE_PANEL.min}
        aria-valuemax={SIDE_PANEL.max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={onSeparatorKey}
      />}
      <header className="side-panel-header">
        <div className="side-panel-tabs" role="tablist" aria-label="Side panel tools" onKeyDown={onTabKey}>
          {orderedTools.map((id) => {
            const label = SIDE_PANEL_NAMES[id];
            const Icon = icons[id];
            const selected = tool === id;
            return (
              <button
                key={id}
                id={`side-panel-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={label}
                tabIndex={selected || (!isPinnablePanelTool(tool) && id === orderedTools[0]) ? 0 : -1}
                title={id === 'easynote' ? label + ' (Ctrl+Shift+Y)' : label}
                className={`side-panel-tab ${selected ? 'selected' : ''}`}
                onClick={() => onSelectTool(id)}
              >
                <Icon size={16} />
                <span>{label}</span>
                {id === 'downloads' && activeDownloads > 0 && <b className="count-badge" aria-label={`${activeDownloads} downloading`}>{activeDownloads}</b>}
              </button>
            );
          })}
        </div>
        {canPin && <button type="button" className={`toolbar-button small ${pinned ? 'selected' : ''}`}
          aria-label={(pinned ? 'Unpin ' : 'Pin ') + SIDE_PANEL_NAMES[tool]}
          title={(pinned ? 'Unpin ' : 'Pin ') + SIDE_PANEL_NAMES[tool]}
          onClick={() => onPinTool(tool, !pinned)}>{pinned ? <PinOff size={16} /> : <Pin size={16} />}</button>}
        <button type="button" className={`toolbar-button small ${compact ? 'selected' : ''}`}
          aria-label="Compact side panel" title="Compact side panel" aria-pressed={compact} onClick={onToggleCompact}><PanelRightClose size={16} /></button>
        <button type="button" className="toolbar-button small" aria-label="Close side panel" title="Close side panel" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="side-panel-body" role="tabpanel">{children}</div>
    </aside>
  );
}
