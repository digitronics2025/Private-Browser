import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AccountSpaceSummary, BackupGenerationSummary, BackupRestorePreview } from '../../electron/types';

const dataTypes = [
  ['bookmarks', 'Bookmarks'],
  ['folders', 'Bookmark folders'],
  ['history', 'History visits'],
  ['tabs', 'Tabs'],
] as const;

export function BackupRestore({ account, workspaceName, onToast }: {
  account: AccountSpaceSummary;
  workspaceName: string;
  onToast: (message: string) => void;
}) {
  const [code, setCode] = useState('');
  const [review, setReview] = useState<BackupRestorePreview>();
  const [generations, setGenerations] = useState<BackupGenerationSummary[]>([]);
  const [generation, setGeneration] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<string>();
  const currentReview = useRef<string>();

  useEffect(() => () => {
    if (request.current) void window.privateBrowser.cancelOperation(request.current).catch(() => undefined);
    if (currentReview.current) void window.privateBrowser.cancelBackupRestore(currentReview.current).catch(() => undefined);
    request.current = undefined;
    currentReview.current = undefined;
  }, []);

  const load = async (event: FormEvent) => {
    event.preventDefault();
    if (request.current || busy) return;
    const operation = crypto.randomUUID();
    request.current = operation;
    setBusy(true);
    setError('');
    const supplied = code.trim() || undefined;
    setCode('');
    try {
      const result = await window.privateBrowser.previewBackupRestore(account.id, operation, supplied, generation || undefined);
      if (request.current !== operation) {
        await window.privateBrowser.cancelBackupRestore(result.id);
        return;
      }
      currentReview.current = result.id;
      setReview(result);
      setGenerations(result.generations ?? []);
    } catch (reason) {
      if (request.current === operation) setError(reason instanceof Error ? reason.message : 'Could not review the backup.');
    } finally {
      if (request.current === operation) {
        request.current = undefined;
        setBusy(false);
      }
    }
  };

  const cancel = () => {
    if (request.current) {
      void window.privateBrowser.cancelOperation(request.current).catch(() => undefined);
      request.current = undefined;
      setBusy(false);
    }
    if (review) void window.privateBrowser.cancelBackupRestore(review.id).catch(() => undefined);
    currentReview.current = undefined;
    setReview(undefined);
    setError('');
  };

  const restore = async () => {
    if (!review || busy) return;
    setBusy(true);
    setError('');
    try {
      await window.privateBrowser.applyBackupRestore(review.id);
      onToast('Backup items added to ' + account.label);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not restore the backup.');
    } finally {
      currentReview.current = undefined;
      setReview(undefined);
      setBusy(false);
    }
  };

  return <section className="manager-section backup-restore" aria-labelledby="backup-restore-heading">
    <h3 id="backup-restore-heading">Restore an encrypted backup</h3>
    <p>Connect the Google account that created the backup and choose an Account Space in the same workspace.</p>
    {generations.length > 1 && <label className="bridge-label">Backup generation<select value={generation} disabled={busy} onChange={(event) => {
      setGeneration(event.currentTarget.value);
      cancel();
    }}>
      <option value="">Latest backup</option>
      {generations.slice(1).map((item) => <option key={item.createdAt} value={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</option>)}
    </select></label>}
    {review ? <div className="backup-restore-detail">
      <h4>Restore preview</h4>
      <p>{review.accountLabel} · {workspaceName}</p>
      <p>Backup created <time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleString()}</time></p>
      <table>
        <thead><tr><th scope="col">Items</th><th scope="col">Add</th><th scope="col">Duplicates</th><th scope="col">Over limit</th></tr></thead>
        <tbody>{dataTypes.flatMap(([key, label]) => {
          const count = review.counts[key];
          return count ? [<tr key={key}><th scope="row">{label}</th>
            <td>{count.added}</td><td>{count.duplicates}</td><td>{count.capacityExceeded}</td></tr>] : [];
        })}</tbody>
      </table>
      <p>Existing data stays in place. Restored tabs stay paused until opened.</p>
      <div className="backup-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy || !dataTypes.some(([key]) => review.counts[key]?.added)} onClick={() => void restore()}>Add reviewed items</button>
      </div>
    </div> : <form onSubmit={(event) => void load(event)} className="backup-restore-detail">
      <label>Recovery code {account.backupEnabled && '(optional on this PC)'}
        <input type="password" value={code} maxLength={64} autoComplete="off" disabled={busy}
          required={!account.backupEnabled} onChange={(event) => setCode(event.target.value)} />
      </label>
      <div className="backup-actions">
        <button type="submit" className="secondary-button" disabled={busy || (!account.backupEnabled && !code.trim())}>Verify and preview backup</button>
        {busy && <button type="button" className="secondary-button" onClick={cancel}>Cancel preview</button>}
      </div>
    </form>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
