import { useEffect, useState } from 'react';
import type { ReportHistoryPage, ReportHistoryQuery, ReportHistoryRow } from '@private-browser/bridge-protocol';

const resultLabels: Record<ReportHistoryRow['status'], string> = {
  passed: 'Passed', attention: 'Needs attention', failed: 'Failed', skipped: 'Skipped',
};

export function developerReportExport(row: ReportHistoryRow): string {
  return JSON.stringify({
    format: 1, kind: row.kind, result: row.status, finishedAt: row.finishedAt,
    findingCount: row.findings, artifactCount: row.artifacts,
  }, null, 2);
}

export function DeveloperReportHistory({ projectId, busy, revision, onReplay, onToast }: {
  projectId: string;
  busy: boolean;
  revision: number;
  onReplay: (reportId: string) => void;
  onToast: (message: string, kind?: 'ok' | 'error') => void;
}) {
  const [query, setQuery] = useState<ReportHistoryQuery>({ page: 1 });
  const [page, setPage] = useState<ReportHistoryPage>();
  const [error, setError] = useState('');
  const [localRevision, setLocalRevision] = useState(0);
  const [exportText, setExportText] = useState('');

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const result = await window.privateBrowser.runBridgeAction('reports.search', { query }) as ReportHistoryPage;
        if (active) { setPage(result); setError(''); }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load report history.');
      }
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, revision, localRevision, projectId]);

  const updateQuery = (patch: Partial<ReportHistoryQuery>) => setQuery((current) => ({ ...current, page: 1, ...patch }));
  const open = (row: ReportHistoryRow) => {
    void window.privateBrowser.runBridgeAction('reports.open', { reportId: row.id }).catch(() => onToast('Could not open the report in VS Code.', 'error'));
  };
  const remove = (row: ReportHistoryRow) => {
    void window.privateBrowser.runBridgeAction('reports.delete', { reportId: row.id })
      .then(() => setLocalRevision((value) => value + 1), () => onToast('Could not delete the selected report.', 'error'));
  };
  const copy = () => {
    void window.privateBrowser.copyText(exportText).then(() => {
      setExportText('');
      onToast('Sanitized report copied');
    }, () => onToast('Could not copy the report.', 'error'));
  };

  return <section className="developer-report-history" aria-labelledby="developer-report-history-heading">
    <h3 id="developer-report-history-heading">Report history</h3>
    <div className="developer-report-filters">
      <label>Search title or route<input type="search" value={query.text ?? ''} maxLength={160} onChange={(event) => updateQuery({ text: event.target.value || undefined })} /></label>
      <label>Project<select aria-label="Project" value={query.project ?? ''} onChange={(event) => updateQuery({ project: event.target.value || undefined })}>
        <option value="">All approved projects</option>
        {page?.projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
      </select></label>
      <label>Report date<input type="date" value={query.date ?? ''} onChange={(event) => updateQuery({ date: event.target.value || undefined })} /></label>
      <label>Result<select aria-label="Result" value={query.status ?? ''} onChange={(event) => updateQuery({ status: (event.target.value || undefined) as ReportHistoryQuery['status'] })}>
        <option value="">All results</option>
        {Object.entries(resultLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}
      </select></label>
    </div>
    {error && <p role="alert">{error}</p>}
    {!error && <p role="status">{page ? `${page.total} ${page.total === 1 ? 'report' : 'reports'}` : 'Reading local reports…'}</p>}
    {!error && page?.rows.map((row) => <article key={row.id} aria-label={row.title} className="report-history-row">
      <h4>{row.title}</h4>
      <p>{row.projectName} · {resultLabels[row.status]} · <time dateTime={row.finishedAt}>{new Date(row.finishedAt).toLocaleDateString('en', { timeZone: 'UTC' })}</time></p>
      {row.route && <p>{row.route}</p>}
      <div className="bridge-action-row">
        <button type="button" onClick={() => open(row)}>Open in VS Code</button>
        <button type="button" disabled={busy || !row.replayable || row.projectId !== projectId}
          title={row.projectId !== projectId ? 'Select this project first' : !row.replayable ? 'Start a new test to save its parameters' : undefined}
          onClick={() => onReplay(row.id)}>Rerun with saved settings</button>
        <button type="button" onClick={() => setExportText(developerReportExport(row))}>Review export</button>
        <button type="button" onClick={() => remove(row)}>Delete report</button>
      </div>
    </article>)}
    {page && page.pages > 1 && <div className="bridge-action-row">
      <button type="button" disabled={page.page <= 1} onClick={() => updateQuery({ page: page.page - 1 })}>Previous reports</button>
      <span>{page.page} of {page.pages}</span>
      <button type="button" disabled={page.page >= page.pages} onClick={() => updateQuery({ page: page.page + 1 })}>Next reports</button>
    </div>}
    {exportText && <section className="report-export" aria-labelledby="report-export-heading">
      <h4 id="report-export-heading">Sanitized export</h4>
      <pre>{exportText}</pre>
      <div className="bridge-action-row">
        <button type="button" onClick={() => setExportText('')}>Cancel export</button>
        <button type="button" className="primary-button" onClick={copy}>Copy JSON</button>
      </div>
    </section>}
  </section>;
}
