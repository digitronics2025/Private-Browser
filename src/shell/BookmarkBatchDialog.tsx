import { useId, useMemo, useRef, useState } from 'react';
import type { Bookmark, BrowserTab } from '../../electron/types';
import { bookmarkBatchChoices, MAX_BOOKMARK_BATCH } from '../../electron/bookmark-batch';
import { useModalFocus } from '../lib/dialog';
import { useOverlayLayer } from './overlay';

const PAGE_SIZE = 20;

export function BookmarkBatchDialog({ items, tabs, accountName, onClose, onOpen }: {
  items: Bookmark[];
  tabs: BrowserTab[];
  accountName: string;
  onClose: () => void;
  onOpen: (ids: string[]) => Promise<void>;
}) {
  useOverlayLayer();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  useModalFocus(dialog, onClose);
  const choices = useMemo(() => bookmarkBatchChoices(items, tabs), [items, tabs]);
  const [selected, setSelected] = useState(() => new Set(choices.filter((choice) => !choice.reason).slice(0, 8).map(({ bookmark }) => bookmark.id)));
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stillSelected = choices.filter(({ bookmark, reason }) => selected.has(bookmark.id) && !reason).map(({ bookmark }) => bookmark.id);
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(stillSelected);
    if (checked && next.size < MAX_BOOKMARK_BATCH) next.add(id);
    if (!checked) next.delete(id);
    setSelected(next);
  };
  const open = async () => {
    setBusy(true);
    setError('');
    try { await onOpen(stillSelected); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return <div className="modal-backdrop prompt-backdrop">
    <div ref={dialog} className="prompt-dialog bookmark-batch-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}>Open bookmarks in background</h2>
      <p>{accountName} · {items.length} bookmarks. Choose up to {MAX_BOOKMARK_BATCH}.</p>
      <fieldset className="startup-tab-list" disabled={busy}>
        <legend>Bookmarks</legend>
        {choices.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ bookmark, reason }) => <label key={bookmark.id}>
          <input type="checkbox" checked={!reason && selected.has(bookmark.id)}
            disabled={Boolean(reason) || (stillSelected.length >= MAX_BOOKMARK_BATCH && !selected.has(bookmark.id))}
            onChange={(event) => toggle(bookmark.id, event.target.checked)} />
          <span>{bookmark.title || bookmark.url}<small>{bookmark.title && bookmark.url}{reason && ' · ' + reason}</small></span>
        </label>)}
      </fieldset>
      {choices.length > PAGE_SIZE && <div className="panel-actions">
        <button type="button" disabled={busy || page === 0} onClick={() => setPage(page - 1)}>Previous bookmarks</button>
        <button type="button" disabled={busy || (page + 1) * PAGE_SIZE >= choices.length} onClick={() => setPage(page + 1)}>Next bookmarks</button>
      </div>}
      {error && <p className="prompt-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy || !stillSelected.length} onClick={() => void open()}>Open selected ({stillSelected.length})</button>
      </div>
    </div>
  </div>;
}
