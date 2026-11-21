import { useId, useRef, useState } from 'react';
import type { AccountSpaceId, AccountSpaceSummary, BrowsingDataRange, BrowsingDataReview } from '../../electron/types';
import { useModalFocus } from '../lib/dialog';
import { useOverlayLayer } from './overlay';

const times: Record<BrowsingDataRange, string> = {
  hour: 'Last hour',
  day: 'Last 24 hours',
  week: 'Last 7 days',
  all: 'All time',
};

export function ClearBrowsingDataDialog({ accounts, activeId, protectedWorkspace, onDone, onCleared }: {
  accounts: AccountSpaceSummary[];
  activeId: AccountSpaceId;
  protectedWorkspace: boolean;
  onDone: () => void;
  onCleared: (visits: number) => void;
}) {
  const title = useId();
  const dialog = useRef<HTMLFormElement>(null);
  const [accountId, setAccountId] = useState(activeId);
  const [range, setRange] = useState<BrowsingDataRange>('all');
  const [site, setSite] = useState('');
  const [history, setHistory] = useState(!protectedWorkspace);
  const [websiteData, setWebsiteData] = useState(protectedWorkspace);
  const [cache, setCache] = useState(false);
  const [review, setReview] = useState<BrowsingDataReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useOverlayLayer();
  useModalFocus(dialog, () => { if (!busy) onDone(); });
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      if (review) {
        onCleared(await window.privateBrowser.deleteReviewedBrowsingData(review.id));
      } else {
        setReview(await window.privateBrowser.reviewBrowsingData({ accountSpaceId: accountId, range, site, history, websiteData, cache }));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not manage browsing data.');
      setReview(undefined);
    } finally {
      setBusy(false);
    }
  };
  const allowed = review ? review.historyCount > 0 || review.websiteData || review.cache : history || websiteData || cache;
  return <div className="modal-backdrop prompt-backdrop" role="presentation">
    <form ref={dialog} className="prompt-dialog browsing-data-dialog" role="dialog" aria-modal="true" aria-labelledby={title}
      onSubmit={(event) => { event.preventDefault(); if (allowed && !busy) void submit(); }}>
      <h2 id={title}>Delete browsing data</h2>
      {review ? <div className="settings-card browsing-data-review">
        <p><strong>{accounts.find((account) => account.id === review.accountSpaceId)?.label}</strong></p>
        <p>{review.siteOrigin ?? 'All websites in this Account Space'}</p>
        {history && <p>{review.historyCount} {review.historyCount === 1 ? 'visit' : 'visits'} to remove · {times[review.range]}</p>}
        {review.websiteData && <p>Website data from all dates will be removed. This may sign you out and reload affected tabs.
          {review.siteOrigin && ' Clearing the site’s cookies can also sign you out on related subdomains.'}</p>}
        {review.cache && <p>Cached files from all dates will be removed.</p>}
      </div> : <fieldset disabled={busy}>
        <label>Account Space<select aria-label="Account Space" value={accountId} onChange={(event) => setAccountId(event.currentTarget.value as AccountSpaceId)}>
          {accounts.map((account) => <option value={account.id} key={account.id} disabled={account.locked}>{account.label}</option>)}
        </select></label>
        <label>Website address (optional)<input value={site} maxLength={2048} autoComplete="off" spellCheck={false}
          onChange={(event) => setSite(event.currentTarget.value)} /></label>
        {!protectedWorkspace && <>
          <label className="browsing-data-choice"><input type="checkbox" checked={history} onChange={(event) => setHistory(event.currentTarget.checked)} /> Browsing history</label>
          <label>History time range<select aria-label="History time range" disabled={!history} value={range}
            onChange={(event) => setRange(event.currentTarget.value as BrowsingDataRange)}>
            {Object.entries(times).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
        </>}
        <label className="browsing-data-choice"><input type="checkbox" checked={websiteData} onChange={(event) => setWebsiteData(event.currentTarget.checked)} /> Website data and sign-ins</label>
        <label className="browsing-data-choice"><input type="checkbox" checked={cache} onChange={(event) => setCache(event.currentTarget.checked)} /> Cached files</label>
        {(websiteData || cache) && <p>Website data and cached files cover all dates.</p>}
      </fieldset>}
      {error && <p className="prompt-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onDone}>Cancel</button>
        {review && <button type="button" className="secondary-button" disabled={busy} onClick={() => setReview(undefined)}>Change selection</button>}
        <button type="submit" className={review ? 'primary-button danger' : 'primary-button'} disabled={busy || !allowed}>
          {review ? 'Delete reviewed data' : 'Review deletion'}
        </button>
      </div>
    </form>
  </div>;
}
