import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCcw, Send, ShieldCheck } from 'lucide-react';
import type { AiPagePreview, BrowserTab, ControlCenterRepository, ControlCenterStatus, ControlCenterTask } from '../../electron/types';

/**
 * Developer panel → Control Center (docs/systems/control-center-link.md).
 * Report the current development page as a task in the AI Development
 * Control Center on this computer, follow the tasks sent from here, and
 * attach a re-check once one has run. Each send is one approval of the exact
 * context shown; the Control Center can never ask the browser for anything.
 */

const DONE = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_FOR_USER']);

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', QUEUED: 'Queued', RUNNING: 'Running', PAUSED: 'Paused', WAITING_FOR_USER: 'Needs you', WAITING_FOR_USAGE_RESET: 'Waiting for usage',
  FAILED: 'Failed', CANCELLED: 'Cancelled', COMPLETED: 'Completed', INTERRUPTED: 'Interrupted',
};

async function waitForLoad(tabId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  // Give the reload a moment to start before watching for it to finish.
  await new Promise((resolve) => setTimeout(resolve, 300));
  while (Date.now() < deadline) {
    const state = await window.privateBrowser.getState();
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab || !tab.loading) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function ControlCenterSection({ activeTab, onToast }: { activeTab: BrowserTab; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const [status, setStatus] = useState<ControlCenterStatus | null>(null);
  const [code, setCode] = useState('');
  const [repositories, setRepositories] = useState<ControlCenterRepository[]>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [note, setNote] = useState('');
  const [includeDom, setIncludeDom] = useState(false);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [preview, setPreview] = useState<AiPagePreview | null>(null);
  /** The task a preview re-checks; null when the preview reports a new problem. */
  const [recheckFor, setRecheckFor] = useState<ControlCenterTask | null>(null);
  const [tasks, setTasks] = useState<ControlCenterTask[]>([]);
  const [busy, setBusy] = useState(false);

  const connected = status?.state === 'connected';

  const run = async (action: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    try { await action(); if (success) onToast(success); }
    catch (error) { onToast(error instanceof Error ? error.message : String(error), 'error'); }
    finally { setBusy(false); }
  };

  const refresh = async () => {
    const next = await window.privateBrowser.getControlCenterStatus();
    setStatus(next);
    if (next.state === 'connected') setTasks(await window.privateBrowser.listControlCenterTasks());
  };

  useEffect(() => {
    void refresh().catch(() => undefined);
    // Poll only while this section is on screen.
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!connected) return;
    void window.privateBrowser.listControlCenterRepositories().then((result) => {
      setRepositories(result.repositories);
      setRepositoryId((current) => current || result.suggestedId || '');
    }).catch(() => undefined);
  }, [connected, activeTab.url]);

  // A new page or tab invalidates a preview the operator has not sent yet.
  useEffect(() => { setPreview(null); setRecheckFor(null); }, [activeTab.id, activeTab.url]);

  const capture = () => run(async () => {
    setPreview(await window.privateBrowser.prepareDeveloperAiPreview({ includeDom, includeScreenshot }));
  }, 'Review exactly what will be sent');

  const send = () => run(async () => {
    if (!preview) return;
    const approval = await window.privateBrowser.approveAiPreview(preview.id);
    if (recheckFor) {
      const result = await window.privateBrowser.recheckControlCenterTask({ approvalToken: approval.token, taskId: recheckFor.id });
      onToast(`Re-check attached to ${recheckFor.id} (${result.name})`);
    } else {
      const task = await window.privateBrowser.sendToControlCenter({ approvalToken: approval.token, repositoryId, note });
      setNote('');
      onToast(`Sent as ${task.id}`);
    }
    setPreview(null);
    setRecheckFor(null);
    await refresh();
  });

  const checkAgain = (task: ControlCenterTask) => run(async () => {
    // The tab keeps console and network entries across reloads; a re-check must
    // show only what the page does now, so the old entries go first.
    await window.privateBrowser.clearDeveloperDiagnostics();
    await window.privateBrowser.reload();
    await waitForLoad(activeTab.id);
    setRecheckFor(task);
    setPreview(await window.privateBrowser.prepareDeveloperAiPreview({ includeDom: false, includeScreenshot: false }));
  }, 'Page reloaded — review the fresh evidence');

  if (!status) return <div className="bridge-pane"><div className="developer-tip"><ShieldCheck size={16} /><p>Looking for the Control Center on this computer…</p></div></div>;

  return <div className="bridge-pane control-center-pane">
    <div className="bridge-status-card">
      <span className={connected ? 'live' : ''} />
      <div>
        <strong>{connected ? 'Control Center connected' : status.state === 'not-paired' ? 'Control Center not paired' : status.state === 'identity-changed' ? 'Control Center key changed' : status.state === 'unreachable' ? 'Control Center not running' : 'Control Center unavailable'}</strong>
        <small>{status.fingerprint ? `Key ${status.fingerprint}` : status.url}</small>
      </div>
      {status.state !== 'not-paired' && <button onClick={() => void run(async () => setStatus(await window.privateBrowser.disconnectControlCenter()), 'Control Center link removed')}>Disconnect</button>}
    </div>
    {status.detail && <p className="control-center-detail" role="status">{status.detail}</p>}

    {status.state === 'not-paired' && <div className="project-summary control-center-pair">
      <div><small>PAIR</small><strong>Pair with the Control Center</strong><span>In the Control Center open Tools → Connected apps → Pair Private Browser, then type the eight-digit code here. Continue only if the key it shows matches the key shown here after pairing.</span></div>
      <label className="bridge-label">Pairing code<input value={code} inputMode="numeric" autoComplete="off" maxLength={9} onChange={(event) => setCode(event.target.value.replace(/[^\d]/g, '').slice(0, 8))} placeholder="12345678" /></label>
      <button className="primary-button" disabled={code.length !== 8 || busy} onClick={() => void run(async () => { setStatus(await window.privateBrowser.pairControlCenter(code)); setCode(''); await refresh(); }, 'Paired — compare the key with the Control Center')}>Pair</button>
    </div>}

    {connected && <>
      {!preview && <>
        <label className="bridge-label">Repository<select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}><option value="">Choose a repository</option>{repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.name}</option>)}</select></label>
        <label className="bridge-label">What should be fixed<textarea value={note} maxLength={2000} rows={3} onChange={(event) => setNote(event.target.value)} placeholder="The cart page crashes when it is empty" /></label>
        <label className="bridge-check"><input type="checkbox" checked={includeDom} onChange={(event) => setIncludeDom(event.target.checked)} /> Include structural DOM metadata</label>
        <label className="bridge-check"><input type="checkbox" checked={includeScreenshot} onChange={(event) => setIncludeScreenshot(event.target.checked)} /> Include a compressed screenshot</label>
        <button className="primary-button full" disabled={!activeTab.developerToolsAllowed || !repositoryId || !note.trim() || busy} onClick={() => void capture()}><Send size={14} /> Preview what will be sent</button>
      </>}

      {preview && <div className="ai-context-preview">
        <div><small>{recheckFor ? `RE-CHECK FOR ${recheckFor.id}` : 'EXACT CONTEXT'} · {preview.redactions} REDACTIONS</small><button onClick={() => void window.privateBrowser.revokeAiContext().then(() => { setPreview(null); setRecheckFor(null); })}>Cancel</button></div>
        {preview.screenshotDataUrl && <img src={preview.screenshotDataUrl} alt="Screenshot that will be sent" />}
        <pre>{preview.text}</pre>
        {preview.dom && <details><summary>Structural DOM</summary><pre>{preview.dom}</pre></details>}
        <p className="control-center-detail">It goes only to the Control Center on this computer, as untrusted evidence for its agents. One approval sends it once.</p>
        <div className="bridge-action-row"><button className="primary-button" disabled={busy} onClick={() => void send()}><Send size={13} />{recheckFor ? `Attach to ${recheckFor.id}` : 'Send to Control Center'}</button></div>
      </div>}

      <div className="control-center-tasks" aria-label="Tasks sent from this browser">
        <small className="control-center-heading">SENT FROM THIS BROWSER</small>
        {tasks.length === 0 ? <p className="control-center-detail">Nothing sent yet.</p> : tasks.slice(0, 6).map((task) => <div className="report-row control-center-task" key={task.id}>
          <span className={DONE.has(task.status) ? (task.status === 'COMPLETED' ? 'passed' : 'failed') : 'running'} />
          <div><strong>{task.id} · {task.title}</strong><small>{STATUS_LABEL[task.status] ?? task.status}{task.currentStageName && !DONE.has(task.status) ? ` · ${task.currentStageName}` : ''}{task.finalStatus ? ` · ${task.finalStatus === 'READY' ? 'Ready' : 'Needs your action'}` : ''}{task.blocker ? ` · ${task.blocker}` : ''}</small></div>
          <button aria-label={`Open ${task.id} in the Control Center`} onClick={() => void window.privateBrowser.newTab('development', task.dashboardUrl)}><ExternalLink size={12} /></button>
          {DONE.has(task.status) && <button disabled={busy || !activeTab.developerToolsAllowed} onClick={() => void checkAgain(task)}><RefreshCcw size={12} />Check again</button>}
        </div>)}
      </div>
    </>}
  </div>;
}
