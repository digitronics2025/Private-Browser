import { useEffect, useState } from 'react';
import { Clock3, Search, Trash2 } from 'lucide-react';
import type { AccountSpaceId, HistoryPage } from '../../electron/types';
import { domainFromUrl } from '../lib/format';
import { EmptyState, PanelHeader } from './common';

const visitDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function dayBoundary(value: string, nextDay = false): number | null {
  if (!value) return null;
  const date = new Date(value + 'T00:00:00');
  if (nextDay) date.setDate(date.getDate() + 1);
  return Number.isFinite(date.getTime()) ? date.getTime() : null;
}

export function HistoryPanel({ accountSpaceId, revision, protectedWorkspace, deferredSession, onRestoreSession, onOpen, onClearData, onToast }: {
  accountSpaceId: AccountSpaceId;
  revision: string;
  protectedWorkspace: boolean;
  deferredSession?: { tabCount: number; savedAt: string };
  onRestoreSession: () => void;
  onOpen: (id: string) => void;
  onClearData: () => void;
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const [text, setText] = useState('');
  const [site, setSite] = useState('');
  const [since, setSince] = useState('');
  const [through, setThrough] = useState('');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState<HistoryPage>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const from = dayBoundary(since);
  const until = dayBoundary(through, true);
  const invalidRange = from !== null && until !== null && from >= until;

  useEffect(() => {
    if (protectedWorkspace || invalidRange) return;
    setFailed(false);
    let live = true;
    const timeout = window.setTimeout(() => {
      void window.privateBrowser.queryHistory?.(accountSpaceId, { text, site, from, until, page }).then((next) => {
        if (live) setResult(next);
      }).catch(() => { if (live) setFailed(true); });
    }, 90);
    return () => { live = false; window.clearTimeout(timeout); };
  }, [accountSpaceId, from, invalidRange, page, protectedWorkspace, retry, revision, site, text, until]);

  const filter = (update: (value: string) => void, value: string) => {
    setPage(0);
    setResult(undefined);
    update(value);
  };

  return (
    <div className="side-panel">
      <PanelHeader icon={Clock3} eyebrow="This Account Space" title="History" />
      {!protectedWorkspace && <>
        {deferredSession && <div className="history-restore-session"><strong>Previous session</strong><span>{deferredSession.tabCount} tabs · {visitDate.format(new Date(deferredSession.savedAt))}</span><button type="button" onClick={onRestoreSession}>Restore previous session</button></div>}
        <label className="vault-search"><Search size={14} /><input aria-label="Search history" placeholder="Search history" maxLength={256} value={text} onChange={(event) => filter(setText, event.target.value)} /></label>
        <label className="vault-search"><Search size={14} /><input aria-label="Filter history by site" placeholder="Site, e.g. example.com" maxLength={255} value={site} onChange={(event) => filter(setSite, event.target.value)} /></label>
        <div className="history-dates">
          <label>From <input type="date" value={since} onChange={(event) => filter(setSince, event.target.value)} /></label>
          <label>Through <input type="date" value={through} onChange={(event) => filter(setThrough, event.target.value)} /></label>
        </div>
      </>}
      <div className="panel-actions">
        <button type="button" className="danger" onClick={onClearData}><Trash2 size={14} /> Delete browsing data…</button>
      </div>
      {protectedWorkspace ? <p className="panel-count">Banking pages are never written to history.</p>
        : invalidRange ? <p role="alert" className="panel-count">Choose an end date on or after the start date.</p>
        : failed ? <div className="panel-actions"><button type="button" onClick={() => setRetry(retry + 1)}>Retry history</button></div>
        : result ? <>
          {result.total > 0 && <p className="panel-count">{result.total} {result.total === 1 ? 'page' : 'pages'}</p>}
          {result.trimmed && <p className="panel-count">The history limit removed earlier visits from this Account Space.</p>}
          {result.pages > 1 && <nav className="panel-actions" aria-label="History pages">
            <button type="button" disabled={result.page === 0} onClick={() => setPage(result.page - 1)}>Previous</button>
            <button type="button" disabled={result.page + 1 === result.pages} onClick={() => setPage(result.page + 1)}>Next</button>
            <span className="panel-count" aria-live="polite">Page {result.page + 1} of {result.pages}</span>
          </nav>}
          {result.entries.length > 0 ? <ul className="item-list">
            {result.entries.map((item) => (
              <li key={item.url} className="item-row">
                <button type="button" className="item-row-main" title={item.url} onClick={() => onOpen(item.id)}>
                  <span className="item-row-text">
                    <strong>{item.title || domainFromUrl(item.url)}</strong>
                    <small>{domainFromUrl(item.url)} · <time dateTime={item.visitedAt}>{visitDate.format(new Date(item.visitedAt))}</time>{item.visits > 1 && ' · ' + item.visits + ' visits'}</small>
                  </span>
                </button>
                <button className="toolbar-button small history-delete" type="button" aria-label={'Delete most recent visit to ' + (item.title || domainFromUrl(item.url))}
                  title="Delete most recent visit" onClick={() => {
                    if (!window.confirm('Delete this retained visit?')) return;
                    void window.privateBrowser.deleteHistoryVisit(accountSpaceId, item.id)
                      .then(() => setRetry((value) => value + 1))
                      .catch((error) => onToast(error instanceof Error ? error.message : 'Could not delete the visit.', 'error'));
                  }}><Trash2 size={15} /></button>
              </li>
            ))}
          </ul> : <EmptyState icon={Clock3} text={text || site || since || through ? 'No retained visits match those filters.' : 'Pages you visit in this Account Space appear here.'} />}
        </> : <p role="status" className="panel-count">Loading history…</p>}
    </div>
  );
}
