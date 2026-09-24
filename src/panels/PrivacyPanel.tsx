import { ShieldCheck } from 'lucide-react';
import type { BrowserSnapshot } from '../../electron/types';
import { EmptyState, PanelHeader } from './common';
import { timeAgo } from '../lib/format';

export function PrivacyPanel({ state }: { state: BrowserSnapshot }) {
  return <div className="side-panel"><PanelHeader icon={ShieldCheck} eyebrow="Transparent by design" title="Privacy log" /><div className="privacy-summary"><div><strong>{state.trackerBlocking ? 'On' : 'Off'}</strong><span>Tracker blocking</span></div><div><strong>{state.accountSpaces.length}</strong><span>Isolated spaces</span></div><div><strong>{state.privacyLog.length}</strong><span>Logged events</span></div></div><div className="privacy-events">{state.privacyLog.map((event) => <div className="privacy-event" key={event.id}><span className={`event-dot ${event.kind}`} /><div><strong>{event.title}</strong><small>{event.detail}</small></div><time>{timeAgo(event.at)}</time></div>)}{!state.privacyLog.length && <EmptyState icon={ShieldCheck} text="Sensitive access events will be recorded here." />}</div></div>;
}
