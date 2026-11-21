import { useEffect, useState } from 'react';
import { FileDown } from 'lucide-react';
import type { ChromePasswordImportResult, ChromePasswordImportReview, ChromePasswordSkipReason } from '../../electron/types';

const reasons: Record<ChromePasswordSkipReason, string> = {
  'already-saved': 'Already saved in MyVault',
  'duplicate-in-file': 'Duplicate in this file',
  'unsupported-site': 'Unsupported website or app address',
  'missing-password': 'Missing password',
  'field-limit': 'Entry exceeds the field limit',
  'row-limit': 'Entry exceeds the import limit',
};

export function ChromePasswordImportWizard({ buttonLabel = 'Import Chrome password CSV', disabled, onImported }: {
  buttonLabel?: string;
  disabled?: boolean;
  onImported?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ChromePasswordImportReview>();
  const [result, setResult] = useState<ChromePasswordImportResult>();
  const [error, setError] = useState('');
  const reviewId = review?.id;
  useEffect(() => () => {
    if (reviewId) void window.privateBrowser.discardChromePasswordReview(reviewId).catch(() => undefined);
  }, [reviewId]);

  const choose = async () => {
    setBusy(true);
    setError('');
    try {
      setReview(await window.privateBrowser.reviewChromePasswords());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not review the password file.');
    } finally {
      setBusy(false);
    }
  };

  const importReviewed = async () => {
    if (!review) return;
    setBusy(true);
    setError('');
    try {
      setResult(await window.privateBrowser.importReviewedChromePasswords(review.id));
      onImported?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not import the password file.');
    } finally {
      setReview(undefined);
      setBusy(false);
    }
  };

  if (!open) return <button type="button" className="text-button" disabled={disabled} onClick={() => setOpen(true)}>
    <FileDown size={14} /> {buttonLabel}
  </button>;
  const skipped = review?.skipped ?? result?.skipped;
  const skippedCount = skipped ? Object.values(skipped).reduce((total, count) => total + count, 0) : 0;
  return <section className="settings-card chrome-password-review" aria-label="Import Chrome passwords">
    <h3>Import Chrome passwords</h3>
    {!review && !result && <>
      <ol>
        <li>In Chrome, open Google Password Manager from Passwords and autofill.</li>
        <li>In Settings, find Export passwords and choose Download file.</li>
        <li>Unlock MyVault, then choose the CSV for a local preview.</li>
      </ol>
      <p>The CSV contains readable passwords. Keep it in a private folder until you verify the import.</p>
    </>}
    {review && <p role="status">{review.toImport} of {review.sourceCount} entries ready to import into MyVault.</p>}
    {result && <p role="status">{result.imported} {result.imported === 1 ? 'login' : 'logins'} added to MyVault.</p>}
    {skippedCount > 0 && <dl>{Object.entries(reasons).map(([reason, label]) => {
      const count = skipped?.[reason as ChromePasswordSkipReason];
      return count ? <div key={reason}><dt>{label}</dt><dd>{count}</dd></div> : null;
    })}</dl>}
    {review && review.issues.length > 0 && <details>
      <summary>Review skipped entries</summary>
      <ul>{review.issues.map((item) => <li key={item.entry}>
        Entry {item.entry} · {reasons[item.reason]}{item.origin && <small>{item.origin}{item.username && ' · ' + item.username}</small>}
      </li>)}</ul>
      {review.issues.length < skippedCount && <p>Showing {review.issues.length} of {skippedCount} skipped entries.</p>}
    </details>}
    {result && <p>Try the imported logins, then delete the CSV from its folder and empty it from the Recycle Bin.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="panel-actions">
      {!review && !result && <button type="button" disabled={busy || disabled} onClick={() => void choose()}>Choose password CSV</button>}
      {review && <button type="button" disabled={busy || disabled || !review.toImport} onClick={() => void importReviewed()}>Import reviewed logins</button>}
      <button type="button" disabled={busy} onClick={() => {
        setReview(undefined); setResult(undefined); setError(''); setOpen(false);
      }}>{result ? 'Done' : 'Cancel'}</button>
    </div>
  </section>;
}
