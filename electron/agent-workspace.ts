import { randomUUID } from 'node:crypto';
import { BrowserWindow, session, WebContentsView, type IpcMainInvokeEvent, type Session } from 'electron';
import { join } from 'node:path';
import { AgentDriver, cleanUrl } from './agent-driver.js';
import { AgentError, agentUrl } from './agent-policy.js';
import { allowedSpaceOrigin, type SpacePolicy } from './agent-space-policy.js';
import { AgentPublicProxy } from './agent-public-proxy.js';
import { AgentDownloads } from './agent-downloads.js';
import { clearAndVerifyAccountSession } from './account-session.js';
import { stripTrackingParameters } from './security.js';
import type { AgentConnection } from './agent-pipe.js';

const HEADER_HEIGHT = 128;
const PARTITION_PREFIX = 'persist:private-browser-agent-';
const guestCredentialFeatures = ['publickey-credentials-get', 'publickey-credentials-create', 'identity-credentials-get'];
const guestFeatureDeclaration = /^[a-z][a-z0-9-]*=(?:\*|\((?:[ \ta-z0-9_-]|"[\x21\x23-\x2b\x2d-\x5b\x5d-\x7e]*")*\))(?:;[a-z][a-z0-9-]*=(?:[a-z0-9_-]+|"[a-z0-9_-]+"))?$/u;


type RequestGrant = { url: string; method: string; until: number };

export interface AgentTab {
  id: string;
  space: SpacePolicy;
  connection: AgentConnection;
  signedOut: boolean;
  partition: Session;
  transition?: Promise<void>;
  view: WebContentsView;
  driver: AgentDriver;
  manual: boolean;
  label?: string;
  origin?: string;
  navigationGrant?: { origin: string; until: number };
  requestGrant?: RequestGrant;
  downloadGrant?: { url: string; until: number };
}

export class AgentWorkspace {
  private window?: BrowserWindow;
  private opening?: Promise<void>;
  private hidden = false;
  private readonly tabs = new Map<string, AgentTab>();
  private readonly configured = new WeakSet<Session>();
  private readonly restricted = new WeakMap<Session, Promise<void>>();
  private publicProxy = new AgentPublicProxy();
  private readonly pausedSpaces = new Set<string>();
  private readonly downloads: AgentDownloads;
  private readonly temporarySessions = new Map<AgentConnection, Map<string, Session>>();
  private readonly clearing = new Set<string>();
  private readonly uploads = new Map<string, (() => Promise<void>)[]>();
  selected?: string;

  constructor(
    private readonly chromeUrl: string,
    private readonly preload: string,
    private readonly downloadRoot: string,
    private readonly changed: () => void,
    private readonly stopped: () => void,
    private readonly knownWorkDomain: (domain: string) => boolean,
  ) { this.downloads = new AgentDownloads(downloadRoot); }

  async show(): Promise<void> {
    if (this.opening) return this.opening;
    if (this.window && !this.window.isDestroyed()) {
      this.window.show();
      return;
    }
    const window = new BrowserWindow({
      title: 'Agent Workspace — Private Browser', width: 1150, height: 840, minWidth: 360, minHeight: 500,
      frame: true, fullscreenable: false, show: false, autoHideMenuBar: true,
      webPreferences: { preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false },
    });
    this.window = window;
    const chrome = window.webContents;
    chrome.setWindowOpenHandler(() => ({ action: 'deny' }));
    chrome.on('will-attach-webview', (event) => event.preventDefault());
    chrome.on('will-navigate', (event) => event.preventDefault());
    chrome.on('will-frame-navigate', (event) => event.preventDefault());
    chrome.on('will-redirect', (event) => event.preventDefault());
    chrome.on('before-input-event', (event, input) => this.handleShortcut(event, input));
    window.on('resize', () => this.layout());
    window.on('closed', () => {
      if (this.window !== window) return;
      this.window = undefined;
      this.stopped();
    });
    this.opening = (async () => {
      await window.loadURL(this.chromeUrl);
      if (!window.isDestroyed()) window.show();
    })();
    try { await this.opening; } finally { this.opening = undefined; }
  }

  isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const contents = this.window?.webContents;
    return Boolean(contents && !contents.isDestroyed() && event.sender.id === contents.id
      && event.senderFrame === contents.mainFrame && event.senderFrame?.url === this.chromeUrl);
  }

  broadcast(): void {
    const contents = this.window?.webContents;
    if (contents && !contents.isDestroyed()) contents.send('agents:changed');
  }

  setHidden(hidden: boolean): void { this.hidden = hidden; this.layout(); }

  summaries() {
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id, name: tab.origin ?? 'New tab', client: tab.connection.device.name, space: tab.space.name, manual: tab.manual, canManual: tab.space.trust === 'work' && !tab.signedOut, label: tab.label,
    }));
  }

  forConnection(connection: AgentConnection): AgentTab[] {
    return [...this.tabs.values()].filter((tab) => tab.connection === connection);
  }

  async create(space: SpacePolicy, connection: AgentConnection, target: URL, label?: string): Promise<AgentTab> {
    await this.show();
    return this.createView(randomUUID(), space, connection, target, label);
  }

  private async createView(id: string, space: SpacePolicy, connection: AgentConnection, target: URL, label?: string): Promise<AgentTab> {
    connection.abort.throwIfAborted();
    const signedOut = space.trust === 'work' && allowedSpaceOrigin(space, target, connection.device.id) !== 'drive';
    const targetSession = this.partition(space, connection, signedOut);
    if (space.trust === 'open-web') {
      const setup = this.restricted.get(targetSession) ?? this.publicProxy.restrict(targetSession);
      this.restricted.set(targetSession, setup);
      try { await setup; } catch { throw new AgentError('PUBLIC_NETWORK_UNAVAILABLE', 'The public-only network could not be verified.'); }
    }
    connection.abort.throwIfAborted();
    if (this.isPaused(space.id) || this.clearing.has(space.id) || !this.window || this.window.isDestroyed()) throw new AgentError('SPACE_UNAVAILABLE', 'This Agent Account Space is paused or closed.');
    this.configure(targetSession, space);
    const view = new WebContentsView({ webPreferences: {
      session: targetSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, devTools: false, navigateOnDragDrop: false,
    } });
    const contents = view.webContents;
    const tab: AgentTab = {
      id, space, connection, partition: targetSession, view, driver: new AgentDriver(contents), manual: false, label, signedOut,
    };
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame && !this.navigationAllowed(tab, event.url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('login', (event, _details, _authInfo, respond) => {
      if (space.trust === 'open-web' || signedOut || !tab.manual) { event.preventDefault(); respond(); }
    });
    contents.on('before-input-event', (event, input) => {
      this.handleShortcut(event, input);
      if (!tab.manual) event.preventDefault();
    });
    const commit = (value: string) => {
      try {
        const url = agentUrl(value);
        if (!this.canUsePartition(tab, url)) { this.closeView(tab); return; }
        tab.origin = url.origin;
        tab.navigationGrant = undefined;
        tab.requestGrant = undefined;
        this.changed();
      } catch { this.closeView(tab); }
    };
    contents.on('did-navigate', (_event, url) => commit(url));
    contents.on('did-navigate-in-page', (_event, url, main) => { if (main) commit(url); });
    contents.on('enter-html-full-screen', () => contents.executeJavaScript('document.exitFullscreen()').catch(() => undefined));
    contents.on('render-process-gone', () => this.closeView(tab));
    this.tabs.set(id, tab);
    this.window.contentView.addChildView(view);
    this.select(id);
    return tab;
  }

  select(id: string): void {
    if (!this.tabs.has(id)) throw new AgentError('TAB_UNAVAILABLE', 'That tab has closed.');
    this.selected = id;
    this.layout();
    this.changed();
  }

  setManual(id: string, manual: boolean): void {
    const tab = this.tabs.get(id);
    if (!tab || this.selected !== id) throw new AgentError('TAB_UNAVAILABLE', 'Select the tab first.');
    if (manual && (tab.space.trust === 'open-web' || tab.signedOut || !tab.origin)) {
      throw new AgentError('SIGN_IN_DISABLED', 'Take manual control on a listed Work origin.');
    }
    tab.requestGrant = undefined;
    tab.navigationGrant = undefined;
    tab.downloadGrant = undefined;
    tab.manual = manual;
    const contents = tab.view.webContents;
    if (manual && contents.debugger.isAttached()) contents.debugger.detach();
    this.changed();
  }

  get(id: string): AgentTab | undefined { return this.tabs.get(id); }

  retainUpload(id: string, clean: () => Promise<void>): void {
    const entries = this.uploads.get(id) ?? [];
    if (!this.tabs.has(id)) { void clean(); return; }
    entries.push(clean);
    if (entries.length > 8) void entries.shift()?.();
    this.uploads.set(id, entries);
  }

  close(id: string): void {
    const tab = this.tabs.get(id);
    if (tab) this.closeView(tab);
  }

  private closeView(tab: AgentTab): void {
    const { id } = tab;
    if (this.tabs.get(id) !== tab) return;
    this.tabs.delete(id);
    for (const clean of this.uploads.get(id) ?? []) void clean();
    this.uploads.delete(id);
    if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    tab.driver.dispose();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    if (this.selected === id) this.selected = this.tabs.keys().next().value;
    this.layout();
    this.changed();
  }

  closeConnection(connection: AgentConnection): void {
    for (const tab of this.forConnection(connection)) this.closeView(tab);
    const sessions = this.temporarySessions.get(connection);
    this.temporarySessions.delete(connection);
    for (const partition of sessions?.values() ?? []) void clearAndVerifyAccountSession(partition).catch(() => undefined);
  }

  closeAll(): void {
    for (const id of this.tabs.keys()) this.close(id);
    this.publicProxy.close();
    this.publicProxy = new AgentPublicProxy();
  }

  isPaused(spaceId: string): boolean { return this.pausedSpaces.has(spaceId); }

  possibleSignIn(): string | undefined { return this.pausedSpaces.values().next().value; }

  async reset(space: SpacePolicy): Promise<void> {
    const tabs = [...this.tabs.values()].filter((tab) => tab.space.id === space.id);
    const sessions = new Set(tabs.map((tab) => tab.partition));
    for (const temporary of this.temporarySessions.values()) {
      const partition = temporary.get(space.id);
      if (partition) sessions.add(partition);
    }
    if (space.trust === 'work') sessions.add(this.partition(space));
    this.clearing.add(space.id);
    try {
      for (const tab of tabs) this.closeView(tab);
      await Promise.all([...sessions].map((partition) => clearAndVerifyAccountSession(partition)));
      this.pausedSpaces.delete(space.id);
    } finally {
      this.clearing.delete(space.id);
      this.changed();
    }
  }

  async load(tab: AgentTab, url: URL, signal = tab.connection.abort): Promise<void> {
    signal.throwIfAborted();
    if (!this.canUsePartition(tab, url)) {
      if (tab.space.id === 'lent') throw new AgentError('LOAN_ORIGIN', 'The tab loan ended at its origin boundary.');
      return this.transfer(tab, url);
    }
    tab.navigationGrant = { origin: url.origin, until: Date.now() + 15_000 };
    try {
      await tab.view.webContents.loadURL(stripTrackingParameters(url.href));
      signal.throwIfAborted();
      await tab.driver.initialize();
    } catch {
      if (tab.transition) return tab.transition;
      throw new AgentError('LOAD_FAILED', 'The page could not load or a redirect was blocked.');
    } finally { tab.navigationGrant = undefined; }
  }

  private async transfer(tab: AgentTab, url: URL): Promise<void> {
    tab.connection.abort.throwIfAborted();
    if (this.tabs.get(tab.id) !== tab) throw new AgentError('TAB_UNAVAILABLE', 'That tab has closed.');
    this.closeView(tab);
    const successor = await this.createView(tab.id, tab.space, tab.connection, url, tab.label);
    try { await this.load(successor, url); }
    catch (error) { this.closeView(successor); throw error; }
  }

  downloadList(space: SpacePolicy) { return this.downloads.list(space.id); }

  private partition(space: SpacePolicy, connection?: AgentConnection, signedOut = false): Session {
    const isolated = signedOut || space.trust === 'open-web';
    if (!isolated) return session.fromPartition(PARTITION_PREFIX + space.id);
    if (!connection) throw new Error('An isolated session requires a client connection.');
    const temporary = this.temporarySessions.get(connection) ?? new Map<string, Session>();
    const partition = temporary.get(space.id) ?? session.fromPartition('agent-temporary-' + space.id + '-' + connection.id, { cache: false });
    temporary.set(space.id, partition);
    this.temporarySessions.set(connection, temporary);
    return partition;
  }

  private canUsePartition(tab: AgentTab, url: URL): boolean {
    const access = allowedSpaceOrigin(tab.space, url, tab.connection.device.id);
    return access !== 'deny' && !this.isPaused(tab.space.id) && !tab.connection.abort.aborted
      && (access === 'drive') !== tab.signedOut;
  }

  private navigationAllowed(tab: AgentTab, value: string): boolean {
    try {
      const url = agentUrl(value);
      if (!this.canUsePartition(tab, url)) return false;
      return tab.space.trust === 'open-web' || tab.manual || url.origin === tab.origin
        || url.origin === tab.navigationGrant?.origin && Date.now() < tab.navigationGrant.until;
    } catch { return false; }
  }

  private configure(browserSession: Session, space: SpacePolicy): void {
    if (this.configured.has(browserSession)) return;
    this.configured.add(browserSession);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    browserSession.setDevicePermissionHandler(() => false);
    browserSession.setSpellCheckerLanguages([]);
    browserSession.setDownloadPath(join(this.downloadRoot, space.id));
    if (space.trust === 'open-web') {
      browserSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
        if (removed || !cookie.domain || !/^(?:__Host-|__Secure-)?(?:auth|sid|session(?:id|_id)?|access_token|logged_in)$/iu.test(cookie.name)
          || !this.knownWorkDomain(cookie.domain.replace(/^\./u, ''))
          || ![...this.tabs.values()].some((tab) => tab.partition === browserSession)) return;
        this.pausedSpaces.add(space.id);
        this.layout();
        this.changed();
      });
    }
    const tabFor = (id?: number) => [...this.tabs.values()].find((tab) => tab.view.webContents.id === id);
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const tab = tabFor(details.webContentsId);
      const method = details.method.toUpperCase();
      const unsafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
      let cancel = !tab || this.isPaused(space.id) || this.clearing.has(space.id);
      try {
        if (details.resourceType === 'mainFrame' && tab && !this.navigationAllowed(tab, details.url)) {
          cancel = true;
          const target = agentUrl(details.url);
          const access = allowedSpaceOrigin(tab.space, target, tab.connection.device.id);
          if (tab.space.trust === 'work' && !tab.signedOut && !tab.manual && !tab.transition && method === 'GET'
            && tab.navigationGrant && tab.navigationGrant.until > Date.now() && (access === 'observe' || access === 'view')) {
            tab.transition = Promise.resolve().then(() => this.transfer(tab, target));
            void tab.transition.catch(() => undefined);
          }
        }
        if (details.resourceType === 'subFrame' && tab) {
          const frameUrl = agentUrl(details.url);
          if (!this.canUsePartition(tab, frameUrl)) cancel = true;
        }
        if (tab?.signedOut && (unsafe || details.resourceType === 'webSocket')) cancel = true;
        if (space.trust === 'open-web' && !/^https?:/iu.test(details.url)) cancel = true;
        if (tab && !tab.manual && unsafe) {
          const request = agentUrl(details.url);
          const grant = tab.requestGrant;
          request.hash = '';
          cancel ||= !grant || grant.until < Date.now() || grant.method !== method || grant.url !== request.href;
          if (!cancel) tab.requestGrant = undefined;
        }
      } catch { cancel = true; }
      if (!cancel) tab?.driver.networkStarted(details.id);
      callback({ cancel });
    });
    browserSession.webRequest.onBeforeSendHeaders((details, done) => {
      const tab = tabFor(details.webContentsId);
      const headers = details.requestHeaders;
      if (tab?.signedOut || space.trust === 'open-web') {
        for (const name of Object.keys(headers)) {
          if (/^(?:authorization|proxy-authorization)$/iu.test(name) || tab?.signedOut && /^(?:cookie|referer)$/iu.test(name)) delete headers[name];
        }
      }
      done({ requestHeaders: headers });
    });
    browserSession.webRequest.onHeadersReceived((details, done) => {
      const headers = details.responseHeaders;
      const preview = tabFor(details.webContentsId)?.signedOut;
      if (headers && preview) {
        for (const name of Object.keys(headers)) if (/^set-cookie2?$/iu.test(name)) delete headers[name];
      }
      if (headers && (preview || space.trust === 'open-web') && ['mainFrame', 'subFrame'].includes(details.resourceType)) {
        const fields: string[] = [];
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() !== 'permissions-policy') continue;
          fields.push(...headers[key].flatMap((value) => value.split(',').map((field) => field.trim())));
          delete headers[key];
        }
        // A malformed structured field can make Chromium ignore the whole
        // policy. Prefer refusing that response over enabling native login.
        if (fields.some((field) => !guestFeatureDeclaration.test(field))) { done({ cancel: true }); return; }
        headers['Permissions-Policy'] = [[
          ...fields.filter((field) => !guestCredentialFeatures.some((feature) => field.startsWith(feature + '='))),
          ...guestCredentialFeatures.map((feature) => feature + '=()'),
        ].join(', ')];
      }
      done({ responseHeaders: headers });
    });
    browserSession.webRequest.onCompleted((details) => tabFor(details.webContentsId)?.driver.networkEnded(details));
    browserSession.webRequest.onErrorOccurred((details) => tabFor(details.webContentsId)?.driver.networkEnded(details));
    browserSession.on('will-download', (event, item, source) => {
      const tab = tabFor(source?.id);
      let allowed = false;
      if (tab && !tab.signedOut && tab.space.classes.files && (tab.space.trust === 'open-web' || tab.space.uploadRoot) && !this.isPaused(space.id) && !this.clearing.has(space.id) && tab.origin) {
        try {
          const chain = item.getURLChain().map(agentUrl);
          const grant = tab.downloadGrant;
          if (chain.length === 1 && chain[0].origin === tab.origin
            && allowedSpaceOrigin(tab.space, chain[0], tab.connection.device.id) === 'drive'
            && (tab.manual || grant && grant.until > Date.now() && grant.url === chain[0].href)) {
            tab.downloadGrant = undefined;
            allowed = this.downloads.start(tab.space, item, tab.connection.abort);
          }
        } catch { /* Block unsupported downloads. */ }
      }
      if (!allowed) event.preventDefault();
    });
  }

  private handleShortcut(event: Electron.Event, input: Electron.Input): void {
    if (input.type === 'keyDown' && !input.isAutoRepeat && input.control && input.shift && !input.alt && !input.meta
      && (input.code === 'Period' || input.key === '>')) {
      event.preventDefault();
      this.stopped();
    }
  }

  private layout(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    for (const tab of this.tabs.values()) {
      const show = !this.hidden && !this.possibleSignIn() && this.selected === tab.id;
      tab.view.setVisible(show);
      if (show) tab.view.setBounds({ x: 5, y: HEADER_HEIGHT, width: Math.max(0, width - 10), height: Math.max(0, height - HEADER_HEIGHT - 5) });
    }
  }
}

export function agentTabUrl(tab: AgentTab): string {
  return cleanUrl(tab.view.webContents.getURL());
}
