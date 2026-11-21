import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, Bot, Copy, ShieldCheck, Square } from 'lucide-react';
import { canonicalAgentOrigin, clientLimitSettings } from '@private-browser/bridge-protocol/agent-permission-model';
import type { AgentSpaceSettings } from '@private-browser/bridge-protocol/agent-permissions';
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

type Section = { page: 'overview' | 'audit' } | { page: 'space' | 'limits'; id: string };
type Space = AgentUiStatus['spaces'][number];
type Client = AgentUiStatus['clients'][number];
type Perform = (action: () => Promise<void>, success?: string) => Promise<boolean>;

export function AgentsPanel({ onBack, onToast }: { onBack: () => void; onToast: (message: string, kind?: 'ok' | 'error') => void }) {
  const status = useAgentStatus();
  const [section, navigate] = useState<Section>({ page: 'overview' });
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const header = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (section.page !== 'overview') header.current?.focus();
  }, [section]);
  const perform: Perform = async (action, success) => {
    setPending(true);
    try {
      await action();
      if (success) onToast(success);
      return true;
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Private Browser could not complete the request.', 'error');
      return false;
    } finally { setPending(false); }
  };
  const api = window.privateBrowser;
  const overview = () => navigate({ page: 'overview' });
  const space = section.page === 'space' ? status?.spaces.find(({ id }) => id === section.id) : undefined;
  const client = section.page === 'limits' ? status?.clients.find(({ id }) => id === section.id) : undefined;
  const title = space ? 'Edit ' + space.name : client ? 'Client limits' : section.page === 'audit' ? 'Audit log' : 'Agents';
  return <div className="side-panel agents-panel">
    <button className="updates-back" onClick={section.page === 'overview' ? onBack : overview}>
      <ArrowLeft size={14} aria-hidden="true" /> {section.page === 'overview' ? 'Settings' : 'Agents'}
    </button>
    <div ref={header} tabIndex={-1}><PanelHeader icon={Bot} eyebrow="Private Browser" title={title} /></div>
    {!status ? <p role="status">Loading Agent settings…</p>
      : status.unavailable ? <section className="agent-card agent-notice" role="alert"><h3>Agent settings are unavailable</h3>
        <p>{status.unavailable}</p><p>Agent Mode is paused. Restart Private Browser after restoring the policy.</p>
      </section>
        : space ? <SpaceEditor key={space.id} space={space} clients={status.clients} pending={pending} onCancel={overview} perform={perform} />
          : client ? <LimitsEditor key={client.id} client={client} pending={pending} onCancel={overview} perform={perform} />
            : section.page === 'audit' ? <AuditViewer status={status} pending={pending} perform={perform} />
              : <>
                <section className="agent-card">
                  <label className="agent-switch"><input type="checkbox" checked={status.enabled} disabled={pending}
                    onChange={(event) => { const enabled = event.currentTarget.checked; void perform(() => api.setAgentsEnabled(enabled)); }} /> Allow coding agents</label>
                  <p>Pair a coding agent, then grant access in the space editor.</p>
                  {status.enabled && <div className="agent-buttons">
                    {status.paused
                      ? <button disabled={pending} onClick={() => void perform(api.resumeAgents)}>Resume Agent Mode</button>
                      : <button disabled={pending} onClick={() => void perform(api.beginAgentPairing)}>Generate pairing code</button>}
                    <button disabled={pending} onClick={() => void perform(api.openAgentWorkspace)}>Open Agent Workspace</button>
                    {status.active && <button className="agent-danger" onClick={() => void perform(api.stopAgents)}><Square size={13} /> Stop all agents</button>}
                  </div>}
                  {status.pairing && <div className="agent-pairing" role="status"><strong>Pairing code</strong><output>{status.pairing.code}</output>
                    <small>Single use. Expires at {new Date(status.pairing.expiresAt).toLocaleTimeString()}.</small></div>}
                </section>
                {status.enabled && <>
                  <section className="agent-card">
                    <h3>Agent Account Spaces</h3>
                    {status.spaces.map((item) => <div className="agent-space agent-space-summary" key={item.id}>
                      <div>
                        <strong>{item.name}</strong>
                        <small>{item.trust === 'open-web' ? 'Public web · No saved logins' : 'Owner-managed sign-in'}</small>
                        <small>{item.clientIds.length === 0 ? 'No clients have access'
                          : item.trust === 'work' && item.origins.length === 0 ? 'No origins added'
                            : item.clientIds.length + (item.clientIds.length === 1 ? ' client has access' : ' clients have access')}</small>
                      </div>
                      <button aria-label={'Edit ' + item.name} disabled={pending || status.paused}
                        onClick={() => navigate({ page: 'space', id: item.id })}>Edit</button>
                    </div>)}
                    <form className="agent-buttons" onSubmit={(event) => {
                      event.preventDefault();
                      if (name.trim()) void perform(() => api.addAgentSpace(name.trim()), 'Work space added.').then((saved) => { if (saved) setName(''); });
                    }}>
                      <input aria-label="New space name" value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="New space name" />
                      <button disabled={pending || status.paused || !name.trim()}>Add space</button>
                    </form>
                  </section>
                  <section className="agent-card">
                    <h3>Paired clients</h3>
                    {status.clients.length === 0 && <p>No clients are paired yet.</p>}
                    {status.clients.map((item) => <div className="agent-space agent-space-summary" key={item.id}>
                      <div><strong>{item.name}</strong><small>{item.active ? 'Connected' : 'Paired'}</small></div>
                      <button aria-label={'Limits for ' + item.name} disabled={status.paused} onClick={() => navigate({ page: 'limits', id: item.id })}>Limits</button>
                    </div>)}
                  </section>
                  <SetupCommands status={status} onToast={onToast} />
                </>}
                <section className="agent-card"><button className="agent-audit-link" onClick={() => navigate({ page: 'audit' })}>Audit log</button></section>
              </>}
  </div>;
}

function SpaceEditor({ space, clients, pending, onCancel, perform }: {
  space: Space; clients: Client[]; pending: boolean; onCancel: () => void; perform: Perform;
}) {
  const api = window.privateBrowser;
  const { id, uploadRootPresent, migrated } = space;
  const [draft, setDraft] = useState<AgentSpaceSettings>(() => {
    const { id: _id, uploadRootPresent: _upload, migrated: _migrated, ...settings } = space;
    return settings;
  });
  const [origin, setOrigin] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [reset, setReset] = useState(false);
  const originInput = useRef<HTMLInputElement>(null);
  let canonical: string | undefined;
  if (origin.trim()) {
    try { canonical = canonicalAgentOrigin(origin, true); } catch { /* Keep invalid input visible. */ }
  }
  const invalid = Boolean(origin.trim() && !canonical);
  const commitOrigin = () => {
    if (draft.trust !== 'work' || !canonical || draft.origins.length >= 30) return;
    setDraft({ ...draft, origins: [...new Set([...draft.origins, canonical])] });
    setOrigin('');
    setSubmitted(false);
    originInput.current?.focus();
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (origin.trim()) {
      setSubmitted(true);
      originInput.current?.focus();
      return;
    }
    void perform(() => api.setAgentSpace(id, draft), 'Space settings saved.').then((saved) => { if (saved) onCancel(); });
  };
  const classNames = { read: 'Read', view: 'View', interact: 'Interact', diagnostic: 'Diagnostics' } as const;
  return <form className="agent-editor" onSubmit={save}>
    <section className="agent-card">
      <h3>Trust level</h3>
      <p>{draft.trust === 'work' ? 'Work · Owner-managed sign-in' : 'Open Web · No saved logins'}</p>
      {migrated && <p role="status">Saving replaces this space’s migrated client rules for the clients selected below. Review the origins and client access first.</p>}
    </section>
    <section className="agent-card">
      <h3>Allowed origins</h3>
      {draft.trust === 'open-web' ? <p>Public HTTP and HTTPS. Private network destinations and protected pages are blocked.</p> : <>
        <label className="agent-field">Add an origin
          <input ref={originInput} value={origin} maxLength={300} placeholder="https://app.example.com"
            onChange={(event) => { setOrigin(event.target.value); setSubmitted(false); }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (canonical) commitOrigin(); else setSubmitted(true); } }}
            aria-invalid={invalid} aria-describedby="agent-origin-preview" />
        </label>
        <div className="agent-origin-preview">
          <div id="agent-origin-preview" aria-live="polite">
            {invalid ? <small className="agent-danger">Enter a scheme, host and optional port. Remove paths and account information.</small>
              : canonical ? <><small>Origin preview</small><output>{canonical}</output>
                {canonical.includes('://*.') && <small className="agent-warning-text">This includes every subdomain.</small>}
                {canonical.includes('xn--') && <small className="agent-warning-text">Check the ASCII address for look-alike letters.</small>}
                {submitted && <small className="agent-danger">Select Add before saving.</small>}</>
                : <small>Enter one origin at a time.</small>}
          </div>
          <button type="button" disabled={!canonical || draft.origins.length >= 30} onClick={commitOrigin}>Add</button>
        </div>
        {!draft.origins.length ? <p>No origins added.</p> : <ul className="agent-origin-list">{draft.origins.map((item) =>
          <li key={item}><span>{item}</span><button type="button" aria-label={'Remove ' + item}
            onClick={() => setDraft({ ...draft, origins: draft.origins.filter((value) => item !== value) })}>Remove</button></li>)}</ul>}
        <label className="agent-field agent-inline-field">Other origins
          <select value={draft.outside} onChange={(event) => setDraft({ ...draft, outside: event.target.value as typeof draft.outside })}>
            <option value="view">Read and view</option><option value="observe">Read only</option><option value="deny">Block</option>
          </select>
        </label>
        {draft.outside !== 'deny' && <small>Signed-out preview</small>}
      </>}
    </section>
    <section className="agent-card">
      <h3>Allowed actions</h3>
      <div className="agent-action-options">{Object.entries(classNames).map(([key, label]) => {
        const action = key as keyof typeof classNames;
        const disabled = draft.trust === 'open-web' && action === 'diagnostic';
        return <label key={action}><input type="checkbox" checked={draft.classes[action]} disabled={disabled}
          onChange={(event) => setDraft({ ...draft, classes: { ...draft.classes, [action]: event.target.checked } })} /> {label}</label>;
      })}</div>
      <small>{draft.trust === 'work' ? 'Diagnostics require a listed loopback origin.' : 'Diagnostics are off in Open Web.'}</small>
    </section>
    <section className="agent-card">
      <h3>Files</h3>
      <label><input type="checkbox" checked={draft.classes.files} disabled={draft.trust === 'work' && !uploadRootPresent}
        onChange={(event) => setDraft({ ...draft, classes: { ...draft.classes, files: event.target.checked } })} /> Allow downloads and granted uploads</label>
      <div className="agent-space-summary agent-file-row">
        <div><strong>Upload folder</strong><small>{uploadRootPresent ? 'Folder selected' : 'No folder selected'}</small></div>
        <button type="button" disabled={pending} onClick={() => void perform(() => api.grantAgentUploads(id))}>Choose folder</button>
      </div>
      {uploadRootPresent && <button type="button" disabled={pending} onClick={() => void perform(() => api.revokeAgentUploads(id), 'Folder grant removed.')}>Remove folder grant</button>}
      <label className="agent-field agent-inline-field agent-file-row">Download quota (MB)
        <input type="number" min={1} max={1_000} required value={Number.isFinite(draft.downloadQuotaMb) ? draft.downloadQuotaMb : ''}
          onChange={(event) => setDraft({ ...draft, downloadQuotaMb: event.target.valueAsNumber })} />
      </label>
    </section>
    <section className="agent-card">
      <h3>Client access</h3>
      {!clients.length && <p>No clients are paired yet.</p>}
      <div className="agent-action-options">{clients.map((item) => <label key={item.id}>
        <input type="checkbox" checked={draft.clientIds.includes(item.id)}
          onChange={(event) => setDraft({ ...draft, clientIds: event.target.checked ? [...draft.clientIds, item.id] : draft.clientIds.filter((value) => value !== item.id) })} /> {item.name}
      </label>)}</div>
    </section>
    <section className="agent-card">
      <h3>Stored site data</h3>
      <button type="button" className="agent-danger" disabled={pending} onClick={() => setReset(true)}>Reset agent space</button>
    </section>
    <div className="agent-buttons agent-edit-footer">
      <button className="agent-primary" disabled={pending}>Save changes</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
    {reset && <OwnerDialog title="Clear this space?" onDismiss={() => setReset(false)}>
      <p>This removes the cookies and site data in {space.name}. Downloaded files stay on disk.</p>
      <div className="agent-buttons">
        <button type="button" autoFocus onClick={() => setReset(false)}>Cancel</button>
        <button type="button" className="agent-danger" disabled={pending} onClick={() =>
          void perform(() => api.resetAgentSpace(id), 'Site data cleared.').then((saved) => { if (saved) setReset(false); })}>Clear this space</button>
      </div>
    </OwnerDialog>}
  </form>;
}

function LimitsEditor({ client, pending, onCancel, perform }: { client: Client; pending: boolean; onCancel: () => void; perform: Perform }) {
  const [draft, setDraft] = useState(client.limits);
  const [modal, setModal] = useState<'renew' | 'revoke'>();
  const api = window.privateBrowser;
  const fields = [
    { name: 'Actions per minute', field: 'actionsPerMinute', multiplier: 1, unit: '' },
    { name: 'Open agent tabs', field: 'tabs', multiplier: 1, unit: '' },
    { name: 'Idle time (minutes)', field: 'idleMs', multiplier: 60_000, unit: ' minutes' },
    { name: 'Session duration (hours)', field: 'sessionMs', multiplier: 60 * 60_000, unit: ' hours' },
  ] as const;
  const expired = !client.expiresAt || client.expiresAt <= Date.now();
  return <form className="agent-editor" onSubmit={(event) => {
    event.preventDefault();
    void perform(() => api.setAgentLimits(client.id, draft), 'Client limits saved.').then((saved) => { if (saved) onCancel(); });
  }}>
    <section className="agent-card"><h3>{client.name}</h3>
      <p>Limits apply across all of this client’s tabs.</p>
      <div className="agent-limits-grid">
        {fields.map(({ name, field, multiplier, unit }) => {
          const { max, min } = clientLimitSettings[field];
          return <label className="agent-field" key={field}>{name}
            <input type="number" required min={min / multiplier} max={max / multiplier} step={field === 'sessionMs' ? 'any' : 1}
              value={Number.isFinite(draft[field]) ? draft[field] / multiplier : ''}
              onChange={(event) => setDraft({ ...draft, [field]: Math.round(event.target.valueAsNumber * multiplier) })} />
            <small>Maximum {max / multiplier}{unit}</small>
          </label>;
        })}
      </div>
    </section>
    <section className="agent-card agent-notice">
      <h3>{expired ? 'Session expired' : 'Active session'}</h3>
      {client.expiresAt && <p>{expired ? 'Expired ' : 'Expires '}{new Date(client.expiresAt).toLocaleString()}. Only you can renew it.</p>}
      <button type="button" onClick={() => setModal('renew')}>Review renewal</button>
    </section>
    <div className="agent-buttons agent-edit-footer">
      <button className="agent-primary" disabled={pending}>Save limits</button>
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="button" className="agent-danger" disabled={pending} onClick={() => setModal('revoke')}>Revoke client</button>
    </div>
    {modal === 'renew' && <RenewalPrompt client={client} pending={pending} dismiss={() => setModal(undefined)}
      renew={() => void perform(() => api.renewAgent(client.id), 'Session renewed.').then((saved) => { if (saved) setModal(undefined); })} />}
    {modal === 'revoke' && <OwnerDialog title={'Revoke ' + client.name + '?'} onDismiss={() => setModal(undefined)}>
      <p>This closes the client’s tabs and removes its access to every space.</p>
      <div className="agent-buttons"><button type="button" autoFocus onClick={() => setModal(undefined)}>Cancel</button>
        <button type="button" className="agent-danger" disabled={pending} onClick={() =>
          void perform(() => api.revokeAgent(client.id), 'Client revoked.').then((saved) => { if (saved) onCancel(); })}>Revoke client</button></div>
    </OwnerDialog>}
  </form>;
}

function OwnerDialog({ title, onDismiss, children }: { title: string; onDismiss: () => void; children: ReactNode }) {
  const modal = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = modal.current;
    const focused = document.activeElement;
    dialog?.showModal();
    dialog?.querySelector('button')?.focus();
    return () => { dialog?.close(); if (focused instanceof HTMLElement && focused.isConnected) focused.focus(); };
  }, []);
  return <dialog ref={modal} className="agent-card agent-owner-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onDismiss(); }}>
    <h2 id={titleId}>{title}</h2>
    {children}
  </dialog>;
}

function RenewalPrompt({ client, pending, dismiss, renew }: { client: Client; pending: boolean; dismiss: () => void; renew: () => void }) {
  const minutes = Math.round(client.limits.sessionMs / 60_000);
  const duration = minutes % 60 ? minutes + ' minutes' : minutes / 60 + (minutes === 60 ? ' hour' : ' hours');
  return <OwnerDialog title={'Renew ' + client.name + ' session'} onDismiss={dismiss}>
    <p>Start a fresh {duration} session with the saved permissions. Existing tabs and action approvals will close.</p>
    <div className="agent-buttons"><button type="button" autoFocus onClick={dismiss}>Cancel</button>
      <button type="button" className="agent-primary" disabled={pending} onClick={renew}>Renew for {duration}</button>
    </div>
  </OwnerDialog>;
}

function AuditViewer({ status, pending, perform }: { status: AgentUiStatus; pending: boolean; perform: Perform }) {
  const [space, choose] = useState('');
  const [confirm, setConfirm] = useState(false);
  const api = window.privateBrowser;
  const rows = status.audit.filter((row) => !space || row.spaceId === space);
  return <section className="agent-card">
    <label className="agent-field">Space
      <select value={space} onChange={(event) => choose(event.target.value)}>
        <option value="">All spaces</option>
        {status.spaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <div className="agent-buttons agent-file-row">
      <button disabled={pending || !status.audit.length} onClick={() => void perform(api.exportAgentAudit)}>Export audit</button>
      <button disabled={pending || !status.audit.length} onClick={() => setConfirm(true)}>Clear audit</button>
    </div>
    {!rows.length ? <p role="status">No actions recorded in this view.</p> : <ul className="agent-log">
      {rows.map((row, index) => <li key={row.at + '-' + index}>
        <div className="agent-log-result"><strong>{row.tool}</strong><span>{row.actionClass ?? 'Action'}</span>
          <span className={row.decision === 'allowed' ? 'agent-allowed' : 'agent-danger'}>{row.decision === 'denied' ? 'Refused' : row.decision}</span></div>
        {row.origin && <span>{row.origin}</span>}
        <small><time dateTime={row.at}>{new Date(row.at).toLocaleTimeString()}</time>{row.decision !== 'allowed' && ' · ' + row.result}</small>
      </li>)}
    </ul>}
    {confirm && <OwnerDialog title="Clear the audit log?" onDismiss={() => setConfirm(false)}>
      <p>This clears saved agent actions for every space.</p>
      <div className="agent-buttons"><button type="button" autoFocus onClick={() => setConfirm(false)}>Cancel</button>
        <button type="button" className="agent-danger" disabled={pending} onClick={() =>
          void perform(api.clearAgentAudit, 'Audit cleared.').then((saved) => { if (saved) setConfirm(false); })}>Clear audit</button></div>
    </OwnerDialog>}
  </section>;
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
  useEffect(() => {
    const colors = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => { document.documentElement.dataset.theme = colors.matches ? 'dark' : 'light'; };
    update();
    colors.addEventListener('change', update);
    return () => colors.removeEventListener('change', update);
  }, []);
  const [error, setError] = useState('');
  const [responding, setResponding] = useState(false);
  const [dismissedWarning, setDismissedWarning] = useState(false);
  const [renewing, setRenewing] = useState<string>();
  const perform = (action: () => Promise<void>) => {
    setError('');
    return action().catch(() => setError('The request could not be completed. Try again.'));
  };
  const api = window.privateBrowser;
  const tab = status?.tabs.find((item) => item.id === status.selectedTab);
  const card = status?.pending;
  const warning = status?.possibleSignIn;
  const expired = status?.clients.filter((client) => client.expiresAt !== undefined && client.expiresAt <= Date.now()) ?? [];
  const renewal = expired.find((client) => client.id === renewing);
  useEffect(() => { if (!warning) setDismissedWarning(false); }, [warning]);
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
          {tab.canManual && <button onClick={() => void perform(() => api.setAgentTabManual(tab.id, !tab.manual))}>{tab.manual ? 'Return control to agent' : 'Take manual control'}</button>}
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
        {card.canAllowSession && <button disabled={responding} onClick={() => respond('session')}>Allow navigation for this session on this origin</button>}
        {card.canAllowAlways && <button disabled={responding} onClick={() => respond('always')}>Always allow on this site</button>}
      </div>
    </section>}
    {warning && !dismissedWarning && <OwnerDialog title="Possible sign-in in Open Web" onDismiss={() => setDismissedWarning(true)}>
      <p>Agent tools are paused. Clearing this space removes cookies, site data and history. Downloads stay in the Open Web folder.</p>
      <div className="agent-buttons">
        <button type="button" autoFocus onClick={() => setDismissedWarning(true)}>Keep paused</button>
        <button type="button" className="agent-danger" onClick={() => void perform(() => api.clearAgentOpenWeb(warning))}>Clear Open Web</button>
      </div>
    </OwnerDialog>}
    {warning && dismissedWarning && <div className="agent-card agent-chrome-alert">
      <p>Open Web is paused after a possible sign-in.</p><button onClick={() => setDismissedWarning(false)}>Review sign-in warning</button>
    </div>}
    {!warning && !tab && !card && expired.length > 0 && <section className="agent-card agent-chrome-alert">
      <h2>Session expired</h2>
      <div className="agent-buttons">{expired.map((client) => <button key={client.id} onClick={() => setRenewing(client.id)}>Review renewal for {client.name}</button>)}</div>
    </section>}
    {!warning && renewal && <RenewalPrompt client={renewal} pending={false} dismiss={() => setRenewing(undefined)}
      renew={() => void perform(() => api.renewAgent(renewal.id)).then(() => setRenewing(undefined))} />}
    {!warning && !tab && !card && !expired.length && <p className="agent-workspace-empty">Open a tab from your paired coding agent.</p>}
  </main>;
}
