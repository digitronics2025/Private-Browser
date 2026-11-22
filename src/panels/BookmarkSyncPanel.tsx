import { useEffect, useState } from 'react';
import type { BookmarkSyncAction, BookmarkSyncPreview, BookmarkSyncStatus } from '../../electron/bookmark-sync';
import type { AccountSpaceSummary } from '../../electron/types';

export default function BookmarkSyncPanel({ account }: { account: AccountSpaceSummary }) {
  const [opened, setOpened] = useState(false);
  const [status, setStatus] = useState<BookmarkSyncStatus>();
  const [review, setReview] = useState<BookmarkSyncPreview>();
  const [choice, setChoice] = useState<'local' | 'remote'>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const connected = account.googleConnection === 'connected' && account.enabledModules.includes('encrypted-backup') && !account.locked;

  async function run(action: BookmarkSyncAction) {
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await window.privateBrowser.changeBookmarkSync(account.id, action, action === 'apply' ? review?.id : undefined, action === 'apply' ? choice : undefined);
      if (!result) return;
      if ('id' in result) {
        setReview(result);
        setChoice(undefined);
      } else {
        setStatus(result);
        if (action === 'apply' || action === 'unpair') setReview(undefined);
        if (action === 'export-pairing') setNotice({ text: 'Encrypted pairing file saved.' });
        if (action === 'import-pairing') setNotice({ text: 'Device paired. Review sync to combine the libraries.' });
      }
    } catch (error) {
      if (action === 'apply') setReview(undefined);
      setNotice({ text: error instanceof Error ? error.message : 'Bookmark sync is unavailable.', error: true });
    } finally { setBusy(false); }
  }

  useEffect(() => {
    if (!opened || !connected) return;
    let active = true;
    void window.privateBrowser.changeBookmarkSync(account.id, 'status').then((value) => {
      if (active && value && 'enabled' in value) setStatus(value);
    }, (error: unknown) => {
      if (active) setNotice({ text: error instanceof Error ? error.message : 'Bookmark sync is unavailable.', error: true });
    });
    return () => { active = false; };
  }, [account.id, opened, connected]);

  return <details className="settings-card bookmark-sync" onToggle={(event) => setOpened(event.currentTarget.open)}>
    <summary>Encrypted bookmark sync</summary>
    {!connected ? <p>Connect Google and turn on Encrypted backup access in this Account Space to pair bookmarks.</p> : <>
      <p>{status?.lastSyncedAt ? `Last sync ${new Date(status.lastSyncedAt).toLocaleString()}` : status?.enabled ? 'Paired. Review your first sync.' : 'Pair this library with another device.'}</p>
      {!status?.enabled ? <div className="bridge-action-row">
        <button type="button" disabled={busy || !status} onClick={() => void run('start')}>{status?.initializing ? 'Retry pairing' : 'Start pairing'}</button>
        {!status?.initializing && <button type="button" disabled={busy || !status} onClick={() => void run('import-pairing')}>Open pairing file</button>}
      </div> : <div className="bridge-action-row">
        <button type="button" disabled={busy} onClick={() => void run('review')}>Review sync</button>
        <button type="button" disabled={busy} onClick={() => void run('export-pairing')}>Save pairing file</button>
        <button type="button" disabled={busy} onClick={() => void run('unpair')}>Disconnect this device</button>
      </div>}
      {review && <div aria-label="Bookmark sync review" role="region">
        <p>This device has {review.deviceBookmarks} syncable bookmarks. The paired library has {review.pairedBookmarks}.</p>
        {Boolean(review.removedHere || review.removedInPair) && <p>Removed since last sync: {review.removedHere} on this device and {review.removedInPair} in the paired library.</p>}
        {review.deviceOnlyBookmarks > 0 && <p>{review.deviceOnlyBookmarks} links with sign-in details stay on this device.</p>}
        {review.conflicts.length > 0 && <>
          <ul>{review.conflicts.map(({ id, local, remote }) => <li key={id}>{local ?? 'Deleted on this device'} ↔ {remote ?? 'Deleted in the paired library'}</li>)}</ul>
          <label>For these conflicts
            <select value={choice ?? ''} onChange={(event) => setChoice(event.currentTarget.value as typeof choice)}>
              <option value="">Choose which version to keep</option><option value="local">Keep this device’s versions</option><option value="remote">Keep the paired versions</option>
            </select>
          </label>
        </>}
        <div className="bridge-action-row">
          <button type="button" disabled={busy || Boolean(review.conflicts.length && !choice)} onClick={() => void run('apply')}>Apply bookmark sync</button>
          <button type="button" disabled={busy} onClick={() => setReview(undefined)}>Cancel review</button>
        </div>
      </div>}
    </>}
    {notice && <p role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </details>;
}
