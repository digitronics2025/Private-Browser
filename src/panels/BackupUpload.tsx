import { useEffect, useRef, useState } from 'react';
import { Cloud } from 'lucide-react';
import type { AccountSpaceSummary, BackupGenerationSummary, BackupReminderDays, BackupUploadPreview } from '../../electron/types';

const backupDate = (value: string) => new Date(value).toLocaleString();

export function BackupUpload({ account, onToast }: {
  account: AccountSpaceSummary;
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const [review, setReview] = useState<BackupUploadPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<string>();
  const reviewId = useRef<string>();

  useEffect(() => () => {
    if (request.current) void window.privateBrowser.cancelOperation(request.current).catch(() => undefined);
    if (reviewId.current) void window.privateBrowser.cancelBackupUpload(reviewId.current).catch(() => undefined);
    request.current = undefined;
    reviewId.current = undefined;
  }, [account.id]);

  const run = async (action: (operation: string) => Promise<void>) => {
    const operation = crypto.randomUUID();
    request.current = operation;
    setBusy(true);
    setError('');
    try { await action(operation); }
    catch (reason) {
      if (request.current === operation) setError(reason instanceof Error ? reason.message : 'The encrypted backup is unavailable.');
    } finally {
      if (request.current === operation) {
        request.current = undefined;
        setBusy(false);
      }
    }
  };

  const load = () => run(async (operation) => {
    const next = await window.privateBrowser.previewBackupUpload(account.id, operation);
    if (request.current !== operation) {
      await window.privateBrowser.cancelBackupUpload(next.id);
      return;
    }
    reviewId.current = next.id;
    setReview(next);
  });

  const discard = () => {
    if (reviewId.current) void window.privateBrowser.cancelBackupUpload(reviewId.current).catch(() => undefined);
    reviewId.current = undefined;
    setReview(undefined);
  };

  const save = (resolution: 'merge' | 'overwrite') => run(async (operation) => {
    const id = reviewId.current;
    reviewId.current = undefined;
    setReview(undefined);
    if (!id) throw new Error('Review the backup again before saving.');
    const outcome = await window.privateBrowser.applyBackupUpload(id, operation, resolution);
    if (outcome.status !== 'uploaded') throw new Error('The encrypted backup changed. Review it again.');
    if (request.current === operation) onToast('Encrypted backup uploaded');
  });

  return <section aria-label="Manage encrypted backups">
    {account.backupLastUploadedAt && <p>Last upload <time dateTime={account.backupLastUploadedAt}>{backupDate(account.backupLastUploadedAt)}</time></p>}
    <label className="bridge-label">Remind me to back up<select value={account.backupReminderDays ?? 0} disabled={busy}
      onChange={(event) => {
        const days = Number(event.currentTarget.value) as BackupReminderDays;
        void run(async () => window.privateBrowser.setBackupReminder(account.id, days));
      }}>
      <option value={0}>Off</option><option value={7}>Every 7 days</option><option value={14}>Every 14 days</option><option value={30}>Every 30 days</option>
    </select></label>
    {error && <p role="alert">{error}</p>}
    {!review ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void load()}><Cloud size={14} /> Review backup</button> : <>
      {review.conflict && <p role="status">Another device changed the encrypted backup. Compare the counts before choosing what to save.</p>}
      <table className="backup-counts">
        <caption>What each backup contains</caption>
        <thead><tr><th scope="col">Version</th><th scope="col">Bookmarks</th><th scope="col">Folders</th><th scope="col">Tabs</th><th scope="col">History</th></tr></thead>
        <tbody>
          <GenerationRow title="This computer" item={review.local} />
          {review.remote && <GenerationRow title="Latest upload" item={review.remote} dated />}
          {review.merged && <GenerationRow title="After merge" item={review.merged} />}
          {review.generations.map((item, index) => <GenerationRow key={item.createdAt + index} title="Earlier backup" item={item} dated />)}
        </tbody>
      </table>
      {review.remote && <p>Earlier generations are retained as space allows.</p>}
      <div className="backup-actions">
        {review.conflict && <button type="button" className="primary-button" disabled={busy} onClick={() => void save('merge')}>Merge and save</button>}
        <button type="button" className={review.conflict ? 'secondary-button' : 'primary-button'} disabled={busy} onClick={() => void save('overwrite')}>
          {review.conflict ? 'Replace with this computer’s data' : 'Save encrypted backup'}
        </button>
        <button type="button" className="secondary-button" onClick={discard}>Cancel</button>
      </div>
    </>}
  </section>;
}

function GenerationRow({ title, item, dated }: { title: string; item: BackupGenerationSummary; dated?: boolean }) {
  return <tr><th scope="row">{title}{dated && <small><time dateTime={item.createdAt}>{backupDate(item.createdAt)}</time></small>}</th>
    <td>{item.bookmarks}</td><td>{item.folders}</td><td>{item.tabs}</td><td>{item.history}</td></tr>;
}
