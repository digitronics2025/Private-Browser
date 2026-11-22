import { useRef, useState } from 'react';
import type { NotesDraftReview } from '../../electron/notes-panel';
import { useModalFocus } from '../lib/dialog';
import { useOverlayLayer } from './overlay';

export function NotesDraftDialog({ review, onClose, onDone }: {
  review: NotesDraftReview;
  onClose: () => void;
  onDone: (copied: boolean) => void;
}) {
  useOverlayLayer();
  const dialog = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(review.title);
  const [text, setText] = useState(review.text);
  const [includeSource, setIncludeSource] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancel = () => {
    if (busy) return;
    void window.privateBrowser.cancelNotesDraft(review.id).catch(() => undefined);
    onClose();
  };
  useModalFocus(dialog, cancel, 'input');
  const confirm = async (copyOnly: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await window.privateBrowser.deliverNotesDraft({ id: review.id, title, text, includeSource }, copyOnly);
      onDone(copyOnly);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The draft could not be opened.');
    } finally { setBusy(false); }
  };
  const valid = title.trim() && text.trim();
  return <div className="modal-backdrop prompt-backdrop" role="presentation">
    <div ref={dialog} className="prompt-dialog notes-draft-dialog" role="dialog" aria-modal="true" aria-labelledby="notes-draft-heading">
      <h2 id="notes-draft-heading">Review text for Notes</h2>
      <label>Title<input maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label>Selected text<textarea maxLength={8_000} rows={7} value={text} onChange={(event) => setText(event.target.value)} /></label>
      <label className="notes-draft-source"><input type="checkbox" checked={includeSource} onChange={(event) => setIncludeSource(event.target.checked)} />
        Include source site {review.source}</label>
      {review.redactions > 0 && <p>{review.redactions} sensitive details were removed.</p>}
      <p>Save in Notes to add this draft to the library. Copy excerpt puts the reviewed text on the clipboard temporarily.</p>
      {error && <p role="alert">{error}</p>}
      <footer className="recovery-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>Cancel</button>
        <button type="button" className="secondary-button" disabled={busy || !valid} onClick={() => void confirm(true)}>Copy excerpt</button>
        <button type="button" className="primary-button" disabled={busy || !valid} onClick={() => void confirm(false)}>Open Notes draft</button>
      </footer>
    </div>
  </div>;
}
