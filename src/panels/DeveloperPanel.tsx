import { useEffect, useState } from 'react';
import { Code2, Copy, FileCode2, LoaderCircle, LockKeyhole, PanelRightClose, PanelRightOpen, Play, ScanSearch, ShieldCheck, Sparkles, Trash2, TriangleAlert } from 'lucide-react';
import type { AiPagePreview, BridgeStatus, BrowserTab, DeveloperPageInfo, DevToolsMode, ProjectInfo, ProjectSummary, TestKind, TestReport } from '../../electron/types';
import { PanelHeader } from './common';
import { ControlCenterSection } from './ControlCenterSection';

export function DeveloperPanel({ activeTab, onToast }: { activeTab: BrowserTab; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [tab, setTab] = useState<'project' | 'inspect' | 'test' | 'ai' | 'center'>('project');
  const [mode, setMode] = useState<DevToolsMode>('right');
  const [bridge, setBridge] = useState<BridgeStatus>({ state: 'disconnected', browserVersion: '0.4.0' });
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [inspection, setInspection] = useState<DeveloperPageInfo | null>(null);
  const [report, setReport] = useState<TestReport | null>(null);
  const [reports, setReports] = useState<TestReport[]>([]);
  const [aiPreview, setAiPreview] = useState<AiPagePreview | null>(null);
  const [aiAnswer, setAiAnswer] = useState('');
  const [includeDom, setIncludeDom] = useState(false);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [liveUrl, setLiveUrl] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [retentionMax, setRetentionMax] = useState(100);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    const next = await window.privateBrowser.getBridgeStatus();
    setBridge(next);
    if (next.project) setProject(next.project);
    if (next.state === 'connected' && activeTab.workspaceId === 'development') setProjects(await window.privateBrowser.listBridgeProjects());
  };

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3000);
    return () => window.clearInterval(timer);
  }, [activeTab.workspaceId]);
  useEffect(() => { setInspection(null); setAiPreview(null); void window.privateBrowser.revokeAiContext().catch(() => undefined); }, [activeTab.id, activeTab.url]);
  useEffect(() => () => { void window.privateBrowser.revokeAiContext().catch(() => undefined); }, []);

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setLoading(true);
    try { await action(); if (success) onToast(success); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setLoading(false); }
  };

  const bridgeAction = (action: Parameters<typeof window.privateBrowser.runBridgeAction>[0], payload: Record<string, unknown> = {}, success?: string) => run(async () => {
    const result = await window.privateBrowser.runBridgeAction(action, payload);
    if (action === 'test.run' || action === 'test.rerun') setReport(result as TestReport);
    if (action === 'reports.list') setReports(result as TestReport[]);
    await refresh();
  }, success);

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
      <div className="bridge-status-card"><span className={connected ? 'live' : bridge.state === 'pairing' ? 'pairing' : ''} /><div><strong>{connected ? 'VS Code connected' : bridge.state === 'pairing' ? `Pair with ${bridge.pairingCode}` : 'VS Code disconnected'}</strong><small>Browser {bridge.browserVersion}{bridge.extensionVersion ? ` · Extension ${bridge.extensionVersion}` : ''}</small></div>{connected ? <button onClick={() => void run(() => window.privateBrowser.disconnectBridge(false).then(setBridge), 'VS Code disconnected')}>Disconnect</button> : <button onClick={() => void run(() => window.privateBrowser.beginBridgePairing().then(setBridge))}>Pair</button>}</div>
      <div className="bridge-tabs" role="tablist" aria-label="Developer tools">{(['project', 'inspect', 'test', 'ai', 'center'] as const).map((item) => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item === 'ai' ? 'AI Fix' : item === 'center' ? 'Tasks' : item[0].toUpperCase() + item.slice(1)}</button>)}</div>

      {tab === 'project' && <div className="bridge-pane">{!connected ? <div className="bridge-empty"><Code2 size={26} /><strong>Connect your local editor</strong><p>Install the bundled private extension, then enter the single-use code in VS Code. No TCP port or webpage bridge is opened.</p><button className="primary-button" onClick={() => void run(async () => onToast(await window.privateBrowser.installBridgeExtension()))}>Install VS Code extension</button></div> : <>
        <label className="bridge-label">Workspace folder<select value={project?.project.id ?? ''} onChange={(event) => void selectProject(event.target.value)}><option value="">Choose a workspace</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}{item.trusted ? '' : ' (restricted)'}</option>)}</select></label>
        {project && <div className="project-summary"><div><small>PROJECT</small><strong>{project.project.name}</strong><span>{project.framework} · {project.packageManager}</span></div><button onClick={() => void bridgeAction('project.open')}>Reveal</button><p>{project.types.join(' + ') || 'Generic project'}</p>{project.activeFile && <p>Editing: {project.activeFile}</p>}</div>}
        <div className="bridge-action-row"><button className="primary-button" disabled={!project || loading} onClick={() => void bridgeAction('server.start', {}, 'Development server started')}>Start server</button><button disabled={!project || loading} onClick={() => void bridgeAction('server.restart', {}, 'Server restarted')}>Restart</button><button disabled={!project || loading} onClick={() => void bridgeAction('server.stop', {}, 'Server stopped')}>Stop</button></div>
        <button className="bridge-danger" onClick={() => void run(() => window.privateBrowser.disconnectBridge(true).then(setBridge), 'VS Code identity revoked')}>Revoke this VS Code</button>
      </>}</div>}

      {tab === 'inspect' && <div className="bridge-pane"><div className="developer-launch"><select value={mode} onChange={(event) => setMode(event.target.value as DevToolsMode)} aria-label="DevTools position"><option value="right">Dock right</option><option value="bottom">Dock bottom</option><option value="detach">Separate window</option></select><button className="primary-button" disabled={!activeTab.developerToolsAllowed || loading} onClick={() => void run(() => window.privateBrowser.toggleDeveloperTools(mode))}>{activeTab.developerToolsOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}{activeTab.developerToolsOpen ? 'Close tools' : 'Open DevTools'}</button></div>
        <div className="bridge-action-grid"><button disabled={!activeTab.developerToolsAllowed} onClick={() => void inspect(false)}><FileCode2 size={15} />Inspect page</button><button disabled={!activeTab.developerToolsAllowed} onClick={() => void inspect(true)}><ScanSearch size={15} />Select element</button></div>
        {inspection ? <div className="inspection-result"><small>{inspection.framework} · {inspection.viewport}</small><strong>{inspection.selector ?? inspection.route}</strong><span>{inspection.confidence ? `${inspection.confidence} source match` : 'Page metadata only'}</span>{(inspection.sourcePath || project?.activeFile) && <button onClick={() => void bridgeAction('source.open', { path: inspection.sourcePath ?? project?.activeFile, line: 1 })}>Open {inspection.confidence ?? 'nearest'} location in VS Code</button>}</div> : <div className="developer-tip"><ScanSearch size={16} /><p>Pick an element on the current development page. Only bounded structure and source hints cross the authenticated bridge.</p></div>}
      </div>}

      {tab === 'test' && <div className="bridge-pane"><label className="bridge-label">Optional approved live URL<input value={liveUrl} onChange={(event) => setLiveUrl(event.target.value)} placeholder="https://staging.example.com" /></label><div className="bridge-action-grid test-grid">{tests.map((item) => <button key={item.kind} disabled={!connected || !project || loading || ((item.kind === 'live-site' || item.kind === 'compare') && !liveUrl)} onClick={() => void bridgeAction('test.run', { kind: item.kind, url: item.kind === 'live-site' ? liveUrl : activeTab.url, ...(liveUrl ? { liveUrl } : {}) })}><Play size={14} />{item.label}</button>)}</div><div className="bridge-action-row"><button disabled={!report} onClick={() => void bridgeAction('test.rerun')}>Re-run</button><button onClick={() => void bridgeAction('reports.list')}>Results</button><button disabled={!project} onClick={() => void bridgeAction('test.cancel')}>Cancel</button></div>
        {report && <div className={`test-result ${report.status}`}><small>{report.status === 'attention' ? 'Needs attention' : report.status}</small><strong>{report.title}</strong><p>{report.summary}</p><span>{report.findings.length} findings · {report.artifacts.length} artifacts</span><button onClick={() => void bridgeAction('reports.open', { reportId: report.id })}>Open in VS Code</button>{report.artifacts.filter((item) => item.kind === 'test').map((item) => <button key={item.id} onClick={() => void bridgeAction('test.save-artifact', { reportId: report.id, name: item.name, path: 'tests/e2e/private-browser-recorded.spec.ts' }, 'Generated test saved after VS Code approval')}>Save generated test…</button>)}</div>}
        {reports.length > 0 && <div className="report-controls"><label>Days<input type="number" min="1" max="365" value={retentionDays} onChange={(event) => setRetentionDays(Number(event.target.value))} /></label><label>Max<input type="number" min="10" max="500" value={retentionMax} onChange={(event) => setRetentionMax(Number(event.target.value))} /></label><button onClick={() => void bridgeAction('reports.retention', { days: retentionDays, max: retentionMax }, 'Report retention updated')}>Save</button><button onClick={() => void bridgeAction('reports.clear', {}, 'Local reports cleared').then(() => setReports([]))}>Clear</button></div>}
        {reports.slice(0, 4).map((item) => <div className="report-row" key={item.id}><span className={item.status} /><button onClick={() => { setReport(item); void bridgeAction('reports.open', { reportId: item.id }); }}>{item.title}</button><small>{new Date(item.finishedAt).toLocaleDateString()}</small><button aria-label={`Delete ${item.title}`} onClick={() => void bridgeAction('reports.delete', { reportId: item.id }).then(() => setReports((current) => current.filter((entry) => entry.id !== item.id)))}><Trash2 size={12} /></button></div>)}
      </div>}

      {tab === 'ai' && <div className="bridge-pane"><div className="ai-privacy-note"><ShieldCheck size={16} /><p><strong>You control every upload.</strong> Cookies, storage, form values, headers, bodies, URL queries, secrets, and protected pages are always excluded.</p></div><label className="bridge-check"><input type="checkbox" checked={includeDom} onChange={(event) => setIncludeDom(event.target.checked)} /> Include structural DOM metadata</label><label className="bridge-check"><input type="checkbox" checked={includeScreenshot} onChange={(event) => setIncludeScreenshot(event.target.checked)} /> Include a compressed screenshot</label><button className="primary-button full" disabled={!activeTab.developerToolsAllowed || loading} onClick={() => void run(async () => { setAiAnswer(''); setAiPreview(await window.privateBrowser.prepareDeveloperAiPreview({ includeDom, includeScreenshot })); }, 'Sanitized AI context is ready for review')}><Sparkles size={14} /> Preview debugging context</button>
        {aiPreview && <div className="ai-context-preview"><div><small>EXACT CONTEXT · {aiPreview.redactions} REDACTIONS</small><button onClick={() => void window.privateBrowser.revokeAiContext().then(() => setAiPreview(null))}>Clear</button></div>{aiPreview.screenshotDataUrl && <img src={aiPreview.screenshotDataUrl} alt="Approved page screenshot preview" />}<pre>{aiPreview.text}</pre>{aiPreview.dom && <details><summary>Structural DOM</summary><pre>{aiPreview.dom}</pre></details>}<div className="bridge-action-row"><button onClick={() => void askDeveloperAi('Explain the observed page and diagnostic evidence.')}>Explain</button><button onClick={() => void askDeveloperAi('Diagnose the most likely root cause and recommend a minimal fix.')}>Diagnose</button></div><div className="bridge-action-row"><button onClick={() => void window.privateBrowser.copyText(aiPreview.text).then(() => onToast('Context copied')).catch((error) => onToast(error instanceof Error ? error.message : String(error), 'error'))}><Copy size={13} />Copy</button><button className="primary-button" disabled={!connected || !project} onClick={() => void run(async () => { const approval = await window.privateBrowser.approveAiPreview(aiPreview.id); await window.privateBrowser.runBridgeAction('ai.handoff', { approvalToken: approval.token, action: 'Diagnose and propose a fix' }); setAiPreview(null); }, 'Opened secure handoff in VS Code')}>Fix in VS Code</button></div></div>}
        {aiAnswer && <div className="ai-answer"><Sparkles size={14} /><p>{aiAnswer}</p><button onClick={() => setAiAnswer('')}>Clear answer</button></div>}
      </div>}
      {tab === 'center' && <ControlCenterSection activeTab={activeTab} onToast={onToast} />}
      {loading && <div className="bridge-working"><LoaderCircle size={13} /> Working locally…</div>}{bridge.error && <div className="bridge-error"><TriangleAlert size={14} />{bridge.error}</div>}
    </>}
  </div>;
}
