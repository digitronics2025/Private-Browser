import { useEffect, useId, useState } from 'react';
import { formatSafeDiagnostics, type DiagnosticReason } from '../lib/safe-diagnostics';

export function SafeDiagnostics({ reason }: { reason: DiagnosticReason }) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState('');
  const id = useId();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setFeedback('');
    setLoading(true);
    void window.privateBrowser.getUpdateService().then((status) => {
      if (active) setVersion(status?.currentVersion);
    }).catch(() => {
      if (active) setVersion(undefined);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [open, reason]);

  const report = formatSafeDiagnostics(reason, version);
  const copy = async () => {
    try {
      await window.privateBrowser.copyText(report);
      setFeedback('Diagnostics copied.');
    } catch {
      setFeedback('Clipboard unavailable. You can select the report and copy it.');
    }
  };

  return <div className="safe-diagnostics">
    <button type="button" className="text-button" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { if (!open) setLoading(true); setOpen(!open); }}>Copy diagnostics</button>
    {open && <div id={id} role="region" aria-label="Diagnostics preview" aria-busy={loading}>
      <pre aria-label="Report text">{report}</pre>
      <button type="button" className="secondary-button" disabled={loading} onClick={() => void copy()}>Copy report</button>
      {feedback && <p role="status">{feedback}</p>}
    </div>}
  </div>;
}
