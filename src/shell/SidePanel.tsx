import { useContext, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Code2, Download, KeyRound, ShieldCheck, Sparkles, X, Zap } from 'lucide-react';
import type { SidePanelTool } from '../../electron/types';
import { clampSidePanelWidth, SIDE_PANEL } from '../../electron/chrome-layout';
import { OverlayContext } from './overlay';

export const SIDE_PANEL_TABS: Array<{ id: SidePanelTool; label: string; title: string; icon: typeof Sparkles }> = [
  { id: 'assistant', label: 'AI', title: 'AI assistant', icon: Sparkles },
  { id: 'developer', label: 'DevTools', title: 'Developer cockpit', icon: Code2 },
  { id: 'vault', label: 'Vault', title: 'MyVault', icon: KeyRound },
  { id: 'automations', label: 'Flows', title: 'Automations', icon: Zap },
  { id: 'downloads', label: 'Files', title: 'Downloads', icon: Download },
  { id: 'privacy', label: 'Privacy', title: 'Privacy log', icon: ShieldCheck },
];

export function SidePanel({ tool, width, activeDownloads, onSelectTool, onClose, onLiveWidth, onCommitWidth, children }: {
  tool: SidePanelTool;
  width: number;
  activeDownloads: number;
  onSelectTool: (tool: SidePanelTool) => void;
  onClose: () => void;
  onLiveWidth: (width: number | null) => void;
  onCommitWidth: (width: number) => void;
  children: ReactNode;
}) {
  const overlay = useContext(OverlayContext);
  const release = useRef<(() => void) | null>(null);
  const start = useRef({ x: 0, width });
  const [resizing, setResizing] = useState(false);
  const liveWidth = useRef(width);

  const callbacks = useRef({ onLiveWidth, onCommitWidth });
  callbacks.current = { onLiveWidth, onCommitWidth };
  const detach = useRef<(() => void) | null>(null);
  useEffect(() => () => detach.current?.(), []);

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
    const index = Math.max(0, SIDE_PANEL_TABS.findIndex((item) => item.id === tool));
    const next = SIDE_PANEL_TABS[(index + (event.key === 'ArrowRight' ? 1 : -1) + SIDE_PANEL_TABS.length) % SIDE_PANEL_TABS.length];
    onSelectTool(next.id);
    requestAnimationFrame(() => document.getElementById(`side-panel-tab-${next.id}`)?.focus());
  };

  return (
    <aside className={`side-panel-shell ${resizing ? 'resizing' : ''}`} aria-label="Side panel">
      <div
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
      />
      <header className="side-panel-header">
        <div className="side-panel-tabs" role="tablist" aria-label="Side panel tools" onKeyDown={onTabKey}>
          {SIDE_PANEL_TABS.map(({ id, label, title, icon: Icon }) => {
            const selected = tool === id;
            return (
              <button
                key={id}
                id={`side-panel-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-label={label}
                tabIndex={selected || (!SIDE_PANEL_TABS.some((item) => item.id === tool) && id === 'assistant') ? 0 : -1}
                title={title}
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
        <button type="button" className="toolbar-button small" aria-label="Close side panel" title="Close side panel" onClick={onClose}><X size={16} /></button>
      </header>
      <div className="side-panel-body" role="tabpanel">{children}</div>
    </aside>
  );
}
