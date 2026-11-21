import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Bot, Copy, ShieldCheck, Square } from 'lucide-react';
import type { AgentPolicy } from '../../electron/agent-policy';
import type { AgentDecision, AgentUiStatus } from '../../electron/agent-types';
import { PanelHeader } from './common';
import { disposer } from '../lib/subscribe';

export function useAgentStatus() {
  const [status, setStatus] = useState<AgentUiStatus>();
  useEffect(() => {
    const api = window.privateBrowser;
    if (typeof api?.getAgentStatus !== 'function' || typeof api.onAgentChanged !== 'function') return;
    let current = true;
    const refresh = () => { void api.getAgentStatus().then((value) => { if (current) setStatus(value); }).catch(() => undefined); };
    const unsubscribe = disposer(api.onAgentChanged(refresh));
    refresh();
    return () => { current = false; unsubscribe?.(); };
  }, []);
  return status;
}

export function AgentsPanel({ onBack, onToast }: { onBack: () => void; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const status = useAgentStatus();
  const [name, setName] = useState('');
  const [reset, setReset] = useState<string>();
  const [pending, setPending] = useState(false);
  const perform = async (action: () => Promise<void>) => {
    setPending(true);
    try { await action(); }
    catch (error) { onToast(error instanceof Error ? error.message : 'Private Browser could not complete the request.', 'error'); }
    finally { setPending(false); }
  };
  const api = window.privateBrowser;
  return <div className="side-panel agents-panel">
    <button className="updates-back" aria-label="Back to Settings" onClick={onBack}><ArrowLeft size={14} /> Settings</button>
    <PanelHeader icon={Bot} eyebrow="Private Browser" title="Agents" />
    {status ? <>
      <section className="agent-card">
        <label className="agent-switch"><input type="checkbox" checked={status.enabled} disabled={pending || Boolean(status.unavailable)}
          onChange={(event) => void perform(() => api.setAgentsEnabled(event.currentTarget.checked))} /> Allow coding agents</label>
        <p>Connect Claude Code or Codex to tabs in an isolated Agent Account Space.</p>
        {status.unavailable && <p role="alert">{status.unavailable}</p>}
        {status.enabled && <div className="agent-buttons">
          {status.paused
            ? <button disabled={pending} onClick={() => void perform(api.resumeAgents)}>Resume Agent Mode</button>
            : <button disabled={pending} onClick={() => void perform(api.beginAgentPairing)}>Generate pairing code</button>}
          <button disabled={pending} onClick={() => void perform(api.openAgentWorkspace)}>Open Agent Workspace</button>
          {status.active && <button className="agent-danger" onClick={() => void perform(api.stopAgents)}><Square size={13} /> Stop all agents</button>}
        </div>}
        {status.pairing && <div className="agent-pairing" role="status"><strong>Pairing code</strong><output>{status.pairing.code}</output><small>Single use. Expires at {new Date(status.pairing.expiresAt).toLocaleTimeString()}.</small></div>}
      </section>
      {status.enabled && <>
        <section className="agent-card">
          <h3>Paired clients</h3>
          {status.clients.length === 0 && <p>No clients are paired yet.</p>}
          {status.clients.map((client) => <ClientSettings key={client.id} client={client} disabled={pending} perform={perform} />)}
        </section>
        <section className="agent-card">
          <h3>Agent Account Spaces</h3>
          {status.spaces.map((space) => <div className="agent-space" key={space.id}>
            <strong>{space.name}</strong>
            {reset === space.id ? <>
              <p>This clears this space’s cookies, cache, and website data.</p>
              <div className="agent-buttons"><button className="agent-danger" disabled={pending} onClick={() => void perform(async () => {
                await api.resetAgentSpace(space.id);
                setReset(undefined);
              })}>Clear this space</button><button onClick={() => setReset(undefined)}>Cancel</button></div>
            </> : <button disabled={pending || status.paused} onClick={() => setReset(space.id)}>Reset agent space</button>}
          </div>)}
          <form className="agent-buttons" onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void perform(async () => { await api.addAgentSpace(name.trim()); setName(''); });
          }}>
            <input aria-label="New space name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="New space name" />
            <button disabled={pending || status.paused || !name.trim()}>Add space</button>
          </form>
        </section>
        <SetupCommands status={status} onToast={onToast} />
      </>}
      <section className="agent-card">
        <h3>Audit log</h3>
        <p>Records tool names, origins, and decisions.</p>
        <div className="agent-buttons">
          <button disabled={pending || !status.audit.length} onClick={() => void perform(api.exportAgentAudit)}>Export audit</button>
          <button disabled={pending || !status.audit.length} onClick={() => void perform(api.clearAgentAudit)}>Clear audit</button>
        </div>
        {Boolean(status.audit.length) && <ul className="agent-log">{status.audit.map((item, index) => <li key={`${item.at}-${index}`}>
          <strong>{item.client} · {item.tool.replaceAll('_', ' ')}</strong>
          <small>{item.decision} · {new Date(item.at).toLocaleTimeString()}{item.origin ? ` · ${item.origin}` : ''}</small>
        </li>)}</ul>}
      </section>
    </> : <p role="status">Loading Agent settings…</p>}
  </div>;
}

function ClientSettings({ client, disabled, perform }: {
  client: AgentUiStatus['clients'][number]; disabled: boolean; perform: (action: () => Promise<void>) => Promise<void>;
}) {
  const [profile, setProfile] = useState(client.policy.profile);
  const [outside, setOutside] = useState(client.policy.outside);
  const [session, setSession] = useState(client.policy.session);
  const [draftOrigins, setDraftOrigins] = useState<string>();
  const origins = draftOrigins ?? client.policy.origins.join('\n');
  const save = (event: FormEvent) => {
    event.preventDefault();
    void perform(async () => {
      await window.privateBrowser.setAgentPolicy(client.id, {
        profile, outside, session, origins: origins.split(/[\r\n]+/).map((line) => line.trim()).filter(Boolean),
      });
      setDraftOrigins(undefined);
    });
  };
  return <details className="agent-client">
    <summary>{client.name} <small>{client.active ? 'Connected' : 'Paired'}</small></summary>
    <form onSubmit={save}>
      <label>Permission profile<select value={profile} onChange={(event) => setProfile(event.target.value as AgentPolicy['profile'])}>
        <option value="observe">Observe</option><option value="develop">Develop</option><option value="operate">Operate</option>
      </select></label>
      <label>Approved origins <small>One scheme, host and port per line</small>
        <textarea value={origins} onChange={(event) => setDraftOrigins(event.target.value)} rows={3} placeholder="https://staging.example.com" />
      </label>
      <label>Other origins<select value={outside} onChange={(event) => setOutside(event.target.value as AgentPolicy['outside'])}>
        <option value="observe">Read only</option><option value="deny">Block</option>
      </select></label>
      <label>Session length<select value={session} onChange={(event) => setSession(event.target.value as AgentPolicy['session'])}>
        <option value="1h">1 hour</option><option value="8h">8 hours</option><option value="open">While Private Browser is open</option>
      </select></label>
      <button disabled={disabled}>Save permissions</button>
    </form>
    <p>Session expiry {client.expiresAt === undefined ? 'pending first connection' : (
      <time dateTime={new Date(client.expiresAt).toISOString()}>{new Date(client.expiresAt).toLocaleString()}</time>
    )}</p>
    {client.uploadFolder && <p className="agent-upload-path">{client.uploadFolder}</p>}
    <div className="agent-buttons">
      <button disabled={disabled} onClick={() => void perform(() => window.privateBrowser.renewAgent(client.id))}>Renew session</button>
      <button disabled={disabled} onClick={() => void perform(() => window.privateBrowser.grantAgentUploads(client.id))}>Choose upload folder</button>
      {client.uploadFolder && <button disabled={disabled} onClick={() => void perform(() => window.privateBrowser.revokeAgentUploads(client.id))}>Remove folder grant</button>}
      <button className="agent-danger" disabled={disabled} onClick={() => void perform(() => window.privateBrowser.revokeAgent(client.id))}>Revoke client</button>
    </div>
  </details>;
}

function SetupCommands({ status, onToast }: { status: AgentUiStatus; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const argv = [status.command, ...status.commandArgs];
  const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const command = argv.map(ps).join(' ');
  const codexArgs = [...status.commandArgs, '--client', 'codex'];
  const claudeArgs = [...status.commandArgs, '--client', 'claude-code'];
  const commands = [
    { title: 'Claude Code setup', value: `claude mcp add private-browser -- ${command} --client claude-code` },
    { title: 'Pair Claude Code', value: `& ${command} pair --client claude-code` },
    { title: 'Claude project .mcp.json', value: JSON.stringify({ mcpServers: { 'private-browser': { command: status.command, args: claudeArgs } } }, null, 2) },
    { title: 'Codex config.toml', value: `[mcp_servers.private-browser]\ncommand = ${JSON.stringify(status.command)}\nargs = ${JSON.stringify(codexArgs)}` },
    { title: 'Pair Codex', value: `& ${command} pair --client codex` },
  ];
  return <section className="agent-card">
    <h3>Client setup</h3>
    {commands.map(({ title, value }) => <details key={title}><summary>{title}</summary>
      <pre>{value}</pre><button onClick={() => void navigator.clipboard.writeText(value)
        .then(() => onToast('Copied')).catch(() => onToast('Select the command and copy it manually.', 'error'))}><Copy size={13} /> Copy {title}</button>
    </details>)}
  </section>;
}

export function AgentWorkspaceView() {
  const status = useAgentStatus();
  const [error, setError] = useState('');
  const [responding, setResponding] = useState(false);
  const perform = (action: () => Promise<void>) => {
    setError('');
    return action().catch(() => setError('The request could not be completed. Try again.'));
  };
  const api = window.privateBrowser;
  const tab = status?.tabs.find((item) => item.id === status.selectedTab);
  const card = status?.pending;
  const respond = (decision: AgentDecision) => {
    if (!card || responding) return;
    setResponding(true);
    void perform(() => api.decideAgentAction(card.id, decision)).finally(() => setResponding(false));
  };
  return <main className={`agent-workspace${status?.current ? ' agent-driving' : ''}`}>
    <header className="agent-chrome">
      <div className="agent-workspace-heading"><Bot size={19} /><h1>Agent Workspace</h1><button className="agent-danger"
        onClick={() => void perform(api.stopAgents)}><Square size={13} /> Stop</button></div>
      <nav aria-label="Agent tabs">{status?.tabs.map((item) => <button key={item.id} aria-current={item.id === status.selectedTab}
        title={item.name} onClick={() => void perform(() => api.selectAgentTab(item.id))}>{item.label || item.name}</button>)}</nav>
      <div className="agent-control-line" role="status">
        {status?.current ? <span>{status.current.client} is controlling this tab <small>· {status.current.step.replaceAll('_', ' ')}</small></span>
          : <span>{tab?.manual ? 'You are controlling this tab' : 'No agent is driving'}</span>}
        {tab && <div className="agent-buttons">
          <button onClick={() => void perform(() => api.setAgentTabManual(tab.id, !tab.manual))}>{tab.manual ? 'Return control to agent' : 'Take manual control'}</button>
          <button aria-label="Close agent tab" onClick={() => void perform(() => api.closeAgentTab(tab.id))}>Close tab</button>
        </div>}
      </div>
    </header>
    {error && <p role="alert">{error}</p>}
    {card && <section className="agent-confirmation agent-card" role="alertdialog" aria-modal="true" aria-labelledby="agent-confirm-title">
      <ShieldCheck size={24} /><h2 id="agent-confirm-title">Approve agent action</h2>
      <p>{card.client} requests <strong>{card.action}</strong>.</p>
      <dl>
        <dt>Tab</dt><dd>{card.tab}</dd><dt>Origin</dt><dd>{card.origin}</dd>
        {card.target && <><dt>Target</dt><dd>{card.target}</dd></>}
        {card.input && <><dt>Input</dt><dd>{card.input}</dd></>}
        {card.formTarget && <><dt>Form target</dt><dd>{card.formTarget}</dd></>}
      </dl>
      <div className="agent-buttons">
        <button autoFocus disabled={responding} onClick={() => respond('deny')}>Deny</button>
        <button disabled={responding} onClick={() => respond('allow')}>Allow once</button>
        {card.canAllowSession && <button disabled={responding} onClick={() => respond('session')}>Allow for this session</button>}
        {card.canAllowAlways && <button disabled={responding} onClick={() => respond('always')}>Always allow on this site</button>}
      </div>
    </section>}
    {!tab && !card && <p className="agent-workspace-empty">Open a tab from your paired coding agent.</p>}
  </main>;
}
