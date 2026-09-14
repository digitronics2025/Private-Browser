import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import type { FindResult } from '../../electron/types';
import { disposer } from '../lib/subscribe';

export function FindBar({ tabId, focusSignal, onClose }: { tabId: string; focusSignal: number; onClose: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<FindResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);

  useEffect(() => disposer(window.privateBrowser.onFindResult((next) => {
    if (next.tabId === tabId) setResult(next);
  })), [tabId]);

  useEffect(() => {
    if (!text) {
      setResult(null);
      void window.privateBrowser.stopFindInPage().catch(() => undefined);
      return;
    }
    // Electron starts a fresh search session when the third argument is true.
    void window.privateBrowser.findInPage(text, true, true).catch(() => undefined);
  }, [text, tabId]);

  const step = (forward: boolean) => {
    if (text) void window.privateBrowser.findInPage(text, forward, false).catch(() => undefined);
  };
  const close = () => {
    void window.privateBrowser.stopFindInPage().catch(() => undefined);
    onClose();
  };

  return (
    <div className="find-bar" role="search" aria-label="Find in page">
      <div className="find-card">
        <input
          ref={inputRef}
          aria-label="Find in page"
          placeholder="Find in page"
          value={text}
          maxLength={1000}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); step(!event.shiftKey); }
            if (event.key === 'Escape') { event.preventDefault(); close(); }
          }}
        />
        <span className="find-count" aria-live="polite">{result && text ? `${result.matches ? result.activeMatchOrdinal : 0}/${result.matches}` : ''}</span>
        <span className="find-divider" aria-hidden="true" />
        <button type="button" className="toolbar-button small" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!text} onClick={() => step(false)}><ChevronUp size={16} /></button>
        <button type="button" className="toolbar-button small" aria-label="Next match" title="Next (Enter)" disabled={!text} onClick={() => step(true)}><ChevronDown size={16} /></button>
        <button type="button" className="toolbar-button small" aria-label="Close find bar" title="Close (Esc)" onClick={close}><X size={16} /></button>
      </div>
    </div>
  );
}
