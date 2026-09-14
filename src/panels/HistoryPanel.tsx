import { useMemo, useState } from 'react';
import { Clock3, Search, Trash2 } from 'lucide-react';
import type { HistoryEntry } from '../../electron/types';
import { domainFromUrl } from '../lib/format';
import { EmptyState, PanelHeader } from './common';

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
}

export function HistoryPanel({ history, protectedWorkspace, onOpen, onClearData }: {
  history: HistoryEntry[];
  protectedWorkspace: boolean;
  onOpen: (url: string) => void;
  onClearData: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const groups = useMemo(() => {
    const result = new Map<string, HistoryEntry[]>();
    for (const item of history) {
      if (needle && !`${item.title} ${item.url}`.toLocaleLowerCase().includes(needle)) continue;
      const label = dayLabel(item.visitedAt);
      result.set(label, [...(result.get(label) ?? []), item]);
    }
    return [...result.entries()];
  }, [history, needle]);
  return (
    <div className="side-panel">
      <PanelHeader icon={Clock3} eyebrow="This Account Space" title="History" />
      <label className="vault-search"><Search size={14} /><input aria-label="Search history" placeholder="Search history" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="panel-actions">
        <button type="button" className="danger" onClick={onClearData}><Trash2 size={14} /> Delete browsing data…</button>
      </div>
      {protectedWorkspace && <p className="panel-count">Banking pages are never written to history.</p>}
      {groups.map(([label, items]) => (
        <section key={label} className="history-group" aria-label={label}>
          <h3>{label}</h3>
          <ul className="item-list">
            {items.map((item) => (
              <li key={item.id} className="item-row">
                <button type="button" className="item-row-main" title={item.url} onClick={() => onOpen(item.url)}>
                  <time className="item-row-time" dateTime={item.visitedAt}>{new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(item.visitedAt))}</time>
                  <span className="item-row-text"><strong>{item.title || domainFromUrl(item.url)}</strong><small>{domainFromUrl(item.url)}</small></span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!groups.length && <EmptyState icon={Clock3} text={needle ? 'No page in recent history matches that search.' : 'Pages you visit in this Account Space appear here.'} />}
    </div>
  );
}
