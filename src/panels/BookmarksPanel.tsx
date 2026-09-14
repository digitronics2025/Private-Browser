import { useMemo, useState } from 'react';
import { FileDown, Globe2, Pencil, Search, Star, Trash2, Upload } from 'lucide-react';
import type { Bookmark } from '../../electron/types';
import { domainFromUrl } from '../lib/format';
import { EmptyState, PanelHeader } from './common';

const MAX_ROWS = 400;

export function BookmarksPanel({ bookmarks, favicons, onOpen, onRename, onRemove, onImport, onExport }: {
  bookmarks: Bookmark[];
  favicons: Map<string, string>;
  onOpen: (id: string) => void;
  onRename: (item: Bookmark) => void;
  onRemove: (item: Bookmark) => void;
  onImport: () => void;
  onExport: () => void;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase();
  const matches = useMemo(() => bookmarks
    .filter((item) => !needle || `${item.title} ${item.url} ${item.folderPath.join(' ')}`.toLocaleLowerCase().includes(needle))
    .sort((left, right) => (left.location === right.location ? 0 : left.location === 'bar' ? -1 : 1)
      || left.folderPath.join('/').localeCompare(right.folderPath.join('/'))
      || (left.orderPath.at(-1) ?? left.order) - (right.orderPath.at(-1) ?? right.order)), [bookmarks, needle]);
  return (
    <div className="side-panel">
      <PanelHeader icon={Star} eyebrow="This Account Space" title="Bookmarks" />
      <label className="vault-search"><Search size={14} /><input aria-label="Search bookmarks" placeholder="Search bookmarks" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="panel-actions">
        <button type="button" onClick={onImport}><Upload size={14} /> Import</button>
        <button type="button" onClick={onExport} disabled={!bookmarks.length}><FileDown size={14} /> Export</button>
      </div>
      <p className="panel-count">{needle ? `${matches.length} of ${bookmarks.length} bookmarks` : `${bookmarks.length} bookmarks`}</p>
      <ul className="item-list">
        {matches.slice(0, MAX_ROWS).map((item) => {
          const icon = favicons.get(domainFromUrl(item.url));
          const place = [item.location === 'bar' ? 'Bookmarks bar' : 'Other bookmarks', ...item.folderPath].join(' › ');
          return (
            <li key={item.id} className="item-row">
              <button type="button" className="item-row-main" title={item.url} onClick={() => onOpen(item.id)}>
                <span className="item-row-icon" aria-hidden="true">{icon ? <img src={icon} alt="" /> : <Globe2 size={15} />}</span>
                <span className="item-row-text"><strong>{item.title || domainFromUrl(item.url)}</strong><small>{domainFromUrl(item.url)} · {place}</small></span>
              </button>
              <button type="button" className="item-row-action" aria-label={`Rename ${item.title}`} title="Edit name" onClick={() => onRename(item)}><Pencil size={14} /></button>
              <button type="button" className="item-row-action danger" aria-label={`Delete ${item.title}`} title="Delete" onClick={() => onRemove(item)}><Trash2 size={14} /></button>
            </li>
          );
        })}
      </ul>
      {matches.length > MAX_ROWS && <p className="panel-count">Showing the first {MAX_ROWS}. Search to narrow the list.</p>}
      {!matches.length && <EmptyState icon={Star} text={needle ? 'No bookmark matches that search.' : 'Star a page to keep it close.'} />}
    </div>
  );
}
