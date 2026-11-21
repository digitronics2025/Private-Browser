import { useDeferredValue, useMemo, useState } from 'react';
import { FileDown, Globe2, Pencil, Search, Star, Trash2, Upload } from 'lucide-react';
import type { Bookmark } from '../../electron/types';
import { domainFromUrl } from '../lib/format';
import { EmptyState, PanelHeader } from './common';

const PAGE_SIZE = 75;
const folderOrder = new Intl.Collator();

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
  const [folder, setFolder] = useState('');
  const [requestedPage, setRequestedPage] = useState(0);
  const needle = useDeferredValue(query.trim().toLocaleLowerCase());
  const folderNeedle = useDeferredValue(folder.trim().toLocaleLowerCase());
  const index = useMemo(() => bookmarks.map((item) => {
    const folderPath = item.folderPath.join(' / ');
    const location = item.location === 'bar' ? 'Bookmarks bar' : 'Other bookmarks';
    const place = item.folderPath.length ? location + ' / ' + folderPath : location;
    return { item, folderPath, place, folderSearch: place.toLocaleLowerCase(), search: (item.title + ' ' + item.url + ' ' + place).toLocaleLowerCase() };
  }).sort((left, right) => (left.item.location === right.item.location ? 0 : left.item.location === 'bar' ? -1 : 1)
    || folderOrder.compare(left.folderPath, right.folderPath)
    || (left.item.orderPath.at(-1) ?? left.item.order) - (right.item.orderPath.at(-1) ?? right.item.order)), [bookmarks]);
  const matches = useMemo(() => index.filter((entry) =>
    entry.search.includes(needle) && entry.folderSearch.includes(folderNeedle)), [index, needle, folderNeedle]);
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  return (
    <div className="side-panel">
      <PanelHeader icon={Star} eyebrow="This Account Space" title="Bookmarks" />
      <label className="vault-search"><Search size={14} /><input aria-label="Search bookmarks" placeholder="Search bookmarks" value={query} onChange={(event) => { setQuery(event.target.value); setRequestedPage(0); }} /></label>
      <label className="vault-search"><Search size={14} /><input aria-label="Filter by bookmark folder" placeholder="Filter by folder" value={folder} onChange={(event) => { setFolder(event.target.value); setRequestedPage(0); }} /></label>
      <div className="panel-actions">
        <button type="button" onClick={onImport}><Upload size={14} /> Import</button>
        <button type="button" onClick={onExport} disabled={!bookmarks.length}><FileDown size={14} /> Export</button>
      </div>
      <p className="panel-count">{needle || folderNeedle ? `${matches.length} of ${bookmarks.length} bookmarks` : `${bookmarks.length} bookmarks`}</p>
      {pages > 1 && <nav className="panel-actions" aria-label="Bookmark pages">
        <button type="button" disabled={page === 0} onClick={() => setRequestedPage(page - 1)}>Previous</button>
        <button type="button" disabled={page + 1 === pages} onClick={() => setRequestedPage(page + 1)}>Next</button>
        <span className="panel-count" aria-live="polite">Page {page + 1} of {pages}</span>
      </nav>}
      <ul className="item-list">
        {matches.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ item, place }) => {
          const icon = favicons.get(domainFromUrl(item.url));
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
      {!matches.length && <EmptyState icon={Star} text={needle || folderNeedle ? 'No bookmark matches those filters.' : 'Star a page to keep it close.'} />}
    </div>
  );
}
