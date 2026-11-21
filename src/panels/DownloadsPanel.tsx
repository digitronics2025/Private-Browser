import { useEffect, useState } from 'react';
import { Download, FileDown } from 'lucide-react';
import { downloadOpenBlock } from '../../electron/download-safety';
import type { BrowserSnapshot, DownloadByteProgress, DownloadEntry } from '../../electron/types';
import { EmptyState, PanelHeader } from './common';
import { humanBytes } from '../lib/format';

const statusText = {
  progressing: 'Downloading',
  completed: 'Downloaded',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const checksumText: Record<NonNullable<DownloadEntry['checksum']>, string> = {
  checking: 'Checking against the published release',
  verified: 'Matches the published release',
  mismatch: 'Mismatch',
  unchecked: 'Could not verify',
};

function publisherText(publisher: DownloadEntry['publisher']): string {
  switch (publisher?.state) {
    case 'valid': return publisher.name ? `Verified by Windows · ${publisher.name}` : 'Verified by Windows';
    case 'unsigned': return 'No Windows signature';
    case 'untrusted': return 'Windows did not verify the signature';
    case 'unavailable': return 'Windows signature check unavailable';
    default: return 'No publisher check for this file';
  }
}

export function DownloadsPanel({ state, onToast }: { state: BrowserSnapshot; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [byteProgress, setByteProgress] = useState<DownloadByteProgress>();
  const accountSpaceId = state.activeAccountSpaceId;
  useEffect(() => {
    let mounted = true;
    const receive = (next: DownloadByteProgress) => {
      if (!mounted || next.accountSpaceId !== accountSpaceId) return;
      setByteProgress((prior) => !prior || next.revision > prior.revision ? next : prior);
    };
    const unsubscribe = window.privateBrowser.onDownloadProgress(receive);
    void window.privateBrowser.getState().then((snapshot) => {
      const { activeAccountSpaceId, downloadProgressRevision } = snapshot;
      if (downloadProgressRevision === undefined) return;
      receive({ accountSpaceId: activeAccountSpaceId, revision: downloadProgressRevision,
        entries: snapshot.downloads.filter((item) => item.state === 'progressing') });
    }).catch(() => undefined);
    return () => { mounted = false; unsubscribe(); };
  }, [accountSpaceId]);
  const sizes = byteProgress?.accountSpaceId === accountSpaceId && byteProgress.revision > (state.downloadProgressRevision ?? 0)
    ? new Map(byteProgress.entries.map((entry) => [entry.id, entry])) : undefined;
  const needle = query.trim().toLowerCase();
  const visible = state.downloads.filter((item) => (status === 'all' || item.state === status)
    && `${item.filename} ${item.origin ?? ''}`.toLowerCase().includes(needle));
  const run = (action: () => Promise<void>) => void action().catch((error: unknown) => onToast(error instanceof Error ? error.message : String(error), 'error'));
  const folder = state.downloadFolder;
  const batch = state.downloadBatch;
  return <div className="side-panel">
    <PanelHeader icon={FileDown} eyebrow="Account Space" title="Downloads" />
    {folder && <div className="settings-card download-filters">
      <p className="download-origin">Save folder <strong>{folder.name ?? 'Windows default'}</strong></p>
      <div className="download-actions">
        <button disabled={!folder.available || Boolean(state.recovery)}
          onClick={() => run(() => window.privateBrowser.chooseDownloadFolder(state.activeAccountSpaceId))}>
          {folder.name ? 'Change folder' : 'Choose folder'}
        </button>
        {folder.name && <button disabled={Boolean(state.recovery)}
          onClick={() => run(() => window.privateBrowser.setDownloadFolderMode(state.activeAccountSpaceId, 'default'))}>Use default</button>}
      </div>
      <label><input type="checkbox" checked={folder.ask} disabled={!folder.name || Boolean(state.recovery)}
        onChange={(event) => {
          const mode = event.currentTarget.checked ? 'ask' : 'automatic';
          run(() => window.privateBrowser.setDownloadFolderMode(state.activeAccountSpaceId, mode));
        }} /> Ask where to save</label>
      {!folder.available && <p>Windows protected storage is unavailable for download folders.</p>}
      {folder.name && !folder.ask && <p>New files with the same name get a number. Installers and potentially unsafe files still ask where to save.</p>}
    </div>}
    {batch && batch.active + batch.completed + batch.stopped > 1 && <p className="download-batch" aria-label="Downloads this session">
      This session · {batch.active} active · {batch.completed} downloaded · {batch.stopped} stopped
    </p>}
    {state.downloadHistory && <div className="settings-card download-filters">
      <label><input type="checkbox" checked={state.downloadHistory === 'on'} disabled={state.downloadHistory === 'unavailable' || Boolean(state.recovery)}
        onChange={(event) => {
          const enabled = event.currentTarget.checked;
          run(() => window.privateBrowser.setDownloadHistory(state.activeAccountSpaceId, enabled));
        }} /> Keep download history</label>
      <p>{state.downloadHistory === 'unavailable' ? 'Windows protected storage is unavailable for download history.'
        : 'Keeps up to 100 finished downloads in this Account Space on this device.'}</p>
      {state.downloads.length > 0 && <>
        <label>Search downloads<input type="search" value={query} maxLength={160} onChange={(event) => setQuery(event.currentTarget.value)} /></label>
        <label>Status<select aria-label="Download status" value={status} onChange={(event) => setStatus(event.currentTarget.value)}>
          <option value="all">All statuses</option>
          {Object.entries(statusText).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
      </>}
    </div>}
    <div className="download-list">{visible.map((item) => {
      const { receivedBytes, totalBytes } = (item.state === 'progressing' && sizes?.get(item.id)) || item;
      const progress = totalBytes ? Math.min(100, Math.round(receivedBytes / totalBytes * 100)) : undefined;
      const blocked = downloadOpenBlock(item);
      const type = item.risk === 'deceptive' ? ' · Deceptive double extension'
        : item.risk === 'dangerous' ? ' · May run code' : '';
      return <div className="download-card" key={item.id}>
        <div className="download-icon"><FileDown size={18} /></div>
        <div className="download-body">
          <strong>{item.filename}</strong>
          <small>{item.checksum === 'checking' ? 'Waiting for verification' : item.paused ? 'Paused' : statusText[item.state]}</small>
          {item.origin && <small className="download-origin">{item.origin}</small>}
          {item.finishedAt && <small><time dateTime={item.finishedAt}>{dateTime.format(new Date(item.finishedAt))}</time></small>}
          {item.state === 'progressing' && <small>{totalBytes
            ? `${humanBytes(receivedBytes)} of ${humanBytes(totalBytes)}`
            : `${humanBytes(receivedBytes)} downloaded`}</small>}
          {item.state === 'progressing' && <div className="progress" role="progressbar" aria-label={item.filename} aria-valuenow={progress}>
            <span style={{ width: `${progress ?? 0}%` }} />
          </div>}
          <dl className="download-evidence">
            <div><dt>File extension</dt><dd>{item.extension ?? 'Unknown'}{type}</dd></div>
            <div><dt>Release checksum</dt><dd>{item.checksum ? checksumText[item.checksum] : 'No release checksum for this file'}</dd></div>
            <div><dt>Windows publisher</dt><dd>{publisherText(item.publisher)}</dd></div>
          </dl>
          {blocked && item.state === 'completed' && <small>{blocked}</small>}
          {item.state === 'interrupted' && !item.canResume && <small>Start a fresh download from the original page.</small>}
          {item.destinationNote === 'folder-unavailable' && <small>The selected save folder was unavailable. Windows opened its save dialog.</small>}
          {item.destinationNote === 'saved-in-temporary-folder' && <small>The file is in a temporary subfolder. Use Show folder to find it.</small>}
          <div className="download-actions">
            <button disabled={Boolean(blocked)} onClick={() => run(() => window.privateBrowser.openDownload(item.id))}>Open</button>
            <button disabled={item.state !== 'completed' || item.checksum === 'checking'} onClick={() => run(() => window.privateBrowser.showDownload(item.id))}>Show folder</button>
            {item.canPause && <button onClick={() => run(() => window.privateBrowser.controlDownload(item.id, 'pause'))}>Pause</button>}
            {item.paused && item.canResume && <button onClick={() => run(() => window.privateBrowser.controlDownload(item.id, 'resume'))}>Resume</button>}
            {item.state === 'interrupted' && !item.paused && item.canResume && <button onClick={() => run(() => window.privateBrowser.controlDownload(item.id, 'retry'))}>Retry</button>}
            {item.canCancel && <button onClick={() => run(() => window.privateBrowser.controlDownload(item.id, 'cancel'))}>Cancel download</button>}
            {item.state !== 'progressing' && !item.canCancel && item.checksum !== 'checking' && state.downloadHistory && <button
              title="Remove the list entry. The file stays on disk."
              onClick={() => run(() => window.privateBrowser.removeDownloadEntry(state.activeAccountSpaceId, item.id))}>Remove from list</button>}
          </div>
        </div>
      </div>;
    })}</div>
    {!visible.length && <EmptyState icon={Download} text={state.downloads.length ? 'No downloads match these filters.' : 'Downloaded files will appear here.'} />}
  </div>;
}
