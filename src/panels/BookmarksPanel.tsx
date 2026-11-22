import { lazy, Suspense, useDeferredValue, useMemo, useState } from 'react';
import { FileDown, Globe2, Link2, Pencil, Search, Star, Trash2, Upload } from 'lucide-react';
import { bookmarkFolderKey, bookmarkFolderLabel, bookmarkFolders, duplicateBookmarkIds, MAX_BOOKMARK_EDIT_BATCH } from '../../electron/bookmark-maintenance';
import type { AccountSpaceSummary, Bookmark, BookmarkFolder, BookmarkLevelInput, BrowserSnapshot } from '../../electron/types';
import { domainFromUrl } from '../lib/format';
import { EmptyState, PanelHeader } from './common';
import { BookmarkFolderTree } from './BookmarkFolderTree';

const PAGE_SIZE = 75;
const folderOrder = new Intl.Collator();
const BookmarkSyncPanel = lazy(() => import('./BookmarkSyncPanel'));

export function BookmarksPanel({ bookmarks, savedFolders, favicons, undo, syncAccount, onOpen, onRename, onEditAddress, onRemove, onImport, onExport, onBatch, onUndo, onCreateFolder, onMoveFolder, onRenameFolder, onDeleteFolder, onBookmarkPage }: {
  bookmarks: Bookmark[];
  savedFolders: BookmarkFolder[];
  favicons: Map<string, string>;
  undo: BrowserSnapshot['bookmarkUndo'];
  syncAccount?: AccountSpaceSummary;
  onOpen: (id: string) => void;
  onRename: (item: Bookmark) => void;
  onEditAddress: (item: Bookmark) => void;
  onRemove: (item: Bookmark) => void;
  onImport: () => void;
  onExport: () => void;
  onBatch: (ids: string[], destination?: BookmarkLevelInput) => Promise<number>;
  onUndo: () => Promise<number>;
  onCreateFolder: (parent: BookmarkLevelInput) => void;
  onMoveFolder: (folder: BookmarkLevelInput) => void;
  onRenameFolder: (parent: BookmarkLevelInput, name: string) => void;
  onDeleteFolder: (parent: BookmarkLevelInput, name: string, count: number) => void;
  onBookmarkPage?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [folder, setFolder] = useState('');
  const [chosenFolder, setChosenFolder] = useState<BookmarkLevelInput>();
  const [requestedPage, setRequestedPage] = useState(0);
  const [duplicatesOnly, setDuplicatesOnly] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [operation, setOperation] = useState<'move' | 'delete'>();
  const [folderQuery, setFolderQuery] = useState('');
  const [destinationKey, setDestinationKey] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const needle = useDeferredValue(query.trim().toLocaleLowerCase());
  const folderNeedle = useDeferredValue(folder.trim().toLocaleLowerCase());
  const folders = useMemo(() => bookmarkFolders(bookmarks, savedFolders), [bookmarks, savedFolders]);
  const activeFolder = chosenFolder && folders.find((entry) => bookmarkFolderKey(entry) === bookmarkFolderKey(chosenFolder));
  const parentFolder = activeFolder && activeFolder.path.length ? { location: activeFolder.location, path: activeFolder.path.slice(0, -1) } : undefined;
  const index = useMemo(() => bookmarks.map((item) => {
    const folderPath = item.folderPath.join(' / ');
    const location = item.location === 'bar' ? 'Bookmarks bar' : 'Other bookmarks';
    const place = item.folderPath.length ? location + ' / ' + folderPath : location;
    return { item, folderPath, place, folderSearch: place.toLocaleLowerCase(), search: (item.title + ' ' + item.url + ' ' + place).toLocaleLowerCase() };
  }).sort((left, right) => (left.item.location === right.item.location ? 0 : left.item.location === 'bar' ? -1 : 1)
    || folderOrder.compare(left.folderPath, right.folderPath)
    || (left.item.orderPath.at(-1) ?? left.item.order) - (right.item.orderPath.at(-1) ?? right.item.order)), [bookmarks]);
  const duplicates = useMemo(() => duplicatesOnly ? duplicateBookmarkIds(bookmarks) : undefined, [bookmarks, duplicatesOnly]);
  const matches = useMemo(() => {
    const filtered = index.filter((entry) => (!duplicates || duplicates.has(entry.item.id))
      && entry.search.includes(needle) && entry.folderSearch.includes(folderNeedle)
      && (!activeFolder || (entry.item.location === activeFolder.location && entry.item.folderPath.length === activeFolder.path.length
        && activeFolder.path.every((part, depth) => entry.item.folderPath[depth] === part))));
    return duplicates ? filtered.sort((left, right) => left.item.url.localeCompare(right.item.url)) : filtered;
  }, [duplicates, index, needle, folderNeedle, activeFolder]);
  const selection = bookmarks.filter((item) => selected.has(item.id));
  const sourceFolders = [...new Set(selection.map((item) => bookmarkFolderLabel({ location: item.location, path: item.folderPath })))].sort(folderOrder.compare);
  const destinations = folders.filter((item) => bookmarkFolderLabel(item).toLocaleLowerCase().includes(folderQuery.toLocaleLowerCase())).slice(0, 50);
  const destination = destinations.find((item) => bookmarkFolderKey(item) === destinationKey);
  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selection.map((item) => item.id));
    if (checked && next.size < MAX_BOOKMARK_EDIT_BATCH) next.add(id);
    else if (!checked) next.delete(id);
    setSelected(next);
  };
  const run = async (action: () => Promise<number>, completed: (count: number) => string) => {
    setPending(true);
    setNotice(undefined);
    try { setNotice({ text: completed(await action()) }); }
    catch (error) { setNotice({ text: error instanceof Error ? error.message : String(error), error: true }); }
    finally { setPending(false); }
  };
  const confirm = () => {
    if (!operation || (operation === 'move' && !destination)) return;
    const verb = operation === 'move' ? 'moved' : 'deleted';
    void run(async () => {
      const count = await onBatch(selection.map((item) => item.id), destination);
      setSelected(new Set());
      setOperation(undefined);
      return count;
    }, (count) => `${count} bookmark${count === 1 ? '' : 's'} ${verb}.`);
  };
  return (
    <div className="side-panel">
      <PanelHeader icon={Star} eyebrow="This Account Space" title="Bookmarks" />
      {syncAccount && <Suspense fallback={null}><BookmarkSyncPanel account={syncAccount} /></Suspense>}
      <label className="vault-search"><Search size={14} /><input aria-label="Search bookmarks" placeholder="Search bookmarks" value={query} onChange={(event) => { setQuery(event.target.value); setRequestedPage(0); }} /></label>
      <label className="vault-search"><Search size={14} /><input aria-label="Filter by bookmark folder" placeholder="Filter by folder" value={folder} onChange={(event) => { setFolder(event.target.value); setRequestedPage(0); }} /></label>
      <div className="panel-actions">
        <button type="button" onClick={onImport}><Upload size={14} /> Import</button>
        <button type="button" onClick={onExport} disabled={!bookmarks.length && !savedFolders.length}><FileDown size={14} /> Export</button>
        <button type="button" aria-pressed={duplicatesOnly} onClick={() => { setDuplicatesOnly(!duplicatesOnly); setRequestedPage(0); }}>Duplicate addresses</button>
      </div>
      <details className="settings-card bookmark-folders">
        <summary>Manage folders</summary>
        <BookmarkFolderTree folders={folders} selected={activeFolder} onSelect={(target) => { setChosenFolder(target); setRequestedPage(0); }} />
        <div className="panel-actions">
          <button type="button" onClick={() => onCreateFolder(activeFolder ?? { location: 'bar', path: [] })}>New folder</button>
          {onBookmarkPage && <button type="button" onClick={onBookmarkPage}>Bookmark this tab in a folder</button>}
          {activeFolder && parentFolder && <>
            <button type="button" onClick={() => onRenameFolder(parentFolder, activeFolder.path.at(-1)!)}>Rename folder</button>
            <button type="button" onClick={() => onMoveFolder(activeFolder)}>Move folder</button>
            <button type="button" onClick={() => onDeleteFolder(parentFolder, activeFolder.path.at(-1)!, bookmarks.filter((item) =>
              item.location === activeFolder.location && activeFolder.path.every((part, depth) => item.folderPath[depth] === part)).length)}>Delete folder</button>
          </>}
        </div>
      </details>
      {undo && <div className="settings-card panel-actions">
        <span>{undo.count} {undo.count === 1 ? 'bookmark' : 'bookmarks'} {undo.kind}</span>
        <button type="button" disabled={pending} onClick={() => void run(onUndo, (count) => `${count} bookmark${count === 1 ? '' : 's'} restored.`)}>Undo bookmark change</button>
      </div>}
      {notice && <p className="panel-count" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
      {selection.length > 0 && <div className="panel-actions">
        <span className="panel-count">{selection.length} selected</span>
        <button type="button" disabled={pending} onClick={() => { setFolderQuery(''); setDestinationKey(''); setOperation('move'); }}>Move selected</button>
        <button type="button" disabled={pending} onClick={() => { setDestinationKey(''); setOperation('delete'); }}>Delete selected</button>
        <button type="button" disabled={pending} onClick={() => { setSelected(new Set()); setOperation(undefined); }}>Clear selection</button>
      </div>}
      {operation && selection.length > 0 && <section className="settings-card bookmark-cleanup" aria-labelledby="bookmark-cleanup-title">
        <h3 id="bookmark-cleanup-title">{operation === 'delete' ? 'Review bookmark deletion' : 'Choose a bookmark destination'}</h3>
        <p>{selection.length} {selection.length === 1 ? 'bookmark' : 'bookmarks'} from {sourceFolders.length} {sourceFolders.length === 1 ? 'folder' : 'folders'}</p>
        <ul>{sourceFolders.map((path) => <li key={path}>{path}</li>)}</ul>
        {operation === 'move' && <>
          <label>Find a destination folder <input value={folderQuery} onChange={(event) => { setFolderQuery(event.target.value); setDestinationKey(''); }} /></label>
          <label>Move to <select value={destinationKey} onChange={(event) => setDestinationKey(event.target.value)}>
            <option value="" disabled>Select a folder</option>
            {destinations.map((level) => <option key={bookmarkFolderKey(level)} value={bookmarkFolderKey(level)}>{bookmarkFolderLabel(level)}</option>)}
          </select></label>
        </>}
        <div className="panel-actions">
          <button type="button" disabled={pending || (operation === 'move' && !destination)} onClick={confirm}>
            {operation === 'move' ? 'Move' : 'Delete'} {selection.length} {selection.length === 1 ? 'bookmark' : 'bookmarks'}
          </button>
          <button type="button" disabled={pending} onClick={() => setOperation(undefined)}>Cancel</button>
        </div>
      </section>}
      <p className="panel-count">{needle || folderNeedle || duplicatesOnly || activeFolder ? `${matches.length} of ${bookmarks.length} bookmarks` : `${bookmarks.length} bookmarks`}</p>
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
              <input type="checkbox" aria-label={`Select ${item.title || domainFromUrl(item.url)}`} checked={selected.has(item.id)}
                disabled={pending || (!selected.has(item.id) && selection.length >= MAX_BOOKMARK_EDIT_BATCH)} onChange={(event) => toggle(item.id, event.target.checked)} />
              <button type="button" className="item-row-main" title={item.url} onClick={() => onOpen(item.id)}>
                <span className="item-row-icon" aria-hidden="true">{icon ? <img src={icon} alt="" /> : <Globe2 size={15} />}</span>
                <span className="item-row-text"><strong>{item.title || domainFromUrl(item.url)}</strong><small>{duplicatesOnly ? item.url : domainFromUrl(item.url)} · {place}</small></span>
              </button>
              <button type="button" className="item-row-action" aria-label={`Rename ${item.title}`} title="Edit name" onClick={() => onRename(item)}><Pencil size={14} /></button>
              <button type="button" className="item-row-action" aria-label={`Edit address for ${item.title || domainFromUrl(item.url)}`} title="Edit address" onClick={() => onEditAddress(item)}><Link2 size={14} /></button>
              <button type="button" className="item-row-action danger" aria-label={`Delete ${item.title}`} title="Delete" onClick={() => onRemove(item)}><Trash2 size={14} /></button>
            </li>
          );
        })}
      </ul>
      {!matches.length && <EmptyState icon={Star} text={needle || folderNeedle || duplicatesOnly ? 'No bookmark matches those filters.'
        : activeFolder ? 'This folder is empty.' : 'Star a page to keep it close.'} />}
    </div>
  );
}
