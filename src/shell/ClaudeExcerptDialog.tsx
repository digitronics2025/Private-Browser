import { useRef, useState } from 'react';
import type { PageExcerptReview } from '../../electron/types';
import { useModalFocus } from '../lib/dialog';
import { useOverlayLayer } from './overlay';

export function ClaudeExcerptDialog({ review, onClose, onCopied }: {
  review: PageExcerptReview;
  onClose: () => void;
  onCopied: () => void;
}) {
  useOverlayLayer();
  const dialog = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cancel = () => {
    if (busy) return;
    void window.privateBrowser.cancelClaudeExcerpt(review.id).catch(() => undefined);
    onClose();
  };
  useModalFocus(dialog, cancel, 'button');

  const copy = async () => {
    setBusy(true);
    try {
      await window.privateBrowser.copyClaudeExcerpt(review.id);
      onCopied();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not copy the excerpt.');
    } finally {
      setBusy(false);
    }
  };

  return <div className="modal-backdrop prompt-backdrop" role="presentation">
    <div ref={dialog} className="prompt-dialog claude-excerpt-dialog" role="dialog" aria-modal="true" aria-labelledby="claude-excerpt-heading">
      <h2 id="claude-excerpt-heading">Review excerpt for Claude</h2>
      <p>{review.url} · {review.redactions} redactions</p>
      <pre aria-label="Text to copy" tabIndex={0}>{review.text}</pre>
      <p>Paste and send it yourself when ready. This copy expires after 30 seconds.</p>
      {error && <p role="alert">{error}</p>}
      <footer className="recovery-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={cancel}>Cancel</button>
        <button type="button" className="primary-button" disabled={busy || Boolean(error)} onClick={() => void copy()}>Copy excerpt</button>
      </footer>
    </div>
  </div>;
}
