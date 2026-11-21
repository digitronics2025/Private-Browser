import { Download, FileDown } from 'lucide-react';
import { downloadOpenBlock } from '../../electron/download-safety';
import type { BrowserSnapshot, DownloadEntry } from '../../electron/types';
import { EmptyState, PanelHeader } from './common';
import { humanBytes } from '../lib/format';

const statusText = {
  progressing: 'Downloading',
  completed: 'Downloaded',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

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
  const run = (action: () => Promise<void>) => void action().catch((error: unknown) => onToast(error instanceof Error ? error.message : String(error), 'error'));
  return <div className="side-panel">
    <PanelHeader icon={FileDown} eyebrow="This session" title="Downloads" />
    <div className="download-list">{state.downloads.map((item) => {
      const progress = item.totalBytes ? Math.min(100, Math.round(item.receivedBytes / item.totalBytes * 100)) : 0;
      const blocked = downloadOpenBlock(item);
      const type = item.risk === 'deceptive' ? ' · Deceptive double extension'
        : item.risk === 'dangerous' ? ' · May run code' : '';
      return <div className="download-card" key={item.id}>
        <div className="download-icon"><FileDown size={18} /></div>
        <div className="download-body">
          <strong>{item.filename}</strong>
          <small>{item.state === 'progressing' ? `${humanBytes(item.receivedBytes)} of ${humanBytes(item.totalBytes)}` : statusText[item.state]}</small>
          {item.state === 'progressing' && <div className="progress" role="progressbar" aria-label={item.filename} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>}
          <dl className="download-evidence">
            <div><dt>File extension</dt><dd>{item.extension ?? 'Unknown'}{type}</dd></div>
            <div><dt>Release checksum</dt><dd>{item.checksum ? checksumText[item.checksum] : 'No release checksum for this file'}</dd></div>
            <div><dt>Windows publisher</dt><dd>{publisherText(item.publisher)}</dd></div>
          </dl>
          {blocked && item.state === 'completed' && <small>{blocked}</small>}
          <div className="download-actions">
            <button disabled={Boolean(blocked)} onClick={() => run(() => window.privateBrowser.openDownload(item.id))}>Open</button>
            <button disabled={item.state !== 'completed'} onClick={() => run(() => window.privateBrowser.showDownload(item.id))}>Show folder</button>
          </div>
        </div>
      </div>;
    })}</div>
    {!state.downloads.length && <EmptyState icon={Download} text="Downloaded files will appear here." />}
  </div>;
}
