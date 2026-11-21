import { useEffect, useRef, useState } from 'react';
import { Keyboard } from 'lucide-react';
import { SHORTCUT_GUIDE } from '../../electron/shortcuts';
import { PanelHeader } from './common';

export function ShortcutGuide() {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const terms = query.trim().toLowerCase().split(/\s+/);
  const results = Object.entries(SHORTCUT_GUIDE).filter(([, [label, keys]]) => {
    const text = (label + ' ' + keys.replaceAll('+', ' + ') + ' ' + keys).toLowerCase();
    return terms.every((term) => text.includes(term === 'control' ? 'ctrl' : term));
  });
  return <div className="side-panel shortcut-guide">
    <PanelHeader icon={Keyboard} title="Keyboard shortcuts" />
    <label>Search shortcuts<input ref={input} type="search" maxLength={80} value={query}
      onChange={(event) => setQuery(event.currentTarget.value)} /></label>
    {results.length ? <dl>{results.map(([command, [label, keys]]) => <div key={command}>
      <dt>{label}</dt><dd><kbd>{keys}</kbd></dd>
    </div>)}</dl> : <p role="status">No matching shortcuts.</p>}
  </div>;
}
