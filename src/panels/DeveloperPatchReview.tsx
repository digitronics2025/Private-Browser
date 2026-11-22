import { useState } from 'react';
import type { ReviewedPatchResult } from '@private-browser/bridge-protocol';
import type { TestReport } from '../../electron/types';

export default function DeveloperPatchReview({ report, onReport, onToast }: {
  report?: TestReport;
  onReport: (report: TestReport) => void;
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const [source, setSource] = useState('');
  const [includeTest, setIncludeTest] = useState(true);
  const [preview, setPreview] = useState<ReviewedPatchResult>();
  const [applied, setApplied] = useState<ReviewedPatchResult>();
  const [busy, setBusy] = useState(false);
  const run = async (action: 'ai.review-patch' | 'ai.apply-patch' | 'ai.undo-patch' | 'ai.rerun-patch') => {
    if (busy) return;
    setBusy(true);
    try {
      if (action === 'ai.review-patch') {
        let edits: unknown;
        try { edits = JSON.parse(source); } catch { throw new Error('Paste a JSON list of paths and their proposed replacement text.'); }
        const result = await window.privateBrowser.runBridgeAction(action, { edits, ...(report && includeTest ? { reportId: report.id } : {}) });
        setPreview(result as ReviewedPatchResult);
        setSource('');
        onToast('Review the file comparisons in VS Code.');
      } else if (action === 'ai.apply-patch' && preview) {
        const result = await window.privateBrowser.runBridgeAction(action, { id: preview.id });
        setApplied(result as ReviewedPatchResult);
        setPreview(undefined);
        onToast('Applied to VS Code editors. Save the changed files before rerunning.');
      } else if (applied && action === 'ai.undo-patch') {
        await window.privateBrowser.runBridgeAction(action, { id: applied.id });
        setApplied(undefined);
        onToast('Reviewed patch undone in VS Code.');
      } else if (applied && action === 'ai.rerun-patch') {
        onReport(await window.privateBrowser.runBridgeAction(action, { id: applied.id }) as TestReport);
        onToast('Test rerun complete.');
      }
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'The patch operation could not finish.', 'error');
    } finally { setBusy(false); }
  };
  return <section className="project-summary patch-review" aria-label="Review a proposed patch">
    <strong>Review a proposed patch</strong>
    <label>Proposed file replacements
      <textarea value={source} onChange={(event) => { setSource(event.currentTarget.value); setPreview(undefined); }}
        maxLength={100_000} rows={4} spellCheck={false} placeholder={'[{"path":"src/example.ts","newText":"replacement text"}]'} />
    </label>
    {report && <label className="bridge-check"><input type="checkbox" checked={includeTest} onChange={(event) => setIncludeTest(event.currentTarget.checked)} /> Link the latest local test report</label>}
    <div className="bridge-action-row"><button type="button" disabled={busy || !source.trim()} onClick={() => void run('ai.review-patch')}>Review in VS Code</button></div>
    {preview && <><p>Review these comparisons in VS Code before applying.</p><ul>{preview.files.map((file) => <li key={file}>{file}</li>)}</ul>
      <button type="button" disabled={busy} onClick={() => void run('ai.apply-patch')}>Apply reviewed patch</button></>}
    {applied && <><p>Applied files</p><ul>{applied.files.map((file) => <li key={file}>{file}</li>)}</ul>
      <div className="bridge-action-row">
        <button type="button" disabled={busy} onClick={() => void run('ai.undo-patch')}>Undo patch</button>
        {applied.reportId && <button type="button" disabled={busy} onClick={() => void run('ai.rerun-patch')}>Rerun test after saving</button>}
      </div></>}
  </section>;
}
