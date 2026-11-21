import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import { generateIdentity, safeEqual, type DeviceIdentity } from '@private-browser/bridge-protocol';
import {
  AGENT_ACTIONS_PER_MINUTE, AGENT_IDLE_MS, AGENT_MAX_TABS, AGENT_PROTOCOL_VERSION, AGENT_SESSION_MS,
  agentIdentity, type AgentInput, type AgentMethod,
} from '@private-browser/bridge-protocol/agent';
import { AgentAudit, agentStorageAvailable, readAgentFile, writeAgentFile } from './agent-audit.js';
import { AgentPipe, type AgentConnection, type AgentRequest } from './agent-pipe.js';
import { agentAccess, AgentConfirmation, agentError, AgentError, agentLoopback, agentUrl, consequentialAction, DEFAULT_AGENT_POLICY, exactAgentOrigin, type AgentPolicy } from './agent-policy.js';
import { agentTabUrl, AgentWorkspace, type AgentSpace, type AgentTab } from './agent-workspace.js';
import { clean, cleanUrl, untrusted, type TargetDetails } from './agent-driver.js';
import { AgentRecording } from './agent-recording.js';
import { stageAgentUpload, verifyUploadFolder } from './agent-upload.js';
import type { AgentConfirmationCard, AgentDecision, AgentUiStatus } from './agent-types.js';

type Device = ReturnType<typeof agentIdentity.parse>['device'];
type StoredClient = Device & { policy: AgentPolicy; uploadFolder?: string };
type StoredState = { enabled: boolean; identity: DeviceIdentity; clients: StoredClient[]; spaces: AgentSpace[] };
type Live = {
  connection: AgentConnection;
  selected?: string;
  step: AgentMethod | 'ready';
  trustedOrigins: Set<string>;
  recording?: AgentRecording;
};
type Pending = { card: AgentConfirmationCard; connection: AgentConnection; finish(decision: AgentDecision): void };
type Options = {
  data: string;
  rendezvous: string;
  chromeUrl: string;
  preload: string;
  command: string;
  commandArgs: string[];
  onChange: () => void;
  parent: () => BrowserWindow | undefined;
  discover: () => Promise<string[]>;
};

const READ = new Set<AgentMethod>(['wait_for', 'snapshot', 'screenshot', 'get_text', 'downloads_list', 'console_messages', 'network_requests', 'accessibility_audit', 'performance_snapshot']);
const ACTIONS: Partial<Record<AgentMethod, string>> = {
  click: 'click', type: 'type', press_key: 'key', select_option: 'select', check: 'check',
  hover: 'hover', scroll: 'scroll', drag: 'drag',
};

export class AgentHost {
  readonly workspace: AgentWorkspace;
  private readonly statePath: string;
  private state?: StoredState;
  private audit?: AgentAudit;
  private unavailable?: string;
  private pipe?: AgentPipe;
  private paused = false;
  private pending?: Pending;
  private pairing?: { code: string; expiresAt: number; attempts: number };
  private readonly active = new Map<string, Live>();
  private readonly leases = new Map<string, number>();
  private readonly resetting = new Set<string>();

  constructor(private readonly options: Options) {
    this.statePath = join(options.data, 'clients.enc');
    this.workspace = new AgentWorkspace(options.chromeUrl, options.preload, join(options.data, 'downloads'), () => this.changed(), () => this.stop());
    try {
      if (!agentStorageAvailable()) throw new Error();
      this.state = readAgentFile<StoredState>(this.statePath);
      this.audit = new AgentAudit(join(options.data, 'audit.enc'));
    } catch { this.unavailable = 'Agent Mode requires readable operating-system encrypted storage.'; }
  }

  async start(): Promise<void> {
    if (!this.state?.enabled || this.pipe || this.unavailable || this.paused) return;
    const pipe = new AgentPipe({
      root: this.options.rendezvous,
      identity: this.state.identity,
      authorize: (device, code) => this.authorize(device, code),
      opened: (connection) => {
        this.active.set(connection.device.id, { connection, step: 'ready', trustedOrigins: new Set() });
        this.changed();
      },
      closed: (connection) => {
        this.workspace.closeConnection(connection);
        if (this.active.get(connection.device.id)?.connection === connection) this.active.delete(connection.device.id);
        this.changed();
      },
      request: (connection, request) => this.request(connection, request),
    });
    this.pipe = pipe;
    try { await pipe.start(); }
    catch {
      pipe.stop();
      if (this.pipe === pipe) { this.pipe = undefined; this.unavailable = 'The local Agent connection could not start.'; }
    }
    this.changed();
  }

  status(): AgentUiStatus {
    const state = this.state;
    const tab = this.workspace.selected ? this.workspace.get(this.workspace.selected) : undefined;
    const current = tab && !tab.manual && !tab.connection.abort.aborted ? {
      client: tab.connection.device.name, step: this.active.get(tab.connection.device.id)?.step ?? 'ready', tabId: tab.id,
    } : undefined;
    const pairing = this.pairing && Date.now() < this.pairing.expiresAt ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : undefined;
    return {
      enabled: state?.enabled ?? false, unavailable: this.unavailable, pairing, paused: this.paused,
      clients: (state?.clients ?? []).map(({ id, name, policy, uploadFolder }) => ({ id, name, policy, uploadFolder, active: this.active.has(id) })),
      spaces: state?.spaces ?? [], current, pending: this.pending?.card,
      tabs: this.workspace.summaries(), selectedTab: this.workspace.selected,
      active: this.active.size > 0, audit: this.audit?.list() ?? [], command: this.options.command, commandArgs: this.options.commandArgs,
    };
  }

  async enable(enabled: boolean): Promise<void> {
    if (this.unavailable && enabled) throw new Error(this.unavailable);
    if (!this.state && !enabled) return;
    if (!enabled) this.stop();
    const initial = this.state ?? { identity: generateIdentity(), clients: [], spaces: [{ id: randomUUID(), name: 'Agent Account Space' }] };
    this.persist({ ...initial, enabled });
    this.paused = false;
    if (enabled) await this.start();
    this.changed();
  }

  beginPairing(): void {
    this.requireEnabled();
    if (this.state!.clients.length >= 12) throw new Error('Revoke an existing client before pairing another.');
    this.pairing = { code: String(randomInt(0, 100_000_000)).padStart(8, '0'), expiresAt: Date.now() + 300_000, attempts: 0 };
    this.changed();
  }

  async resume(): Promise<void> {
    if (!this.state?.enabled) throw new Error('Turn on Allow coding agents first.');
    this.paused = false;
    await this.start();
    this.changed();
  }

  stop(): void {
    this.paused = Boolean(this.state?.enabled);
    this.pairing = undefined;
    this.pending?.finish('deny');
    for (const { connection } of this.active.values()) connection.close();
    this.active.clear();
    this.leases.clear();
    this.workspace.closeAll();
    this.pipe?.stop();
    this.pipe = undefined;
    this.changed();
  }

  revoke(id: string): void {
    const state = this.state;
    if (!state) return;
    this.persist({ ...state, clients: state.clients.filter((client) => client.id !== id) });
    this.disconnect(id);
    this.changed();
  }

  renew(id: string): void {
    if (!this.requireEnabled().clients.some((client) => client.id === id)) throw new Error('That client is no longer paired.');
    this.disconnect(id);
    this.changed();
  }

  setPolicy(id: string, policy: AgentPolicy): void {
    this.replaceClient(id, { policy: { ...policy, origins: [...new Set(policy.origins.map(exactAgentOrigin))] } });
  }

  async grantUploadFolder(id: string): Promise<void> {
    const parent = this.options.parent();
    const options: Electron.OpenDialogOptions = { title: 'Choose a folder for agent uploads', properties: ['openDirectory'] };
    const selected = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
    if (selected.canceled || !selected.filePaths[0]) return;
    const uploadFolder = await verifyUploadFolder(selected.filePaths[0], this.options.data);
    this.replaceClient(id, { uploadFolder });
  }

  revokeUploadFolder(id: string): void { this.replaceClient(id, { uploadFolder: undefined }); }

  addSpace(name: string): void {
    const state = this.requireEnabled();
    if (state.spaces.length >= 8) throw new Error('Agent Mode supports up to eight spaces.');
    this.persist({ ...state, spaces: [...state.spaces, { id: randomUUID(), name }] });
    this.changed();
  }

  async resetSpace(id: string): Promise<void> {
    const space = this.requireEnabled().spaces.find((candidate) => candidate.id === id);
    if (!space || this.resetting.has(id)) throw new Error('That Agent Account Space is unavailable.');
    this.resetting.add(id);
    try { await this.workspace.reset(space); } finally { this.resetting.delete(id); }
    this.changed();
  }

  clearAudit(): void { this.audit?.clear(); this.changed(); }

  async exportAudit(): Promise<void> {
    const options: Electron.SaveDialogOptions = { title: 'Export Agent Mode audit', defaultPath: 'private-browser-agent-audit.json', filters: [{ name: 'JSON', extensions: ['json'] }] };
    const parent = this.options.parent();
    const result = await (parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options));
    if (!result.canceled && result.filePath) {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(result.filePath, JSON.stringify(this.audit?.list() ?? [], null, 2), { mode: 0o600 });
    }
  }

  decide(id: string, decision: AgentDecision): void {
    const pending = this.pending;
    if (!pending || pending.card.id !== id || decision === 'session' && !pending.card.canAllowSession) return;
    pending.finish(decision);
  }

  private async request(connection: AgentConnection, request: AgentRequest): Promise<unknown> {
    const live = this.active.get(connection.device.id);
    const client = this.state?.clients.find(({ id }) => id === connection.device.id);
    if (!live || !client || live.connection !== connection || connection.abort.aborted || !this.audit) throw new AgentError('SESSION_CLOSED', 'This session ended.');
    const tab = this.workspace.get(live.selected ?? '');
    const origin = tab?.origin;
    let allowed = false;
    let code = 'completed';
    live.step = request.method;
    this.changed();
    try {
      const result = await this.dispatch(live, client, request);
      connection.abort.throwIfAborted();
      allowed = true;
      return result;
    } catch (error) {
      code = agentError(error).code;
      throw error;
    } finally {
      try {
        this.audit.add({
          at: new Date().toISOString(), client: client.name, tool: request.method, origin,
          decision: allowed ? 'allowed' : code === 'AGENT_ACTION_FAILED' ? 'failed' : 'denied', result: code,
        });
      } catch {
        this.unavailable = 'Agent audit storage could not be updated.';
        this.stop();
      }
      live.step = 'ready';
      this.changed();
    }
  }

  private async dispatch(live: Live, client: StoredClient, request: AgentRequest): Promise<unknown> {
    const { method, input } = request;
    const connection = live.connection;
    const state = this.requireEnabled();
    if (method === 'browser_status') return {
      enabled: true, client: client.name, activeSpace: this.workspace.get(live.selected ?? '')?.space.name,
      allowedOrigins: client.policy.origins, profile: client.policy.profile, protocolVersion: AGENT_PROTOCOL_VERSION, outside: client.policy.outside,
      limits: { actionsPerMinute: AGENT_ACTIONS_PER_MINUTE, tabs: AGENT_MAX_TABS, idleMs: AGENT_IDLE_MS, expiresAt: connection.expiresAt },
      spaces: state.spaces,
    };
    if (method === 'tabs_list') return untrusted(this.workspace.forConnection(connection).map((tab) => ({
      tabId: tab.id, url: agentTabUrl(tab), selected: tab.id === live.selected, space: tab.space.name, manual: tab.manual,
    })));
    if (method === 'tab_open') {
      const { url, space: id } = input as AgentInput<'tab_open'>;
      const target = agentUrl(url);
      const space = id ? state.spaces.find((item) => item.id === id) : state.spaces[0];
      if (!space || this.resetting.has(space.id)) throw new AgentError('SPACE_UNAVAILABLE', 'Choose an available Agent Account Space.');
      if (this.workspace.forConnection(connection).length >= AGENT_MAX_TABS) throw new AgentError('TAB_LIMIT', 'Close an agent tab before opening another.');
      this.allowNavigation(client.policy, target);
      await this.confirm(live, request, { destination: target, allowSession: true });
      if (this.resetting.has(space.id)) throw new AgentError('SPACE_UNAVAILABLE', 'The Agent Account Space is resetting.');
      const tab = await this.workspace.create(space, connection, client.policy);
      live.selected = tab.id;
      try { await this.workspace.load(tab, target); } catch (error) { this.workspace.close(tab.id); throw error; }
      live.recording?.navigate(target.href);
      return untrusted({ tabId: tab.id, url: agentTabUrl(tab), space: space.name });
    }
    if (method === 'tab_select' || method === 'tab_close') {
      const tab = this.workspace.owned(connection, (input as AgentInput<'tab_select'>).tabId);
      if (method === 'tab_close') this.workspace.close(tab.id);
      else { live.selected = tab.id; this.workspace.select(tab.id); }
      return { tabId: tab.id };
    }
    if (method === 'dev_servers') return { origins: await this.devServers(connection.abort) };
    if (method === 'record_start') {
      const tab = this.workspace.get(live.selected ?? '');
      live.recording = new AgentRecording(tab?.origin && tab.view.webContents.getURL());
      return { recording: true };
    }
    if (method === 'record_stop') {
      if (!live.recording) throw new AgentError('NO_RECORDING', 'Start a recording first.');
      const output = untrusted({ playwright: live.recording.finish() });
      live.recording = undefined;
      return output;
    }

    const tab = this.workspace.owned(connection, live.selected);
    const contents = tab.view.webContents;
    const url = agentUrl(contents.getURL());
    this.allowNavigation(client.policy, url);
    if (method === 'navigate') {
      const target = agentUrl((input as AgentInput<'navigate'>).url);
      this.allowNavigation(client.policy, target);
      if (target.origin !== url.origin) await this.confirm(live, request, { tab, destination: target, allowSession: true });
      await this.workspace.load(tab, target);
      live.recording?.navigate(target.href);
      return untrusted({ url: agentTabUrl(tab) });
    }
    if (!READ.has(method) && agentAccess(client.policy, url) !== 'drive') throw new AgentError('READ_ONLY', 'This client can only read pages at this origin.');
    if (method === 'go_back' || method === 'go_forward') {
      const history = contents.navigationHistory;
      const delta = method === 'go_back' ? -1 : 1;
      const targetIndex = history.getActiveIndex() + delta;
      const destination = history.getEntryAtIndex(targetIndex);
      if (!destination) throw new AgentError('HISTORY_EMPTY', 'There is no navigation in that direction.');
      const target = agentUrl(destination.url);
      this.allowNavigation(client.policy, target);
      if (url.origin !== target.origin) await this.confirm(live, request, { tab, destination: target, allowSession: true });
      tab.navigationGrant = { origin: target.origin, until: Date.now() + 4_000 };
      history.goToIndex(targetIndex);
      live.recording?.step(method === 'go_back' ? 'goBack' : 'goForward');
      return { started: true };
    }
    if (method === 'reload') { contents.reload(); live.recording?.step('reload'); return { started: true }; }

    const signal = connection.abort;
    const driver = tab.driver;
    const ref = (input as { ref?: string }).ref;
    switch (method) {
      case 'snapshot': {
        const result = await driver.run<{ nodes: { ref: string; role: string; name: string; value?: string; checked?: boolean; disabled?: boolean }[] }>('snapshot', {}, signal);
        return untrusted({ url: agentTabUrl(tab), nodes: result.nodes.map((node) => ({
          ...node, role: clean(node.role, 40), name: clean(node.name, 220), value: node.value === undefined ? undefined : clean(node.value, 160),
        })) });
      }
      case 'get_text': return untrusted(clean(await driver.run<string>('text', { ref }, signal), 12_000));
      case 'screenshot': return driver.screenshot(input as AgentInput<'screenshot'>, signal);
      case 'console_messages': return driver.console((input as AgentInput<'console_messages'>).since);
      case 'network_requests': return driver.network((input as AgentInput<'network_requests'>).filter);
      case 'downloads_list': return untrusted(this.workspace.downloadList(tab.space));
      case 'performance_snapshot': return untrusted(await driver.run('metrics', {}, signal));
      case 'accessibility_audit': return driver.audit(signal);
      case 'wait_for': await driver.wait(input as AgentInput<'wait_for'>, signal); return { matched: true };
      case 'emulate': await driver.emulate(input as AgentInput<'emulate'>); return { applied: true };
      case 'evaluate': {
        if (!agentLoopback(url) && (client.policy.profile !== 'develop' || !client.policy.origins.includes(url.origin))) {
          throw new AgentError('DEVELOPMENT_ONLY', 'Diagnostics are available on loopback and approved development origins.');
        }
        const result = await driver.run('evaluate', input, signal);
        return untrusted(typeof result === 'string' ? clean(result) : result);
      }
      case 'handle_dialog': {
        await this.confirm(live, request, { tab, dialog: true });
        const { accept, text } = input as AgentInput<'handle_dialog'>;
        await driver.respondToDialog(accept, text);
        return { handled: true };
      }
      default: break;
    }

    const target = ref ? await driver.run<TargetDetails>('inspect', { ref }, signal) : undefined;
    if (target?.private && method !== 'upload_file') throw new AgentError('SENSITIVE_FIELD', 'Only a person can use this sensitive field.');
    const revision = target?.revision ?? await driver.run<string>('revision', {}, signal);
    const typing = input as AgentInput<'type'>;
    const element = target ? { ...target, submit: target.submit || (method === 'type' && Boolean(typing.submit)) } : undefined;
    if (element?.submit && element.formTarget && agentUrl(element.formTarget).origin !== url.origin) {
      throw new AgentError('FORM_ORIGIN', 'Only same-origin form targets can be used by an agent.');
    }
    const consequential = consequentialAction(method, url, element);
    if (method === 'upload_file' && !client.uploadFolder) {
      throw new AgentError('UPLOAD_FOLDER_REQUIRED', 'Grant an upload folder in Settings → Agents.');
    }
    if (consequential) await this.confirm(live, request, { tab, target, revision });
    connection.abort.throwIfAborted();
    if (method === 'upload_file') {
      if (!client.uploadFolder) throw new AgentError('UPLOAD_FOLDER_REQUIRED', 'Grant an upload folder in Settings → Agents.');
      const file = await stageAgentUpload(client.uploadFolder, (input as AgentInput<'upload_file'>).path, this.options.data);
      try { await driver.upload(ref!, revision, file.path, signal); } catch (error) { await file.clean(); throw error; }
      this.workspace.retainUpload(tab.id, file.clean);
      return { selected: true };
    }
    if (consequential && element?.submit && element.formTarget && element.formMethod?.toUpperCase() === 'POST') {
      const destination = agentUrl(element.formTarget);
      destination.hash = '';
      tab.requestGrant = { method: 'POST', url: destination.href, until: Date.now() + 4_000 };
    }
    if (consequential && target?.link) {
      const destination = agentUrl(target.link);
      this.allowNavigation(client.policy, destination);
      tab.navigationGrant = { origin: destination.origin, until: Date.now() + 4_000 };
    }
    const command = ACTIONS[method];
    if (!command) throw new AgentError('UNSUPPORTED_ACTION', 'This action is unavailable on the selected tab.');
    try {
      const result = await driver.action(command, input as object, revision, signal);
      if (target) live.recording?.action(method, target, input as AgentInput<'type'>);
      return result ? untrusted(result) : { completed: true };
    } catch (error) {
      tab.navigationGrant = undefined;
      tab.requestGrant = undefined;
      throw error;
    }
  }

  private async confirm(
    live: Live, request: AgentRequest, details: { tab?: AgentTab; destination?: URL; target?: TargetDetails; revision?: string; allowSession?: boolean; dialog?: boolean },
  ): Promise<void> {
    const { tab, destination, target, allowSession } = details;
    const origin = destination?.origin ?? tab?.origin;
    if (!origin) throw new AgentError('ORIGIN_REQUIRED', 'The action needs a web origin.');
    if (allowSession && live.trustedOrigins.has(origin)) return;
    const connection = live.connection;
    const readRevision = () => details.dialog ? tab!.driver.dialogRevision() : tab ? tab.driver.run<string>('revision', {}, connection.abort) : 'new-tab';
    const context = {
      session: connection.id, tab: tab?.id ?? 'new-tab', url: tab?.view.webContents.getURL() ?? destination?.href ?? origin,
      revision: details.revision ?? await readRevision(), method: request.method, input: request.input,
    };
    const proof = new AgentConfirmation(context);
    await this.workspace.show();
    connection.abort.throwIfAborted();
    if (this.pending) throw new AgentError('CONFIRMATION_BUSY', 'The owner is reviewing another action. Try again shortly.');
    const decision = await new Promise<AgentDecision>((resolve) => {
      const abort = () => finish('deny');
      const finish = (decision: AgentDecision) => {
        connection.abort.removeEventListener('abort', abort);
        clearTimeout(timer);
        this.pending = undefined;
        this.workspace.setHidden(false);
        this.changed();
        resolve(decision);
      };
      const timer = setTimeout(abort, Math.max(0, proof.expiresAt - Date.now()));
      connection.abort.addEventListener('abort', abort, { once: true });
      this.pending = { connection, finish, card: {
        id: proof.id, client: connection.device.name, action: request.method.replaceAll('_', ' '),
        tab: tab?.origin ?? 'New Agent tab', origin, expiresAt: proof.expiresAt, canAllowSession: Boolean(allowSession),
        target: target ? clean(`${target.role}: ${target.name}`, 300) : destination ? cleanUrl(destination.href) : undefined,
        input: request.method === 'upload_file' ? clean((request.input as AgentInput<'upload_file'>).path, 500)
          : 'text' in (request.input as object) ? '[typed text hidden]' : undefined,
        formTarget: target?.formTarget ? cleanUrl(target.formTarget) : undefined,
      } };
      this.workspace.setHidden(true);
      this.changed();
    });
    if (decision === 'deny') throw new AgentError('ACTION_DENIED', 'The action was denied or its confirmation expired.');
    connection.abort.throwIfAborted();
    if (tab?.manual || !proof.spend({ ...context, url: tab?.view.webContents.getURL() ?? context.url, revision: await readRevision() })) {
      throw new AgentError('PAGE_CHANGED', 'The page changed while awaiting approval. Get a fresh snapshot.');
    }
    if (decision === 'session') live.trustedOrigins.add(origin);
  }

  private async devServers(signal: AbortSignal): Promise<string[]> {
    const known = await this.options.discover().catch(() => []);
    const allowed = known.filter((value) => { try { return agentLoopback(agentUrl(value)); } catch { return false; } });
    if (allowed.length) return [...new Set(allowed.map((value) => new URL(value).origin))].slice(0, 16);
    const ports = [3000, 3001, 4173, 5173, 8000, 8080, 8787];
    const results = await Promise.all(ports.map(async (port) => {
      const origin = `http://127.0.0.1:${port}`;
      try { await fetch(origin, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(750)]) }); return origin; }
      catch { return undefined; }
    }));
    return results.filter((value): value is string => Boolean(value));
  }

  private authorize(device: Device, code?: string): number | undefined {
    if (!this.state?.enabled || this.paused || this.unavailable) return undefined;
    if (this.active.has(device.id) || this.active.size >= 8) return undefined;
    const stored = this.state.clients.find((item) => item.id === device.id);
    if (stored) {
      if (code || stored.name !== device.name || stored.publicKey !== device.publicKey) return undefined;
    } else {
      const pairing = this.pairing;
      if (!pairing || !code || pairing.expiresAt <= Date.now() || pairing.attempts >= 5 || this.state.clients.length >= 12) return undefined;
      pairing.attempts += 1;
      if (!safeEqual(pairing.code, code)) return undefined;
      this.pairing = undefined;
      this.persist({ ...this.state, clients: [...this.state.clients, { ...device, policy: DEFAULT_AGENT_POLICY }] });
    }
    const expiresAt = this.leases.get(device.id) ?? Date.now() + AGENT_SESSION_MS;
    this.leases.set(device.id, expiresAt);
    return expiresAt;
  }

  private allowNavigation(policy: AgentPolicy, url: URL): void {
    if (agentAccess(policy, url) === 'deny') throw new AgentError('ORIGIN_DENIED', 'This origin is outside the client’s allowlist.');
  }

  private replaceClient(id: string, patch: Partial<Pick<StoredClient, 'policy' | 'uploadFolder'>>): void {
    const state = this.state;
    if (!state?.clients.some((client) => client.id === id)) throw new Error('That client is no longer paired.');
    this.persist({ ...state, clients: state.clients.map((client) => client.id === id ? { ...client, ...patch } : client) });
    this.disconnect(id);
    this.changed();
  }

  private disconnect(id: string): void {
    const live = this.active.get(id);
    if (live) live.connection.close();
    this.active.delete(id);
    this.leases.delete(id);
    if (this.pending?.connection.device.id === id) this.pending.finish('deny');
  }

  private requireEnabled(): StoredState {
    if (!this.state?.enabled || !this.pipe || this.paused || this.unavailable) {
      throw new AgentError('MODE_DISABLED', 'Turn on or resume Agent Mode in Settings → Agents.');
    }
    return this.state;
  }

  private persist(state: StoredState): void { writeAgentFile(this.statePath, state); this.state = state; }
  private changed(): void { this.workspace.broadcast(); this.options.onChange(); }
}
