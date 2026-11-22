import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { copyFileSync, constants } from 'node:fs';
import { dialog, type BrowserWindow } from 'electron';
import { generateIdentity, safeEqual } from '@private-browser/bridge-protocol';
import {
  AGENT_PROTOCOL_VERSION, agentTools, agentIdentity, type AgentInput, type AgentMethod,
} from '@private-browser/bridge-protocol/agent';
import { agentSessionCap, agentSessionCapSettings, agentSpaceSettings, clientLimits, type AgentSpaceSettings, type ClientLimits } from '@private-browser/bridge-protocol/agent-permissions';
import { allowedSpaceOrigin, canRememberNavigation, decide, describeSpace, makeSpace, normalizeSpaceSettings, pruneRememberedOrigins, requireDecision, type SpacePolicy } from './agent-space-policy.js';
import { applyClientLimits, loadAgentState, newAgentClient, newAgentState, type StoredClient, type StoredState } from './agent-state.js';
import { AgentAudit, agentStorageAvailable, readAgentFile, writeAgentFile } from './agent-audit.js';
import { AgentPipe, type AgentConnection, type AgentRequest } from './agent-pipe.js';
import { AgentConfirmation, agentError, AgentError, AgentRateLimit, agentLoopback, agentUrl, consequentialAction } from './agent-policy.js';
import { agentTabUrl, AgentWorkspace, type AgentTab } from './agent-workspace.js';
import { clean, cleanUrl, untrusted, type TargetDetails } from './agent-driver.js';
import { AgentRecording } from './agent-recording.js';
import { AgentLentTab, type LendableTab } from './agent-lent-tab.js';
import { stageAgentUpload, verifyUploadFolder } from './agent-upload.js';
import type { AgentConfirmationCard, AgentDecision, AgentUiStatus } from './agent-types.js';

type Device = ReturnType<typeof agentIdentity.parse>['device'];
type Live = {
  connection: AgentConnection;
  selected?: string;
  step: AgentMethod | 'ready';
  trustedOrigins: Set<string>;
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
};

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
  private readonly rates = new Map<string, AgentRateLimit>();
  private readonly resetting = new Set<string>();

  constructor(private readonly options: Options) {
    this.statePath = join(options.data, 'clients.enc');
    this.workspace = new AgentWorkspace(options.chromeUrl, options.preload, join(options.data, 'downloads'), () => this.changed(), () => this.stop(),
      (domain) => Boolean(this.state?.spaces.some((space) => space.trust === 'work' && space.origins.some((value) => {
        const host = new URL(value.replace('://*.', '://')).hostname;
        return host === domain || host.endsWith('.' + domain) || value.includes('://*.') && domain.endsWith('.' + host);
      }))));
    try {
      if (!agentStorageAvailable()) throw new Error();
      const saved = readAgentFile<unknown>(this.statePath);
      if (saved !== undefined) {
        const { state, migrated } = loadAgentState(saved, Date.now());
        if (migrated) {
          try { copyFileSync(this.statePath, this.statePath + '.bak', constants.COPYFILE_EXCL); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
          this.persist(state);
        } else this.state = state;
      }
      this.audit = new AgentAudit(join(options.data, 'audit.enc'), (this.state?.spaces ?? []).map((space) => space.id));
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
      takeAction: (connection) => this.takeAction(connection),
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
      sessionCapMs: state?.sessionCapMs ?? agentSessionCapSettings.default,
      clients: (state?.clients ?? []).map(({ id, name, limits, expiresAt }) => ({ id, name, limits, expiresAt, active: this.active.has(id) })),
      possibleSignIn: this.workspace.possibleSignIn(),
      spaces: (state?.spaces ?? []).map(({ uploadRoot, legacy, rememberedOrigins, ...space }) => ({ ...space, uploadRootPresent: Boolean(uploadRoot), migrated: Boolean(legacy) })), current, pending: this.pending?.card,
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
    const initial = this.state ?? newAgentState(generateIdentity());
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
    this.workspace.closeAll();
    this.pipe?.stop();
    this.pipe = undefined;
    this.changed();
  }

  revoke(id: string): void {
    const state = this.state;
    if (!state) return;
    const spaces = state.spaces.map(({ legacy, ...space }) => {
      const updated = {
        ...space, clientIds: space.clientIds.filter((clientId) => clientId !== id),
        legacy: legacy && Object.fromEntries(Object.entries(legacy).filter(([clientId]) => clientId !== id)),
      };
      return { ...updated, rememberedOrigins: pruneRememberedOrigins(updated) };
    });
    this.persist({ ...state, clients: state.clients.filter((client) => client.id !== id), spaces });
    this.rates.delete(id);
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
    const loan = new AgentLentTab(source, live.connection, () => this.returnLentTab());
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
    const client = this.requireEnabled().clients.find((item) => item.id === id);
    if (!client) throw new Error('That client is no longer paired.');
    const sessionStartedAt = Date.now();
    this.replaceClient(id, { sessionStartedAt, expiresAt: sessionStartedAt + client.limits.sessionMs });
  }

  setLimits(id: string, limits: ClientLimits): void {
    const state = this.requireEnabled();
    const client = state.clients.find((item) => item.id === id);
    if (!client) throw new Error('That client is no longer paired.');
    const updated = applyClientLimits(client, clientLimits.parse(limits), state.sessionCapMs);
    this.replaceClient(id, { limits: updated.limits, expiresAt: updated.expiresAt });
  }

  setSessionCap(value: number): void {
    const state = this.requireEnabled();
    const sessionCapMs = agentSessionCap.parse(value);
    if (sessionCapMs === state.sessionCapMs) return;
    const affected = state.clients.filter((client) => client.limits.sessionMs > sessionCapMs);
    const clients = state.clients.map((client) => client.limits.sessionMs > sessionCapMs
      ? applyClientLimits(client, client.limits, sessionCapMs) : client);
    this.persist({ ...state, sessionCapMs, clients });
    for (const { id } of affected) this.disconnect(id);
    this.changed();
  }

  setSpace(id: string, input: AgentSpaceSettings): void {
    const state = this.requireEnabled();
    const existing = state.spaces.find((item) => item.id === id);
    const settings = normalizeSpaceSettings(agentSpaceSettings.parse(input));
    if (!existing || existing.trust !== settings.trust || settings.clientIds.some((clientId) => !state.clients.some((client) => client.id === clientId))) {
      throw new Error('Choose an existing Agent Account Space and paired clients.');
    }
    // A trusted save replaces the migrated per-client rules for this space.
    const updated = { ...settings, id, uploadRoot: existing.uploadRoot };
    this.replaceSpace({ ...updated, rememberedOrigins: pruneRememberedOrigins(updated, existing.rememberedOrigins) });
  }

  async grantUploadFolder(id: string): Promise<void> {
    if (!this.requireEnabled().spaces.some((item) => item.id === id)) throw new Error('That space is unavailable.');
    const parent = this.options.parent();
    const options: Electron.OpenDialogOptions = { title: 'Choose a folder for agent uploads', properties: ['openDirectory'] };
    const selected = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
    if (selected.canceled || !selected.filePaths[0]) return;
    const uploadRoot = await verifyUploadFolder(selected.filePaths[0], this.options.data);
    const space = this.requireEnabled().spaces.find((item) => item.id === id);
    if (!space) throw new Error('That space is unavailable.');
    this.replaceSpace({ ...space, uploadRoot });
  }

  revokeUploadFolder(id: string): void {
    const space = this.requireEnabled().spaces.find((item) => item.id === id);
    if (!space) throw new Error('That space is unavailable.');
    this.replaceSpace({ ...space, uploadRoot: undefined });
  }

  addSpace(name: string): void {
    const state = this.requireEnabled();
    if (state.spaces.length >= 9) throw new Error('Agent Mode supports up to nine spaces.');
    const space = makeSpace(randomUUID(), name.trim(), 'work');
    this.persist({ ...state, spaces: [...state.spaces, space] });
    this.changed();
  }

  async resetSpace(id: string): Promise<void> {
    const space = this.requireEnabled().spaces.find((candidate) => candidate.id === id);
    if (!space || this.resetting.has(id)) throw new Error('That Agent Account Space is unavailable.');
    this.resetting.add(id);
    try { await this.workspace.reset(space); } finally { this.resetting.delete(id); }
    this.changed();
  }

  async clearOpenWeb(id: string): Promise<void> {
    const space = this.requireEnabled().spaces.find((item) => item.id === id);
    if (!space || space.trust !== 'open-web' || !this.workspace.isPaused(id)) throw new Error('There is no sign-in warning for that space.');
    await this.resetSpace(id);
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
    if (decision === 'session' && !pending.card.canAllowSession || decision === 'always' && !pending.card.canAllowAlways) return;
    pending.finish(decision);
  }

  private takeAction(connection: AgentConnection): void {
    const id = connection.device.id;
    const client = this.state?.clients.find((item) => item.id === id);
    if (!client || this.active.get(id)?.connection !== connection || connection.abort.aborted) {
      throw new AgentError('SESSION_CLOSED', 'This session ended.');
    }
    if (Date.now() >= connection.expiresAt) throw new AgentError('SESSION_EXPIRED', 'This session expired. Renew it in Settings → Agents.');
    const rate = this.rates.get(id) ?? new AgentRateLimit();
    this.rates.set(id, rate);
    rate.take(Date.now(), client.limits.actionsPerMinute);
  }

  private async request(connection: AgentConnection, request: AgentRequest): Promise<unknown> {
    const live = this.active.get(connection.device.id);
    const client = this.state?.clients.find(({ id }) => id === connection.device.id);
    if (!live || !client || live.connection !== connection || connection.abort.aborted || !this.audit) throw new AgentError('SESSION_CLOSED', 'This session ended.');
    this.validateLentTab();
    const scope = (request.input as { tabId?: string }).tabId;
    const tab = this.lookupTab(connection, scope ?? live.selected);
    const inputContents = tab?.view.webContents;
    const inputUrl = inputContents && !inputContents.isDestroyed() ? inputContents.getURL() : undefined;
    const loanSignal = tab === this.loan?.tab ? this.loan?.controller.signal : undefined;
    const origin = request.method === 'tab_open' || request.method === 'navigate'
      ? this.auditOrigin((request.input as AgentInput<'navigate'>).url) : tab?.origin;
    const requestedSpace = (request.input as { space?: string }).space;
    const spaceId = request.method === 'tab_open'
      ? requestedSpace ? this.state?.spaces.find((space) => space.id === requestedSpace && space.clientIds.includes(client.id))?.id
        : this.defaultSpace(client.id)?.id
      : tab?.space.id;
    let allowed = false;
    let code = 'completed';
    live.step = request.method;
    this.changed();
    try {
      if (Date.now() >= connection.expiresAt) throw new AgentError('SESSION_EXPIRED', 'This session expired. Renew it in Settings → Agents.');
      const result = await this.dispatch(live, client, request);
      connection.abort.throwIfAborted();
      if (tab && (agentTools[request.method].actionClass === 'read' || request.method === 'evaluate')
        && !['browser_status', 'tabs_list', 'dev_servers'].includes(request.method)
        && (tab.manual || this.workspace.isPaused(tab.space.id) || !inputContents || inputContents.isDestroyed() || inputContents.getURL() !== inputUrl)) {
        throw new AgentError('PAGE_CHANGED', 'The page changed. Refresh the snapshot.');
      }
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
          spaceId, actionClass: agentTools[request.method].actionClass,
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
      protocolVersion: AGENT_PROTOCOL_VERSION,
      limits: { ...client.limits, expiresAt: connection.expiresAt, renewal: 'owner-only' },
      spaces: state.spaces.filter((space) => space.clientIds.includes(client.id)).map((space) => describeSpace(space, client.id)),
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
      const space = id ? state.spaces.find((item) => item.id === id && item.clientIds.includes(client.id)) : this.defaultSpace(client.id);
      if (!space || this.resetting.has(space.id)) throw new AgentError('SPACE_UNAVAILABLE', 'Choose an available Agent Account Space.');
      if (this.workspace.forConnection(connection).length >= client.limits.tabs) throw new AgentError('TAB_LIMIT', 'Close an agent tab before opening another.');
      this.access(connection, space, method, target, 'navigation');
      if (space.trust === 'work') {
        const reviewedTab = canRememberNavigation(space, client.id, target)
          ? this.workspace.forConnection(connection).find((tab) => tab.space.id === space.id
            && !tab.manual && !tab.signedOut && !tab.view.webContents.isDestroyed() && tab.view.webContents.getURL() === target.href)
          : undefined;
        await this.confirm(live, request, { destination: target, allowSession: true, spaceId: space.id, reviewedTab });
      }
      connection.abort.throwIfAborted();
      if (this.resetting.has(space.id)) throw new AgentError('SPACE_UNAVAILABLE', 'The Agent Account Space is resetting.');
      if (this.loan?.tab.connection === connection) this.returnLentTab();
      const tab = await this.workspace.create(space, connection, target, label);
      live.selected = tab.id;
      try { await this.workspace.load(tab, target); } catch (error) { this.workspace.close(tab.id); throw error; }
      return untrusted({ tabId: tab.id, url: agentTabUrl(this.ownTab(connection, tab.id)), space: space.name, label });
    }
    if (method === 'tab_select' || method === 'tab_close') {
      const tab = this.ownTab(connection, (input as AgentInput<'tab_select'>).tabId);
      this.access(connection, tab.space, method, undefined, 'tab');
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
    if (method === 'dev_servers') {
      const origins = state.spaces.flatMap((space) => space.trust === 'work' && space.clientIds.includes(client.id) && space.classes.read
        ? space.origins.filter((origin) => !origin.includes('*') && agentLoopback(new URL(origin))
          && allowedSpaceOrigin(space, new URL(origin), client.id) === 'drive') : []);
      return { origins: [...new Set(origins)].slice(0, 16) };
    }
    const explicit = (input as { tabId?: string }).tabId;
    const tab = this.ownTab(connection, explicit ?? live.selected);
    const loan = tab === this.loan?.tab ? this.loan : undefined;
    const contents = tab.view.webContents;
    const url = agentUrl(contents.getURL());
    if (contents.isLoadingMainFrame()) throw new AgentError('FRAME_UNAVAILABLE', 'Wait for the current page to finish navigating.');
    const checkDocument = () => {
      connection.abort.throwIfAborted();
      if (tab.manual || tab.view.webContents !== contents || contents.isDestroyed() || contents.isLoadingMainFrame()
        || contents.getURL() !== url.href) throw new AgentError('PAGE_CHANGED', 'The page changed. Refresh the snapshot.');
      this.access(connection, tab.space, method, agentUrl(contents.getURL()), 'document', tab.signedOut);
    };
    if (method === 'record_start' || method === 'record_stop') {
      checkDocument();
      if (method === 'record_start') {
        live.tabRecordings.set(tab.id, new AgentRecording(contents.getURL()));
        return { recording: true };
      }
      const recording = live.tabRecordings.get(tab.id);
      if (!recording) throw new AgentError('NO_RECORDING', 'Start a recording first.');
      live.tabRecordings.delete(tab.id);
      return untrusted({ playwright: recording.finish() });
    }
    const recording = live.tabRecordings.get(tab.id);
    const requireLoanOrigin = (destination: URL) => {
      if (!loan || loan.sameOrigin(destination.href)) return;
      this.returnLentTab();
      throw new AgentError('LOAN_ORIGIN', 'The tab loan ended at its origin boundary.');
    };
    if (method === 'navigate') {
      const target = agentUrl((input as AgentInput<'navigate'>).url);
      requireLoanOrigin(target);
      this.access(connection, tab.space, method, target, 'navigation');
      if (loan || tab.space.trust === 'work' && target.origin !== url.origin) await this.confirm(live, request, { tab, destination: target, allowSession: !loan });
      connection.abort.throwIfAborted();
      await this.workspace.load(tab, target, loan?.controller.signal);
      recording?.navigate(target.href);
      return untrusted({ url: agentTabUrl(this.ownTab(connection, tab.id)) });
    }
    checkDocument();
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
      this.access(connection, tab.space, method, target, 'navigation');
      if (loan || tab.space.trust === 'work' && url.origin !== target.origin) await this.confirm(live, request, { tab, destination: target, allowSession: !loan });
      checkDocument();
      tab.navigationGrant = { origin: target.origin, until: Date.now() + 4_000 };
      history.goToIndex(targetIndex);
      recording?.step(method === 'go_back' ? 'goBack' : 'goForward');
      return { started: true };
    }
    if (method === 'reload') {
      if (loan) await this.confirm(live, request, { tab });
      checkDocument();
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
      case 'emulate': {
        const options = input as AgentInput<'emulate'>;
        if ((options.offline !== undefined || options.cpuThrottle !== undefined)
          && (tab.signedOut || allowedSpaceOrigin(tab.space, url, client.id) !== 'drive')) {
          throw new AgentError('ORIGIN_READ_ONLY', 'Only display emulation is allowed at this origin.');
        }
        await driver.emulate(options, checkDocument);
        return { applied: true };
      }
      case 'hover': {
        if (tab.signedOut || allowedSpaceOrigin(tab.space, url, client.id) !== 'drive') {
          const box = await driver.run('highlight', { ref, expectedOrigin: url.origin }, signal);
          checkDocument();
          return untrusted({ targetBounds: box });
        }
        break;
      }
      case 'evaluate': {
        const result = await driver.run('evaluate', input, signal);
        return untrusted(typeof result === 'string' ? clean(result) : result);
      }
      case 'handle_dialog': {
        await this.confirm(live, request, { tab, dialog: true });
        checkDocument();
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
    const consequential = Boolean(loan) || consequentialAction(method, url, element, undefined, tab.space.trust === 'open-web' && method === 'click');
    if (method === 'upload_file' && !tab.space.uploadRoot) {
      throw new AgentError('UPLOAD_FOLDER_REQUIRED', 'Grant an upload folder in Settings → Agents.');
    }
    if (consequential) await this.confirm(live, request, { tab, target, revision });
    checkDocument();
    if (method === 'upload_file') {
      if (!tab.space.uploadRoot) throw new AgentError('UPLOAD_FOLDER_REQUIRED', 'Grant an upload folder in Settings → Agents.');
      const file = await stageAgentUpload(tab.space.uploadRoot, (input as AgentInput<'upload_file'>).path, this.options.data);
      try { checkDocument(); await driver.upload(ref!, revision, file.path, signal); } catch (error) { await file.clean(); throw error; }
      if (loan) loan.retainUpload(file.clean);
      else this.workspace.retainUpload(tab.id, file.clean);
      return { selected: true };
    }
    if (consequential && element?.submit && element.formTarget && element.formMethod?.toUpperCase() === 'POST') {
      const destination = agentUrl(element.formTarget);
      destination.hash = '';
      tab.requestGrant = { method: 'POST', url: destination.href, until: Date.now() + 4_000 };
    }
    if (target?.link) {
      const destination = agentUrl(target.link);
      this.access(connection, tab.space, 'navigate', destination, 'navigation');
      tab.navigationGrant = { origin: destination.origin, until: Date.now() + 4_000 };
      if (method === 'click') tab.downloadGrant = { url: destination.href, until: Date.now() + 4_000 };
    }
    const command = ACTIONS[method];
    if (!command) throw new AgentError('UNSUPPORTED_ACTION', 'This action is unavailable on the selected tab.');
    try {
      const result = await driver.action(command, { ...input as object, expectedOrigin: url.origin }, revision, signal);
      if (target) recording?.action(method, target, input as AgentInput<'type'>);
      return result ? untrusted(result) : { completed: true };
    } catch (error) {
      tab.navigationGrant = undefined;
      tab.requestGrant = undefined;
      tab.downloadGrant = undefined;
      throw error;
    }
  }

  private async confirm(
    live: Live, request: AgentRequest, details: { tab?: AgentTab; destination?: URL; target?: TargetDetails; revision?: string; allowSession?: boolean; dialog?: boolean; spaceId?: string; reviewedTab?: AgentTab },
  ): Promise<void> {
    const { tab, destination, target, allowSession } = details;
    const origin = destination?.origin ?? tab?.origin;
    if (!origin) throw new AgentError('ORIGIN_REQUIRED', 'The action needs a web origin.');
    const navigationKey = (tab?.space.id ?? details.spaceId ?? '') + '|' + origin;
    if (allowSession && live.trustedOrigins.has(navigationKey)) return;
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
    const review = reviewedTab && destination ? await this.siteApprovalRevision(reviewedTab, destination) : null;
    signal.throwIfAborted();
    const remembered = details.spaceId && this.state?.spaces.find((space) => space.id === details.spaceId);
    if (review && remembered && remembered.rememberedOrigins?.[connection.device.id]?.includes(origin)) return;
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
        origin, expiresAt: proof.expiresAt, canAllowSession: Boolean(allowSession), canAllowAlways: Boolean(review),
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
    if (decision === 'session') live.trustedOrigins.add(navigationKey);
    if (decision === 'always') {
      if (!review || !reviewedTab || !destination || await this.siteApprovalRevision(reviewedTab, destination) !== review) {
        throw new AgentError('PAGE_CHANGED', 'The page changed while awaiting approval. Get a fresh snapshot.');
      }
      signal.throwIfAborted();
      if (Date.now() >= proof.expiresAt || Date.now() >= connection.expiresAt) {
        throw new AgentError('ACTION_DENIED', 'The site approval expired. Review it again.');
      }
      this.rememberNavigation(reviewedTab.space.id, connection.device.id, destination);
    }
  }

  private async siteApprovalRevision(tab: AgentTab, destination: URL): Promise<string | null> {
    const contents = tab.view.webContents;
    const isCurrent = () => this.workspace.get(tab.id) === tab && !tab.manual && !tab.signedOut
      && !contents.isDestroyed() && !contents.isLoadingMainFrame() && contents.getURL() === destination.href;
    if (!isCurrent()) return null;
    const revision = await tab.driver.run<string | null>('siteApprovalRevision', {}, tab.connection.abort).catch(() => null);
    return isCurrent() ? revision : null;
  }

  private rememberNavigation(spaceId: string, clientId: string, destination: URL): void {
    const state = this.requireEnabled();
    const current = state.spaces.find((space) => space.id === spaceId);
    if (!current || !canRememberNavigation(current, clientId, destination)) {
      throw new AgentError('ORIGIN_DENIED', 'Add the exact Work origin in Settings before remembering it.');
    }
    const rememberedOrigins = {
      ...current.rememberedOrigins,
      [clientId]: [...new Set([...(current.rememberedOrigins?.[clientId] ?? []), destination.origin])],
    };
    this.persist({ ...state, spaces: state.spaces.map((space) => space === current ? { ...space, rememberedOrigins } : space) });
    this.changed();
  }

  private authorize(device: Device, code?: string): { expiresAt: number; idleMs: number } | 'expired' | undefined {
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
      const client = newAgentClient(device, Date.now(), this.state.sessionCapMs);
      this.persist({ ...this.state, clients: [...this.state.clients, client] });
      return { expiresAt: client.expiresAt!, idleMs: client.limits.idleMs };
    }
    if (!stored.expiresAt || stored.expiresAt <= Date.now()) return 'expired';
    return { expiresAt: stored.expiresAt, idleMs: stored.limits.idleMs };
  }

  private auditOrigin(value: string): string | undefined {
    try { return agentUrl(value).origin; } catch { return undefined; }
  }

  private defaultSpace(clientId: string): SpacePolicy | undefined {
    return this.state?.spaces.find((space) => space.clientIds.includes(clientId));
  }

  private access(connection: AgentConnection, space: SpacePolicy, method: AgentMethod, url?: URL,
    scope: 'document' | 'navigation' | 'tab' = 'document', signedOut = false): void {
    if (this.workspace.isPaused(space.id)) throw new AgentError('SPACE_PAUSED', 'Review the possible sign-in in the Agent Workspace.');
    requireDecision(decide(space, method, url?.origin, Date.now(), {
      clientId: connection.device.id, expiresAt: connection.expiresAt,
    }, scope, signedOut));
  }

  private replaceSpace(updated: SpacePolicy): void {
    const state = this.requireEnabled();
    const previous = state.spaces.find((space) => space.id === updated.id);
    this.persist({ ...state, spaces: state.spaces.map((space) => space.id === updated.id ? updated : space) });
    for (const id of new Set([...(previous?.clientIds ?? []), ...updated.clientIds])) this.disconnect(id);
    this.changed();
  }

  private replaceClient(id: string, patch: Partial<Pick<StoredClient, 'limits' | 'expiresAt' | 'sessionStartedAt'>>): void {
    const state = this.requireEnabled();
    this.persist({ ...state, clients: state.clients.map((client) => client.id === id ? { ...client, ...patch } : client) });
    this.disconnect(id);
    this.changed();
  }

  private disconnect(id: string): void {
    const live = this.active.get(id);
    if (live) live.connection.close();
    this.active.delete(id);
    if (this.pending?.connection.device.id === id) this.pending.finish('deny');
  }

  private requireEnabled(): StoredState {
    if (!this.state?.enabled || !this.pipe || this.paused || this.unavailable) {
      throw new AgentError('MODE_DISABLED', 'Turn on or resume Agent Mode in Settings → Agents.');
    }
    return this.state;
  }

  private persist(state: StoredState): void {
    writeAgentFile(this.statePath, state);
    this.state = state;
    for (const space of state.spaces) this.audit?.addSpace(space.id);
  }
  private changed(): void { this.workspace.broadcast(); this.options.onChange(); }
}
