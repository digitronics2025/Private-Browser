import { useEffect, useRef } from 'react';
import { ArrowLeft, ArrowRight, Asterisk, ExternalLink, LogOut, RotateCw, ShieldAlert, SquarePen } from 'lucide-react';
import type { SideAppCommand, SideAppId, SideAppSnapshot } from '../../electron/types';
import { EmptyState } from './common';

const STATUS_TEXT: Record<SideAppSnapshot['status'], string> = {
  idle: 'Starting…',
  loading: 'Loading…',
  ready: '',
  failed: 'Could not load. Check your connection and reload.',
  crashed: 'The panel stopped working. Reload to start it again.',
};

/**
 * A web app docked in the side panel. The page itself is a native view the main
 * process lays over `.side-app-slot`; this component only reports where that
 * slot is and draws the controls above it.
 */
export function SideAppPanel({ app, protectedWorkspace, onToast }: {
  app: SideAppSnapshot;
  protectedWorkspace: boolean;
  onToast: (message: string, tone?: 'error') => void;
}) {
  const slot = useRef<HTMLDivElement>(null);
  useSideAppSlot(app.id, protectedWorkspace ? null : slot);

  const run = (command: SideAppCommand) => {
    void window.privateBrowser.sideAppCommand(app.id, command).catch((error: unknown) => onToast(error instanceof Error ? error.message : String(error), 'error'));
  };
  const signOut = () => {
    if (!window.confirm(`Sign out of ${app.name} in the side panel?\n\nIts sign-in, settings and cached data on this computer are deleted. Your ${app.name} account and conversations are not affected.`)) return;
    void window.privateBrowser.clearSideAppData(app.id)
      .then(() => onToast(`Signed out of ${app.name}`))
      .catch((error: unknown) => onToast(error instanceof Error ? error.message : String(error), 'error'));
  };

  if (protectedWorkspace) {
    return <div className="side-panel"><EmptyState icon={ShieldAlert} text={`${app.name} is turned off in Banking. Switch to another workspace to use it.`} /></div>;
  }

  const status = STATUS_TEXT[app.status];
  return (
    <div className="side-app">
      <div className="side-app-toolbar" role="toolbar" aria-label={`${app.name} controls`}>
        <button type="button" className="toolbar-button small" aria-label="Back" title="Back" disabled={!app.canGoBack} onClick={() => run('back')}><ArrowLeft size={16} /></button>
        <button type="button" className="toolbar-button small" aria-label="Forward" title="Forward" disabled={!app.canGoForward} onClick={() => run('forward')}><ArrowRight size={16} /></button>
        <button type="button" className="toolbar-button small" aria-label="Reload" title="Reload" onClick={() => run('reload')}><RotateCw size={16} /></button>
        <button type="button" className="toolbar-button small" aria-label="New chat" title="New chat" onClick={() => run('home')}><SquarePen size={16} /></button>
        <span className="side-app-status" role="status">{status}</span>
        <button type="button" className="toolbar-button small" aria-label="Open in new tab" title="Open in new tab" onClick={() => run('open-in-tab')}><ExternalLink size={16} /></button>
        <button type="button" className="toolbar-button small" aria-label={`Sign out of ${app.name}`} title={`Sign out of ${app.name} and delete its data`} onClick={signOut}><LogOut size={16} /></button>
      </div>
      <div ref={slot} className="side-app-slot" data-side-app={app.id}>
        {/* Seen only while the native view is hidden: loading, a menu open over the chrome, or a resize. */}
        <div className="side-app-placeholder"><Asterisk size={28} /><span>{app.name}</span></div>
      </div>
    </div>
  );
}

/**
 * Keep the main process told where the slot is, in window DIPs. The chrome's
 * zoom is pinned to 1, so CSS pixels are DIPs. `null` hides the view.
 */
function useSideAppSlot(id: SideAppId, slot: React.RefObject<HTMLDivElement | null> | null) {
  useEffect(() => {
    const element = slot?.current;
    if (!element) {
      void window.privateBrowser.setSideAppBounds(id, null);
      return;
    }
    let last = '';
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = element.getBoundingClientRect();
        const rect = { x: Math.max(0, Math.round(box.left)), y: Math.max(0, Math.round(box.top)), width: Math.max(0, Math.round(box.width)), height: Math.max(0, Math.round(box.height)) };
        const key = JSON.stringify(rect);
        if (key === last) return;
        last = key;
        void window.privateBrowser.setSideAppBounds(id, rect);
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(element);
    // A bar appearing above the panel moves the slot without always resizing it.
    observer.observe(document.documentElement);
    window.addEventListener('resize', report);
    // The panel slides in: a slot measured mid-animation is off by the slide,
    // and a transform never triggers the resize observer.
    document.addEventListener('animationend', report);
    document.addEventListener('transitionend', report);
    report();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', report);
      document.removeEventListener('animationend', report);
      document.removeEventListener('transitionend', report);
      void window.privateBrowser.setSideAppBounds(id, null);
    };
  }, [id, slot]);
}
