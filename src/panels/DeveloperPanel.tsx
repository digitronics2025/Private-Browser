import { lazy, Suspense, useEffect, useState } from 'react';
import { Code2, Copy, FileCode2, LoaderCircle, LockKeyhole, PanelRightClose, PanelRightOpen, Play, ScanSearch, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { BridgePairingGuide } from './BridgePairingGuide';
import { DevelopmentServer } from './DevelopmentServer';
import { DeveloperReportHistory } from './DeveloperReportHistory';
import { DeveloperTestScenario } from './DeveloperTestScenario';
import type { AiPagePreview, BridgeStatus, BrowserTab, DeveloperPageInfo, DevToolsMode, GitRevision, ProjectInfo, ProjectSummary, TestKind, TestReport } from '../../electron/types';
import { PanelHeader } from './common';
import { ControlCenterSection } from './ControlCenterSection';
import { SafeDiagnostics } from './SafeDiagnostics';

const DeveloperPatchReview = lazy(() => import('./DeveloperPatchReview'));

function ProjectRevision({ onOpen, projectId }: { onOpen: (url: string) => void; projectId: string }) {
  const [revision, setRevision] = useState<GitRevision | null>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setRevision(undefined);
    setError(undefined);
    void window.privateBrowser.runBridgeAction('project.revision', {}).then((result) => {
      if (active) setRevision(result as GitRevision | null);
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : 'Git revision is unavailable.');
    });
    return () => { active = false; };
  }, [projectId, attempt]);

  const github = revision?.githubRepository && revision.commit
    ? 'https://github.com/' + revision.githubRepository + '/commit/' + revision.commit : undefined;
  const pullRequests = revision?.githubRepository && revision.commit
    ? 'https://github.com/' + revision.githubRepository + '/pulls?q=' + encodeURIComponent('is:pr ' + revision.commit) : undefined;
  const hasChanges = revision && revision.staged + revision.unstaged + revision.untracked + revision.conflicts > 0;

  return <section className="project-summary git-revision" aria-label="Git revision">
    <div><strong>Git revision</strong></div>
    <button onClick={() => setAttempt((value) => value + 1)} disabled={revision === undefined && !error}>Refresh</button>
    {revision ? <>
      <p>{revision.branch ?? (revision.commit ? 'Detached HEAD' : 'Branch unavailable')}</p>
      <p><code>{revision.commit ?? 'No commit yet'}</code></p>
      <p>{hasChanges
        ? `${revision.staged} staged · ${revision.unstaged} unstaged · ${revision.untracked} untracked · ${revision.conflicts} conflicts`
        : 'Clean working tree'}</p>
      {github && pullRequests && <div className="bridge-action-row">
        <button onClick={() => onOpen(github)}>Open commit</button>
        <button onClick={() => onOpen(pullRequests)}>Find pull requests</button>
      </div>}
    </> : <p role="status">{error ?? (revision === null
      ? 'Git status is unavailable. Check that Source Control in VS Code shows the approved workspace root.'
      : 'Reading Git status from VS Code…')}</p>}
  </section>;
}

export function DeveloperPanel({ activeTab, onToast }: { activeTab: BrowserTab; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [tab, setTab] = useState<'project' | 'inspect' | 'test' | 'ai' | 'center'>('project');
  const [mode, setMode] = useState<DevToolsMode>('right');
  const [bridge, setBridge] = useState<BridgeStatus>({ state: 'disconnected', browserVersion: '0.4.0' });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [inspection, setInspection] = useState<DeveloperPageInfo | null>(null);
  const [report, setReport] = useState<TestReport | null>(null);
  const [showReportHistory, setShowReportHistory] = useState(false);
  const [testProject, setTestProject] = useState<string>();
  const [reportHistoryRevision, setReportHistoryRevision] = useState(0);
  const [aiPreview, setAiPreview] = useState<AiPagePreview | null>(null);
  const [aiAnswer, setAiAnswer] = useState('');
  const [includeDom, setIncludeDom] = useState(false);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [liveUrl, setLiveUrl] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [retentionMax, setRetentionMax] = useState(100);
  const [loading, setLoading] = useState(false);
  const [bridgeMajor, bridgeMinor, bridgePatch] = (bridge.extensionVersion ?? '').split('.').map(Number);
  const canRecord = bridgeMajor > 0 || bridgeMinor > 4 || (bridgeMinor === 4 && bridgePatch >= 7);
  const recordedFlow = report?.kind === 'record-flow' ? report.findings.find(({ title }) => title === 'Recorded flow') : undefined;

  const refresh = async () => {
    const next = await window.privateBrowser.getBridgeStatus();
    setBridge(next);
    setProject(next.state === 'connected' ? next.project ?? null : null);
    if (next.state === 'connected' && activeTab.workspaceId === 'development') setProjects(await window.privateBrowser.listBridgeProjects());
  };

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [activeTab.workspaceId]);
  useEffect(() => { setInspection(null); }, [activeTab.id, activeTab.url, project?.project.id, bridge.instanceId]);
  useEffect(() => { setAiPreview(null); void window.privateBrowser.revokeAiContext().catch(() => undefined); }, [activeTab.id, activeTab.url]);
  useEffect(() => () => { void window.privateBrowser.revokeAiContext().catch(() => undefined); }, []);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setLoading(true);
    try { await action(); if (success) onToast(success); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };

  const bridgeAction = (action: Parameters<typeof window.privateBrowser.runBridgeAction>[0], payload: Record<string, unknown> = {}, success?: string) => run(async () => {
    let result: unknown;
    try { result = await window.privateBrowser.runBridgeAction(action, payload); }
    catch (error) {
      if ((action === 'test.run' || action === 'test.rerun') && error instanceof Error && error.message.endsWith('Test stopped')) return;
      throw error;
    }
    if (action === 'test.run' || action === 'test.rerun') {
      const completed = result as TestReport;
      const current = await window.privateBrowser.getBridgeStatus();
      if (current.project?.project.id === completed.projectId) setReport(completed);
      setReportHistoryRevision((value) => value + 1);
    }
    await refresh();
  }, success);

  useEffect(() => { setReport(null); }, [project?.project.id]);

  const runTest = async (action: 'test.run' | 'test.rerun', input: Record<string, unknown>) => {
    if (!project || testProject) return;
    setTestProject(project.project.id);
    try { await bridgeAction(action, input); }
    finally { setTestProject(undefined); }
  };

  const stopTest = () => {
    void window.privateBrowser.runBridgeAction('test.cancel').then((value) => {
      if ((value as { stopped?: boolean }).stopped) onToast('Test stopped');
    }, (error: unknown) => onToast(error instanceof Error ? error.message : 'Could not stop the test.', 'error'));
  };

  const selectProject = (projectId: string) => run(async () => {
    const next = await window.privateBrowser.selectBridgeProject(projectId);
    setProject(next);
    await refresh();
  }, 'Workspace approved in VS Code');

  const inspect = (pick: boolean) => run(async () => {
    const page = await window.privateBrowser.inspectDeveloperPage(pick);
    setInspection(page);
  }, pick ? 'Element selected locally' : 'Page inspected locally');

  const connected = bridge.state === 'connected';
  const askDeveloperAi = (question: string) => run(async () => {
    if (!aiPreview) return;
    const approval = await window.privateBrowser.approveAiPreview(aiPreview.id);
    setAiAnswer(await window.privateBrowser.askAi(approval.token, question));
    setAiPreview(null);
  });
  const tests: Array<{ kind: TestKind; label: string }> = [
    { kind: 'quick', label: 'Quick Test' }, { kind: 'everything', label: 'Test Everything' },
    { kind: 'current-page', label: 'Current Page' }, { kind: 'responsive', label: 'Responsive' },
    { kind: 'accessibility', label: 'Accessibility' }, { kind: 'performance', label: 'Performance' },
    { kind: 'record-flow', label: 'Record Flow' }, { kind: 'live-site', label: 'Live Website' }, { kind: 'compare', label: 'Local vs Live' },
  ];

  return <div className="side-panel developer-panel">
    <PanelHeader icon={Code2} eyebrow="Secure VS Code companion" title="Developer Bridge" />
    {activeTab.workspaceId !== 'development' ? <div className="developer-locked"><LockKeyhole size={24} /><h3>Protected by workspace policy</h3><p>Switch to Development. Bridge and AI capabilities never attach to Banking, payment, or other protected pages.</p></div> : <>
      <div className="bridge-status-card"><span className={connected ? 'live' : bridge.state === 'pairing' ? 'pairing' : ''} /><div><strong>{connected ? 'VS Code connected' : bridge.state === 'pairing' ? 'Waiting for VS Code' : 'VS Code disconnected'}</strong><small>Browser {bridge.browserVersion}{bridge.extensionVersion ? ` · Extension ${bridge.extensionVersion}` : ''}</small></div>{connected && <button onClick={() => void run(() => window.privateBrowser.disconnectBridge(false).then(setBridge), 'VS Code disconnected')}>Disconnect</button>}</div>
      {!connected && <SafeDiagnostics reason={bridge.state === 'incompatible' ? 'PB-BRIDGE-VERSION' : 'PB-BRIDGE-CONNECTION'} />}
      <div className="bridge-tabs" role="tablist" aria-label="Developer tools">{(['project', 'inspect', 'test', 'ai', 'center'] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item === 'ai' ? 'AI Fix' : item === 'center' ? 'Tasks' : item[0].toUpperCase() + item.slice(1)}</button>)}</div>

      {tab === 'project' && <div className="bridge-pane">
        <BridgePairingGuide bridge={bridge} busy={loading}
          onInstall={() => void run(async () => onToast(await window.privateBrowser.installBridgeExtension()))}
          onPair={() => void run(() => window.privateBrowser.beginBridgePairing().then(setBridge))}
          onCancel={() => void run(() => window.privateBrowser.cancelBridgePairing().then(setBridge))}
          onCheck={() => void run(refresh, 'VS Code connection checked')} />
        {connected && <>
        <label className="bridge-label">Workspace folder<select value={project?.project.id ?? ''} onChange={(event) => void selectProject(event.target.value)}><option value="">Choose a workspace</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}{item.trusted ? '' : ' (restricted)'}</option>)}</select></label>
        {!project && <SafeDiagnostics reason="PB-BRIDGE-PROJECT" />}
        {project && <div className="project-summary"><div><small>PROJECT</small><strong>{project.project.name}</strong><span>{project.framework} · {project.packageManager}</span></div><button onClick={() => void bridgeAction('project.open')}>Reveal</button><p>{project.types.join(' + ') || 'Generic project'}</p>{project.activeFile && <p>Editing: {project.activeFile}</p>}</div>}
        {project && <ProjectRevision key={project.project.id} projectId={project.project.id}
          onOpen={(url) => void run(() => window.privateBrowser.newTab('development', url))} />}
        {project && <DevelopmentServer key={'server-' + project.project.id} projectName={project.project.name} />}
        <button className="bridge-danger" onClick={() => void run(() => window.privateBrowser.disconnectBridge(true).then(setBridge), 'VS Code identity revoked')}>Revoke this VS Code</button>
      </>}</div>}

      {tab === 'inspect' && <div className="bridge-pane"><div className="developer-launch"><select value={mode} onChange={(event) => setMode(event.target.value as DevToolsMode)} aria-label="DevTools position"><option value="right">Dock right</option><option value="bottom">Dock bottom</option><option value="detach">Separate window</option></select><button className="primary-button" disabled={!activeTab.developerToolsAllowed || loading} onClick={() => void run(() => window.privateBrowser.toggleDeveloperTools(mode))}>{activeTab.developerToolsOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}{activeTab.developerToolsOpen ? 'Close tools' : 'Open DevTools'}</button></div>
        <div className="bridge-action-grid"><button disabled={!activeTab.developerToolsAllowed || loading} onClick={() => void inspect(false)}><FileCode2 size={15} />Inspect page</button><button disabled={!activeTab.developerToolsAllowed || loading} onClick={() => void inspect(true)}><ScanSearch size={15} />Select element</button></div>
        {inspection ? <div className="inspection-result">
          <small>{inspection.framework} · {inspection.viewport}</small>
          <strong>{inspection.selector ?? inspection.route}</strong>
          {inspection.element && <span>Selected element <code>{inspection.element}</code></span>}
          <span>{inspection.confidence === 'exact' ? 'Confirmed source file' : inspection.confidence === 'nearest' ? 'Nearest editor match, source unconfirmed' : 'Source file unconfirmed'}</span>
          {inspection.confidence === 'exact' && inspection.sourceReference && inspection.sourcePath && <>
            <code>{inspection.sourcePath}</code>
            <button disabled={loading} onClick={() => void bridgeAction('inspect.open-source', { reference: inspection.sourceReference })}>Open source in VS Code</button>
          </>}
          {inspection.failures && <section aria-label="Recent request failures">
            <h3>Recent request failures</h3>
            {inspection.failures.length ? <ul className="inspection-failures">{inspection.failures.map((issue) => <li
              key={JSON.stringify([issue.method, issue.url, issue.status, issue.error, issue.resourceType])}>
              <code>{issue.method} {issue.url}</code>
              <small>{issue.status ? 'HTTP ' + issue.status : issue.error || 'Request failed'} · {issue.count ?? 1} {(issue.count ?? 1) === 1 ? 'occurrence' : 'occurrences'}</small>
              <small>First {new Date(issue.firstAt ?? issue.at).toLocaleString()} · Last {new Date(issue.at).toLocaleString()}</small>
            </li>)}</ul> : <p>No request failures captured for this tab.</p>}
          </section>}
        </div> : <div className="developer-tip"><ScanSearch size={16} /><p>Pick an element on the current development page. Only bounded structure and source hints cross the authenticated bridge.</p></div>}
      </div>}

      {tab === 'test' && <div className="bridge-pane">
        {connected && project && (() => {
          const [major, minor, patch] = (bridge.extensionVersion ?? '').split('.').map(Number);
          return (major > 0 || minor > 4 || (minor === 4 && patch >= 5)) && <DeveloperTestScenario
            key={project.project.id} projectId={project.project.id} projectUrl={project.devServerUrl} activeUrl={activeTab.url}
            disabled={loading || Boolean(testProject)} run={(input) => void runTest('test.run', input)} />;
        })()}
        <label className="bridge-label">Optional approved live URL<input value={liveUrl} onChange={(event) => setLiveUrl(event.target.value)} placeholder="https://staging.example.com" /></label>
        <div className="bridge-action-grid test-grid">
          {tests.map((item) => <button key={item.kind}
            disabled={!connected || !project || loading || Boolean(testProject) || (item.kind === 'record-flow' && !canRecord)
              || ((item.kind === 'live-site' || item.kind === 'compare') && !liveUrl)}
            title={item.kind === 'record-flow' ? canRecord ? 'Record a local synthetic fixture' : 'Requires Private Browser Bridge 0.4.7' : undefined}
            onClick={() => void runTest('test.run', { kind: item.kind, url: item.kind === 'live-site' ? liveUrl : activeTab.url,
              ...(liveUrl && (item.kind === 'live-site' || item.kind === 'compare') ? { liveUrl } : {}) })}><Play size={14} />{item.label}</button>)}
        </div>
        <div className="bridge-action-row">
          <button disabled={!report || Boolean(testProject)} onClick={() => report && void runTest('test.rerun', { reportId: report.id })}>Rerun latest</button>
          <button disabled={!project} onClick={() => setShowReportHistory((value) => !value)}>{showReportHistory ? 'Hide report history' : 'Report history'}</button>
          <button disabled={!testProject || testProject !== project?.project.id} onClick={stopTest}>Stop test</button>
        </div>
        {report && <div className={`test-result ${report.status}`}>
          <small>{report.status === 'attention' ? 'Needs attention' : report.status}</small><strong>{report.title}</strong>
          <p>{report.summary}</p><span>{report.findings.length} findings · {report.artifacts.length} artifacts</span>
          {recordedFlow && <details><summary>{recordedFlow.cause}</summary><pre>{recordedFlow.evidence}</pre></details>}
          <button onClick={() => void bridgeAction('reports.open', { reportId: report.id })}>Open in VS Code</button>
          {report.artifacts.filter((item) => item.kind === 'test').map((item) => <button key={item.id}
            onClick={() => void bridgeAction('test.save-artifact', { reportId: report.id, name: item.name, path: 'tests/e2e/private-browser-recorded.spec.ts' },
              'Generated test saved after VS Code approval')}>Review and save generated test…</button>)}
        </div>}
        {showReportHistory && project && <>
          <DeveloperReportHistory key={project.project.id} projectId={project.project.id} revision={reportHistoryRevision}
            busy={Boolean(testProject)} onReplay={(reportId) => void runTest('test.rerun', { reportId })} onToast={onToast} />
          <details><summary>Report storage</summary>
            <div className="report-controls">
              <label>Keep for days<input type="number" min="1" max="365" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /></label>
              <label>Maximum reports<input type="number" min="10" max="500" value={retentionMax} onChange={(event) => setRetentionMax(Number(event.target.value))} /></label>
              <button onClick={() => void bridgeAction('reports.retention', { days: retentionDays, max: retentionMax }, 'Report retention updated').then(() => setReportHistoryRevision((value) => value + 1))}>Save retention</button>
              <button onClick={() => {
                if (window.confirm('Clear all local test reports and their saved settings?')) {
                  void bridgeAction('reports.clear', {}, 'Local reports cleared').then(() => {
                    setReport(null);
                    setReportHistoryRevision((value) => value + 1);
                  });
                }
              }}>Clear all reports</button>
            </div>
          </details>
        </>}
      </div>}

      {tab === 'ai' && <div className="bridge-pane"><div className="ai-privacy-note"><ShieldCheck size={16} /><p><strong>You control every upload.</strong> Cookies, storage, form values, headers, bodies, URL queries, secrets, and protected pages are always excluded.</p></div><label className="bridge-check"><input type="checkbox" checked={includeDom} onChange={(event) => setIncludeDom(event.target.checked)} /> Include structural DOM metadata</label><label className="bridge-check"><input type="checkbox" checked={includeScreenshot} onChange={(event) => setIncludeScreenshot(event.target.checked)} /> Include a compressed screenshot</label><button className="primary-button full" disabled={!activeTab.developerToolsAllowed || loading} onClick={() => void run(async () => { setAiAnswer(''); setAiPreview(await window.privateBrowser.prepareDeveloperAiPreview({ includeDom, includeScreenshot })); }, 'Sanitized AI context is ready for review')}><Sparkles size={14} /> Preview debugging context</button>
        {aiPreview && <div className="ai-context-preview"><div><small>EXACT CONTEXT · {aiPreview.redactions} REDACTIONS</small><button onClick={() => void window.privateBrowser.revokeAiContext().then(() => setAiPreview(null))}>Clear</button></div>{aiPreview.screenshotDataUrl && <img src={aiPreview.screenshotDataUrl} alt="Approved page screenshot preview" />}<pre>{aiPreview.text}</pre>{aiPreview.dom && <details><summary>Structural DOM</summary><pre>{aiPreview.dom}</pre></details>}<div className="bridge-action-row"><button onClick={() => void askDeveloperAi('Explain the observed page and diagnostic evidence.')}>Explain</button><button onClick={() => void askDeveloperAi('Diagnose the most likely root cause and recommend a minimal fix.')}>Diagnose</button></div><div className="bridge-action-row"><button onClick={() => void window.privateBrowser.copyText(aiPreview.text).then(() => onToast('Context copied')).catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'))}><Copy size={13} />Copy</button><button className="primary-button" disabled={!connected || !project} onClick={() => void run(async () => { const approval = await window.privateBrowser.approveAiPreview(aiPreview.id); await window.privateBrowser.runBridgeAction('ai.handoff', { approvalToken: approval.token, action: 'Diagnose and propose a fix' }); setAiPreview(null); }, 'Opened secure handoff in VS Code')}>Fix in VS Code</button></div></div>}
        {aiAnswer && <div className="ai-answer"><Sparkles size={14} /><p>{aiAnswer}</p><button onClick={() => setAiAnswer('')}>Clear answer</button></div>}
        {connected && project && <Suspense fallback={null}><DeveloperPatchReview key={project.project.id}
          report={report?.projectId === project.project.id && report.kind !== 'live-site' ? report : undefined}
          onReport={(value) => { setReport(value); setReportHistoryRevision((revision) => revision + 1); }} onToast={onToast} /></Suspense>}
      </div>}
      {tab === 'center' && <ControlCenterSection activeTab={activeTab} onToast={onToast} />}
      {loading && <div className="bridge-working"><LoaderCircle size={13} /> Working locally…</div>}{bridge.error && <div className="bridge-error"><TriangleAlert size={14} />{bridge.error}</div>}
    </>}
  </div>;
}
