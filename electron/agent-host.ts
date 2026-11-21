import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dialog, type BrowserWindow } from 'electron';
import { generateIdentity, safeEqual, type DeviceIdentity } from '@private-browser/bridge-protocol';
import {
  AGENT_ACTIONS_PER_MINUTE, AGENT_IDLE_MS, AGENT_MAX_TABS, AGENT_PROTOCOL_VERSION,
  agentIdentity, type AgentInput, type AgentMethod,
} from '@private-browser/bridge-protocol/agent';
import { AgentAudit, agentStorageAvailable, readAgentFile, writeAgentFile } from './agent-audit.js';
import { AgentPipe, type AgentConnection, type AgentRequest } from './agent-pipe.js';
import {
  agentAccess, AgentConfirmation, agentError, AgentError, agentLoopback, agentSessionMs, agentUrl,
  consequentialAction, DEFAULT_AGENT_POLICY, exactAgentOrigin, isAgentSessionLength, MAX_AGENT_ORIGINS, type AgentPolicy,
} from './agent-policy.js';
import { agentTabUrl, AgentWorkspace, type AgentSpace, type AgentTab } from './agent-workspace.js';
import { clean, cleanUrl, untrusted, type TargetDetails } from './agent-driver.js';
import { AgentRecording } from './agent-recording.js';
import { AgentLentTab, type LendableTab } from './agent-lent-tab.js';
import { stageAgentUpload, verifyUploadFolder } from './agent-upload.js';
import type { AgentConfirmationCard, AgentDecision, AgentUiStatus } from './agent-types.js';

type Device = ReturnType<typeof agentIdentity.parse>['device'];
type StoredClient = Device & { policy: AgentPolicy; uploadFolder?: string; rememberedOrigins?: string[] };
type StoredState = { enabled: boolean; identity: DeviceIdentity; clients: StoredClient[]; spaces: AgentSpace[] };
type SerializedState = Omit<StoredState, 'clients'> & {
  clients: (Omit<StoredClient, 'policy'> & { policy: Omit<AgentPolicy, 'session'> & { session?: unknown } })[];
};
type Live = {
  connection: AgentConnection;
  selected?: string;
  step: AgentMethod | 'ready';
  trustedOrigins: Set<string>;
  recording?: AgentRecording;
  tabRecordings: Map<string, AgentRecording>;
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
  private loan?: AgentLentTab;
  private pairing?: { code: string; expiresAt: number; attempts: number };
  private readonly active = new Map<string, Live>();
  private readonly leases = new Map<string, number>();
  private readonly resetting = new Set<string>();

  constructor(private readonly options: Options) {
    this.statePath = join(options.data, 'clients.enc');
    this.workspace = new AgentWorkspace(options.chromeUrl, options.preload, join(options.data, 'downloads'), () => this.changed(), () => this.stop());
    try {
      if (!agentStorageAvailable()) throw new Error();
      const stored = readAgentFile<SerializedState>(this.statePath);
      this.state = stored && {
        ...stored,
        clients: stored.clients.map(({ policy, ...client }) => ({
          ...client,
          policy: { ...policy, session: isAgentSessionLength(policy.session) ? policy.session : DEFAULT_AGENT_POLICY.session },
        })),
      };
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
        this.active.set(connection.device.id, { connection, step: 'ready', trustedOrigins: new Set(), tabRecordings: new Map() });
        this.changed();
      },
      closed: (connection) => {
        if (this.loan?.tab.connection === connection) this.returnLentTab();
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
      clients: (state?.clients ?? []).map(({ id, name, policy, uploadFolder }) => ({
        id, name, policy, uploadFolder, active: this.active.has(id), expiresAt: this.leases.get(id),
      })),
      spaces: state?.spaces ?? [], current, pending: this.pending?.card,
      tabs: this.workspace.summaries(), selectedTab: this.workspace.selected,
      active: this.active.size > 0, audit: this.audit?.list() ?? [], command: this.options.command, commandArgs: this.options.commandArgs,
      lent: this.loan?.valid() ? {
        tabId: this.loan.source.tabId, client: this.loan.tab.connection.device.name, origin: this.loan.origin, expiresAt: this.loan.expiresAt,
      } : undefined,
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
    this.returnLentTab();
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

  async lendTab(source: LendableTab, clientId: string): Promise<void> {
    const state = this.requireEnabled();
    const live = this.active.get(clientId);
    const client = state.clients.find(({ id }) => id === clientId);
    if (!client || !live || live.connection.abort.aborted || live.step !== 'ready') {
      throw new AgentError('CLIENT_UNAVAILABLE', 'Connect a paired client and wait for its current step to finish.');
    }
    if (this.loan) throw new AgentError('LOAN_ACTIVE', 'End the current tab loan before lending another tab.');
    const loan = new AgentLentTab(source, live.connection, client.policy, () => this.returnLentTab());
    this.loan = loan;
    live.selected = loan.tab.id;
    this.changed();
    try {
      await loan.tab.driver.initialize();
      if (!loan.valid()) throw new AgentError('LOAN_ENDED', 'The tab loan ended.');
    } catch (error) {
      if (this.loan === loan) this.returnLentTab();
      throw error;
    }
  }

  returnLentTab(tabId?: string): void {
    const loan = this.loan;
    if (!loan || tabId && loan.source.tabId !== tabId) return;
    this.loan = undefined;
    loan.return();
    const live = this.active.get(loan.tab.connection.device.id);
    live?.tabRecordings.delete(loan.tab.id);
    if (live?.selected === loan.tab.id) live.selected = this.workspace.forConnection(loan.tab.connection)[0]?.id;
    this.changed();
  }

  validateLentTab(): void { if (this.loan && !this.loan.valid()) this.returnLentTab(); }

  isLentContents(contentsId?: number): boolean {
    return Boolean(contentsId && this.loan?.contentsId === contentsId);
  }

  allowLentRequest(details: { webContentsId?: number; url: string; method: string; resourceType: string }): boolean {
    const loan = this.loan;
    if (!loan || !this.isLentContents(details.webContentsId)) return true;
    if (details.resourceType === 'mainFrame' && !loan.sameOrigin(details.url)) {
      this.returnLentTab();
      return false;
    }
    const method = details.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return true;
    const grant = loan.tab.requestGrant;
    if (!grant || grant.until < Date.now() || grant.method !== method || !loan.sameOrigin(details.url)) return false;
    const target = new URL(details.url);
    target.hash = '';
    if (target.href !== grant.url) return false;
    loan.tab.requestGrant = undefined;
    return true;
  }

  private lookupTab(connection: AgentConnection, id?: string): AgentTab | undefined {
    if (!id) return undefined;
    if (this.loan?.tab.id === id && this.loan.tab.connection === connection && this.loan.valid()) return this.loan.tab;
    const tab = this.workspace.get(id);
    return tab?.connection === connection ? tab : undefined;
  }

  private ownTab(connection: AgentConnection, id?: string): AgentTab {
    const tab = this.lookupTab(connection, id);
    if (!tab || tab.manual || connection.abort.aborted) throw new AgentError('TAB_UNAVAILABLE', 'Select a tab owned by this session.');
    return tab;
  }

  renew(id: string): void {
    if (!this.requireEnabled().clients.some((client) => client.id === id)) throw new Error('That client is no longer paired.');
    this.disconnect(id);
    this.changed();
  }

  setPolicy(id: string, policy: AgentPolicy): void {
    const origins = [...new Set(policy.origins.map(exactAgentOrigin))];
    const client = this.state?.clients.find((candidate) => candidate.id === id);
    this.replaceClient(id, {
      policy: { ...policy, origins },
      rememberedOrigins: client?.rememberedOrigins?.filter((origin) => origins.includes(origin)),
    });
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
    if (!pending || pending.card.id !== id) return;
    if (decision === 'session' && !pending.card.canAllowSession) return;
    if (decision === 'always' && !pending.card.canAllowAlways) return;
    pending.finish(decision);
  }

  private async request(connection: AgentConnection, request: AgentRequest): Promise<unknown> {
    const live = this.active.get(connection.device.id);
    const client = this.state?.clients.find(({ id }) => id === connection.device.id);
    if (!live || !client || live.connection !== connection || connection.abort.aborted || !this.audit) throw new AgentError('SESSION_CLOSED', 'This session ended.');
    this.validateLentTab();
    const scope = (request.input as { tabId?: string }).tabId;
    const tab = this.lookupTab(connection, scope ?? live.selected);
    const loanSignal = tab === this.loan?.tab ? this.loan?.controller.signal : undefined;
    const origin = tab?.origin;
    let allowed = false;
    let code = 'completed';
    live.step = request.method;
    this.changed();
    try {
      const result = await this.dispatch(live, client, request);
      connection.abort.throwIfAborted();
      if (!['tab_open', 'tab_select', 'tab_close'].includes(request.method)) loanSignal?.throwIfAborted();
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
      enabled: true, client: client.name, activeSpace: this.lookupTab(connection, live.selected)?.space.name,
      allowedOrigins: client.policy.origins, profile: client.policy.profile, protocolVersion: AGENT_PROTOCOL_VERSION, outside: client.policy.outside,
      limits: { actionsPerMinute: AGENT_ACTIONS_PER_MINUTE, tabs: AGENT_MAX_TABS, idleMs: AGENT_IDLE_MS, expiresAt: connection.expiresAt },
      spaces: state.spaces,
    };
    if (method === 'tabs_list') {
      const lent = this.loan?.tab.connection === connection && this.loan.valid() ? [this.loan.tab] : [];
      return untrusted([...this.workspace.forConnection(connection), ...lent].map((tab) => ({
        tabId: tab.id, url: agentTabUrl(tab), selected: tab.id === live.selected, space: tab.space.name,
        manual: tab.manual, label: tab.label, lent: lent.includes(tab),
      })));
    }
    if (method === 'tab_open') {
      const { url, space: id, label } = input as AgentInput<'tab_open'>;
      const target = agentUrl(url);
      const space = id ? state.spaces.find((item) => item.id === id) : state.spaces[0];
      if (!space || this.resetting.has(space.id)) throw new AgentError('SPACE_UNAVAILABLE', 'Choose an available Agent Account Space.');
      if (this.workspace.forConnection(connection).length >= AGENT_MAX_TABS) throw new AgentError('TAB_LIMIT', 'Close an agent tab before opening another.');
      this.allowNavigation(client.policy, target);
      // Only an already-loaded copy in this client's space can be reviewed for a permanent grant.
      const reviewedTab = this.workspace.forConnection(connection).find((tab) => tab.space.id === space.id
        && !tab.manual && !tab.view.webContents.isDestroyed() && tab.view.webContents.getURL() === target.href);
      const approvedPolicy = await this.confirm(live, request, { destination: target, allowSession: true, reviewedTab });
      if (this.resetting.has(space.id)) throw new AgentError('SPACE_UNAVAILABLE', 'The Agent Account Space is resetting.');
      if (this.loan?.tab.connection === connection) this.returnLentTab();
      const tab = await this.workspace.create(space, connection, approvedPolicy ?? client.policy, label);
      live.selected = tab.id;
      try { await this.workspace.load(tab, target); } catch (error) { this.workspace.close(tab.id); throw error; }
      live.recording?.navigate(target.href);
      return untrusted({ tabId: tab.id, url: agentTabUrl(tab), space: space.name, label });
    }
    if (method === 'tab_select' || method === 'tab_close') {
      const tab = this.ownTab(connection, (input as AgentInput<'tab_select'>).tabId);
      if (tab === this.loan?.tab) {
        if (method === 'tab_close') this.returnLentTab();
        else live.selected = tab.id;
      } else if (method === 'tab_close') {
        live.tabRecordings.delete(tab.id);
        this.workspace.close(tab.id);
      } else {
        if (this.loan?.tab.connection === connection) this.returnLentTab();
        live.selected = tab.id;
        this.workspace.select(tab.id);
      }
      return { tabId: tab.id };
    }
    if (method === 'dev_servers') return { origins: await this.devServers(connection.abort) };
    const explicit = (input as { tabId?: string }).tabId;
    const recordingTab = explicit ? this.ownTab(connection, explicit) : this.lookupTab(connection, live.selected);
    if (method === 'record_start') {
      const recording = new AgentRecording(recordingTab?.origin && recordingTab.view.webContents.getURL());
      if (explicit) live.tabRecordings.set(explicit, recording);
      else live.recording = recording;
      return { recording: true };
    }
    if (method === 'record_stop') {
      const recording = explicit ? live.tabRecordings.get(explicit) : live.recording;
      if (!recording) throw new AgentError('NO_RECORDING', 'Start a recording first.');
      const output = untrusted({ playwright: recording.finish() });
      if (explicit) live.tabRecordings.delete(explicit);
      else live.recording = undefined;
      return output;
    }

    const tab = this.ownTab(connection, explicit ?? live.selected);
    const loan = tab === this.loan?.tab ? this.loan : undefined;
    const recording = live.tabRecordings.get(tab.id) ?? live.recording;
    const contents = tab.view.webContents;
    const url = agentUrl(contents.getURL());
    this.allowNavigation(tab.policy, url);
    const requireLoanOrigin = (destination: URL) => {
      if (!loan || loan.sameOrigin(destination.href)) return;
      this.returnLentTab();
      throw new AgentError('LOAN_ORIGIN', 'The tab loan ended at its origin boundary.');
    };
    if (method === 'navigate') {
      const target = agentUrl((input as AgentInput<'navigate'>).url);
      requireLoanOrigin(target);
      this.allowNavigation(tab.policy, target);
      if (loan && agentAccess(tab.policy, url) !== 'drive') throw new AgentError('READ_ONLY', 'This client can only read this tab.');
      if (loan || target.origin !== url.origin) await this.confirm(live, request, { tab, destination: target, allowSession: !loan });
      await this.workspace.load(tab, target, loan?.controller.signal);
      recording?.navigate(target.href);
      return untrusted({ url: agentTabUrl(tab) });
    }
    if (!READ.has(method) && agentAccess(tab.policy, url) !== 'drive') throw new AgentError('READ_ONLY', 'This client can only read pages at this origin.');
    if (loan && ['downloads_list', 'emulate', 'evaluate'].includes(method)) {
      throw new AgentError('LOAN_RESTRICTED', 'Use an Agent Account Space for this tool.');
    }
    if (method === 'go_back' || method === 'go_forward') {
      const history = contents.navigationHistory;
      const delta = method === 'go_back' ? -1 : 1;
      const targetIndex = history.getActiveIndex() + delta;
      const destination = history.getEntryAtIndex(targetIndex);
      if (!destination) throw new AgentError('HISTORY_EMPTY', 'There is no navigation in that direction.');
      const target = agentUrl(destination.url);
      requireLoanOrigin(target);
      this.allowNavigation(tab.policy, target);
      if (loan || url.origin !== target.origin) await this.confirm(live, request, { tab, destination: target, allowSession: !loan });
      tab.navigationGrant = { origin: target.origin, until: Date.now() + 4_000 };
      history.goToIndex(targetIndex);
      recording?.step(method === 'go_back' ? 'goBack' : 'goForward');
      return { started: true };
    }
    if (method === 'reload') {
      if (loan) await this.confirm(live, request, { tab });
      contents.reload();
      recording?.step('reload');
      return { started: true };
    }

    const signal = loan?.controller.signal ?? connection.abort;
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
    if (element?.link) requireLoanOrigin(agentUrl(element.link));
    const consequential = Boolean(loan) || consequentialAction(method, url, element);
    if (method === 'upload_file' && !client.uploadFolder) {
      throw new AgentError('UPLOAD_FOLDER_REQUIRED', 'Grant an upload folder in Settings → Agents.');
    }
    if (consequential) await this.confirm(live, request, { tab, target, revision });
    connection.abort.throwIfAborted();
    if (method === 'upload_file') {
      if (!client.uploadFolder) throw new AgentError('UPLOAD_FOLDER_REQUIRED', 'Grant an upload folder in Settings → Agents.');
      const file = await stageAgentUpload(client.uploadFolder, (input as AgentInput<'upload_file'>).path, this.options.data);
      try { await driver.upload(ref!, revision, file.path, signal); } catch (error) { await file.clean(); throw error; }
      if (loan) loan.retainUpload(file.clean);
      else this.workspace.retainUpload(tab.id, file.clean);
      return { selected: true };
    }
    if (consequential && element?.submit && element.formTarget && element.formMethod?.toUpperCase() === 'POST') {
      const destination = agentUrl(element.formTarget);
      destination.hash = '';
      tab.requestGrant = { method: 'POST', url: destination.href, until: Date.now() + 4_000 };
    }
    if (consequential && target?.link) {
      const destination = agentUrl(target.link);
      this.allowNavigation(tab.policy, destination);
      tab.navigationGrant = { origin: destination.origin, until: Date.now() + 4_000 };
    }
    const command = ACTIONS[method];
    if (!command) throw new AgentError('UNSUPPORTED_ACTION', 'This action is unavailable on the selected tab.');
    try {
      const result = await driver.action(command, input as object, revision, signal);
      if (target) recording?.action(method, target, input as AgentInput<'type'>);
      return result ? untrusted(result) : { completed: true };
    } catch (error) {
      tab.navigationGrant = undefined;
      tab.requestGrant = undefined;
      throw error;
    }
  }

  private async confirm(
    live: Live, request: AgentRequest, details: {
      tab?: AgentTab; destination?: URL; target?: TargetDetails; revision?: string;
      allowSession?: boolean; dialog?: boolean; reviewedTab?: AgentTab;
    },
  ): Promise<AgentPolicy | undefined> {
    const { tab, destination, target, allowSession } = details;
    const origin = destination?.origin ?? tab?.origin;
    if (!origin) throw new AgentError('ORIGIN_REQUIRED', 'The action needs a web origin.');
    if (allowSession && live.trustedOrigins.has(origin)) return;
    const connection = live.connection;
    const loan = tab === this.loan?.tab ? this.loan : undefined;
    const signal = loan?.controller.signal ?? connection.abort;
    const readRevision = () => details.dialog ? tab!.driver.dialogRevision() : tab ? tab.driver.run<string>('revision', {}, signal) : 'new-tab';
    const context = {
      session: connection.id, tab: tab?.id ?? 'new-tab', url: tab?.view.webContents.getURL() ?? destination?.href ?? origin,
      revision: details.revision ?? await readRevision(), method: request.method, input: request.input,
    };
    const proof = new AgentConfirmation(context);
    const reviewedTab = request.method === 'tab_open' ? details.reviewedTab : undefined;
    const client = reviewedTab && this.state?.clients.find(({ id }) => id === connection.device.id);
    const reviewRevision = client && reviewedTab && destination
      ? await this.siteApprovalRevision(reviewedTab, destination) : null;
    if (reviewRevision && client?.policy.origins.includes(origin) && client.rememberedOrigins?.includes(origin)) {
      signal.throwIfAborted();
      return;
    }
    const canAllowAlways = Boolean(reviewRevision && client && origin.length <= 300
      && (client.policy.origins.includes(origin) || client.policy.origins.length < MAX_AGENT_ORIGINS));
    await this.workspace.show();
    signal.throwIfAborted();
    if (this.pending) throw new AgentError('CONFIRMATION_BUSY', 'The owner is reviewing another action. Try again shortly.');
    const decision = await new Promise<AgentDecision>((resolve) => {
      const abort = () => finish('deny');
      const finish = (decision: AgentDecision) => {
        signal.removeEventListener('abort', abort);
        clearTimeout(timer);
        this.pending = undefined;
        this.workspace.setHidden(false);
        this.changed();
        resolve(decision);
      };
      const timer = setTimeout(abort, Math.max(0, proof.expiresAt - Date.now()));
      signal.addEventListener('abort', abort, { once: true });
      this.pending = { connection, finish, card: {
        id: proof.id, client: connection.device.name, action: request.method.replaceAll('_', ' '),
        tab: loan ? `Lent tab · ${loan.origin}` : tab?.label ?? tab?.origin ?? 'New Agent tab',
        origin, expiresAt: proof.expiresAt, canAllowSession: Boolean(allowSession), canAllowAlways,
        target: target ? clean(`${target.role}: ${target.name}`, 300) : destination ? cleanUrl(destination.href) : undefined,
        input: request.method === 'upload_file' ? clean((request.input as AgentInput<'upload_file'>).path, 500)
          : 'text' in (request.input as object) ? '[typed text hidden]' : undefined,
        formTarget: target?.formTarget ? cleanUrl(target.formTarget) : undefined,
      } };
      this.workspace.setHidden(true);
      this.changed();
    });
    if (decision === 'deny') throw new AgentError('ACTION_DENIED', 'The action was denied or its confirmation expired.');
    signal.throwIfAborted();
    if (tab?.manual || !proof.spend({ ...context, url: tab?.view.webContents.getURL() ?? context.url, revision: await readRevision() })) {
      throw new AgentError('PAGE_CHANGED', 'The page changed while awaiting approval. Get a fresh snapshot.');
    }
    if (decision === 'session') live.trustedOrigins.add(origin);
    if (decision === 'always') {
      if (!canAllowAlways || !client || !reviewedTab || !destination
        || await this.siteApprovalRevision(reviewedTab, destination) !== reviewRevision) {
        throw new AgentError('PAGE_CHANGED', 'The page changed while awaiting approval. Get a fresh snapshot.');
      }
      signal.throwIfAborted();
      const exactOrigin = exactAgentOrigin(origin);
      const policy = { ...client.policy, origins: [...new Set([...client.policy.origins, exactOrigin])] };
      const rememberedOrigins = [...new Set([...(client.rememberedOrigins ?? []), exactOrigin])];
      this.replaceClient(client.id, { policy, rememberedOrigins }, { keepConnection: true });
      for (const ownedTab of this.workspace.forConnection(connection)) ownedTab.policy = policy;
      return policy;
    }
  }

  private async siteApprovalRevision(tab: AgentTab, destination: URL): Promise<string | null> {
    const contents = tab.view.webContents;
    const isCurrent = () => this.workspace.get(tab.id) === tab && !tab.manual && !contents.isDestroyed()
      && !contents.isLoadingMainFrame() && contents.getURL() === destination.href;
    if (!isCurrent()) return null;
    const revision = await tab.driver.run<string | null>('siteApprovalRevision', {}, tab.connection.abort).catch(() => null);
    return isCurrent() ? revision : null;
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
    const now = Date.now();
    const session = stored?.policy.session ?? DEFAULT_AGENT_POLICY.session;
    const lease = this.leases.get(device.id);
    // Preserve the explicit renewal requirement for the original one-hour policy.
    if (session === '1h' && lease !== undefined && lease <= now) return undefined;
    const expiresAt = session !== 'open' && lease !== undefined && lease > now
      ? lease : now + agentSessionMs(session);
    this.leases.set(device.id, expiresAt);
    return expiresAt;
  }

  private allowNavigation(policy: AgentPolicy, url: URL): void {
    if (agentAccess(policy, url) === 'deny') throw new AgentError('ORIGIN_DENIED', 'This origin is outside the client’s allowlist.');
  }

  private replaceClient(
    id: string, patch: Partial<Pick<StoredClient, 'policy' | 'uploadFolder' | 'rememberedOrigins'>>, options: { keepConnection?: boolean } = {},
  ): void {
    const state = this.state;
    if (!state?.clients.some((client) => client.id === id)) throw new Error('That client is no longer paired.');
    this.persist({ ...state, clients: state.clients.map((client) => client.id === id ? { ...client, ...patch } : client) });
    if (!options.keepConnection) this.disconnect(id);
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
