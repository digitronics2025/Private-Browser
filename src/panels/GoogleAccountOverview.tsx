import { useEffect, useRef, useState } from 'react';
import type { AccountSpaceSummary, GoogleOverviewPage, GoogleOverviewService } from '../../electron/types';
import { GOOGLE_OVERVIEW_MAX_PAGES, GOOGLE_OVERVIEW_PAGE_SIZE, GOOGLE_OVERVIEW_SERVICES, googleOverviewModule } from '../../electron/google-overview';

const labels: Record<GoogleOverviewService, string> = { gmail: 'Gmail', drive: 'Drive', calendar: 'Calendar' };
const subtitles: Record<GoogleOverviewService, string> = {
  gmail: 'Recent inbox headers', drive: 'Recently modified files you have allowed', calendar: 'Upcoming events',
};

export function GoogleAccountOverview({ account, active, onOpenOriginal }: {
  account: AccountSpaceSummary;
  active: boolean;
  onOpenOriginal: (url: string) => void;
}) {
  const sections = GOOGLE_OVERVIEW_SERVICES.filter((service) => googleOverviewModule(service, account.enabledModules));
  const [service, setService] = useState<GoogleOverviewService>();
  const [pages, setPages] = useState<GoogleOverviewPage[]>([]);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<string>();
  const current = pages[index];
  const limit = GOOGLE_OVERVIEW_MAX_PAGES * GOOGLE_OVERVIEW_PAGE_SIZE;
  const hide = () => {
    if (request.current) void window.privateBrowser.cancelOperation(request.current).catch(() => undefined);
    request.current = undefined;
    setBusy(false);
    setService(undefined);
    setPages([]);
    setIndex(0);
    setError('');
  };

  useEffect(() => {
    if (!active) hide();
    return () => {
      if (request.current) void window.privateBrowser.cancelOperation(request.current).catch(() => undefined);
      request.current = undefined;
    };
  }, [active, account.id]);

  const load = async (target: GoogleOverviewService, next?: string) => {
    if (!active || request.current) return;
    if (!next) {
      setService(target);
      setPages([]);
      setIndex(0);
    }
    const operation = crypto.randomUUID();
    request.current = operation;
    setBusy(true);
    setError('');
    try {
      const result = await window.privateBrowser.googleOverviewPage(account.id, operation, target, next);
      if (request.current !== operation) return;
      if (!result.ok || !result.data) throw new Error(result.error?.message ?? 'Google overview is unavailable.');
      const page = result.data;
      setPages((previous) => next ? [...previous, page] : [page]);
      setIndex(page.page - 1);
    } catch (reason) {
      if (request.current === operation) setError(reason instanceof Error ? reason.message : 'Could not read Google overview.');
    } finally {
      if (request.current === operation) {
        request.current = undefined;
        setBusy(false);
      }
    }
  };

  if (!active || !sections.length) return null;
  return <section className="manager-section google-account-overview" aria-labelledby="google-overview-heading" aria-busy={busy}>
    <h3 id="google-overview-heading">Google overview</h3>
    {!service ? <button type="button" className="secondary-button" onClick={() => void load(sections[0])}>Show Google overview</button> : <>
      <div className="google-overview-actions">
        {sections.map((item) => <button key={item} type="button" className="secondary-button" aria-pressed={service === item}
          disabled={busy} onClick={() => void load(item)}>{labels[item]}</button>)}
        <button type="button" className="secondary-button" onClick={hide}>Hide overview</button>
      </div>
      <p>{subtitles[service]}. Up to {limit} items per service.</p>
      {busy && <p role="status">Reading {labels[service]}…</p>}
      {error && <p role="alert">{error}</p>}
      {current && <ul>
        {current.items.map((item) => <li key={item.id}>
          <div><strong>{item.title}</strong>
            {item.detail && <small>{item.detail}</small>}
            {item.date && <small>{formatOverviewDate(item.date)}</small>}
          </div>
          {item.original && <button type="button" className="secondary-button" aria-label={'Open ' + item.title}
            onClick={() => onOpenOriginal(item.original!)}>Open original</button>}
        </li>)}
      </ul>}
      {current && !current.items.length && <p>No items on this page.</p>}
      {current?.limited && <p>More items are available in {labels[service]}.</p>}
      <div className="google-overview-actions">
        <button type="button" className="secondary-button" disabled={busy || index === 0} onClick={() => setIndex((value) => value - 1)}>Previous</button>
        {current && <span>Page {current.page}</span>}
        <button type="button" className="secondary-button" disabled={busy || (!pages[index + 1] && !current?.next)} onClick={() => {
          if (pages[index + 1]) setIndex((value) => value + 1);
          else if (current?.next) void load(service, current.next);
        }}>Next</button>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void load(service)}>Refresh</button>
      </div>
    </>}
  </section>;
}

function formatOverviewDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? date.toLocaleDateString(undefined, { timeZone: 'UTC' }) : date.toLocaleString();
}
