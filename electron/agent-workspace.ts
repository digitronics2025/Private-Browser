import { randomUUID } from 'node:crypto';
import { BrowserWindow, session, WebContentsView, type IpcMainInvokeEvent, type Session } from 'electron';
import { mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AgentDriver, clean, cleanUrl } from './agent-driver.js';
import { agentAccess, AgentError, agentUrl, type AgentPolicy } from './agent-policy.js';
import { clearAndVerifyAccountSession } from './account-session.js';
import { downloadRisk, stripTrackingParameters } from './security.js';
import type { AgentConnection } from './agent-pipe.js';

const HEADER_HEIGHT = 128;
const PARTITION_PREFIX = 'persist:private-browser-agent-';
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export interface AgentSpace { id: string; name: string }
type RequestGrant = { url: string; method: string; until: number };
type Download = { name: string; path: string; bytes: number };

export interface AgentTab {
  id: string;
  space: AgentSpace;
  connection: AgentConnection;
  policy: AgentPolicy;
  view: WebContentsView;
  driver: AgentDriver;
  manual: boolean;
  label?: string;
  origin?: string;
  navigationGrant?: { origin: string; until: number };
  requestGrant?: RequestGrant;
}

export class AgentWorkspace {
  private window?: BrowserWindow;
  private opening?: Promise<void>;
  private hidden = false;
  private readonly tabs = new Map<string, AgentTab>();
  private readonly configured = new Set<string>();
  private readonly downloads = new Map<string, Download[]>();
  private readonly uploads = new Map<string, (() => Promise<void>)[]>();
  selected?: string;

  constructor(
    private readonly chromeUrl: string,
    private readonly preload: string,
    private readonly downloadRoot: string,
    private readonly changed: () => void,
    private readonly stopped: () => void,
  ) {}

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
      id: tab.id, name: tab.origin ?? 'New tab', client: tab.connection.device.name, space: tab.space.name, manual: tab.manual, label: tab.label,
    }));
  }

  forConnection(connection: AgentConnection): AgentTab[] {
    return [...this.tabs.values()].filter((tab) => tab.connection === connection);
  }

  async create(space: AgentSpace, connection: AgentConnection, policy: AgentPolicy, label?: string): Promise<AgentTab> {
    await this.show();
    connection.abort.throwIfAborted();
    const targetSession = this.partition(space.id);
    this.configure(targetSession, space);
    const view = new WebContentsView({ webPreferences: {
      session: targetSession, contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false, devTools: false,
    } });
    const tab: AgentTab = { id: randomUUID(), space, connection, policy, view, driver: new AgentDriver(view.webContents), manual: false, label };
    const guard = (event: { preventDefault(): void; url: string }) => {
      if (!this.navigationAllowed(tab, event.url)) event.preventDefault();
    };
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-frame-navigate', (event) => { if (event.isMainFrame) guard(event); });
    view.webContents.on('will-redirect', guard);
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
    view.webContents.on('before-input-event', (event, input) => this.handleShortcut(event, input));
    const commit = (url: string) => {
      try {
        const destination = agentUrl(url);
        if (!tab.manual && agentAccess(tab.policy, destination) === 'deny') { this.close(tab.id); return; }
        tab.origin = destination.origin;
        tab.navigationGrant = undefined;
        tab.requestGrant = undefined;
        this.changed();
      } catch { this.close(tab.id); }
    };
    view.webContents.on('did-navigate', (_event, url) => commit(url));
    view.webContents.on('did-navigate-in-page', (_event, url, main) => { if (main) commit(url); });
    view.webContents.on('enter-html-full-screen', () => view.webContents.executeJavaScript('document.exitFullscreen()').catch(() => undefined));
    view.webContents.on('render-process-gone', () => this.close(tab.id));
    this.tabs.set(tab.id, tab);
    this.window!.contentView.addChildView(view);
    this.select(tab.id);
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
    tab.requestGrant = undefined;
    tab.navigationGrant = undefined;
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
    if (!tab) return;
    this.tabs.delete(id);
    for (const clean of this.uploads.get(id) ?? []) void clean();
    this.uploads.delete(id);
    if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    if (this.selected === id) this.selected = this.tabs.keys().next().value;
    this.layout();
    this.changed();
  }

  closeConnection(connection: AgentConnection): void {
    for (const tab of this.forConnection(connection)) this.close(tab.id);
  }

  closeAll(): void { for (const id of this.tabs.keys()) this.close(id); }

  async reset(space: AgentSpace): Promise<void> {
    for (const tab of this.tabs.values()) if (tab.space.id === space.id) this.close(tab.id);
    await clearAndVerifyAccountSession(this.partition(space.id));
  }

  async load(tab: AgentTab, url: URL, signal = tab.connection.abort): Promise<void> {
    signal.throwIfAborted();
    tab.navigationGrant = { origin: url.origin, until: Date.now() + 15_000 };
    try {
      await tab.view.webContents.loadURL(stripTrackingParameters(url.href));
      signal.throwIfAborted();
      await tab.driver.initialize();
    }
    catch { throw new AgentError('LOAD_FAILED', 'The page could not load or a redirect was blocked.'); }
    finally { tab.navigationGrant = undefined; }
  }

  downloadList(space: AgentSpace): Download[] { return this.downloads.get(space.id) ?? []; }

  private partition(id: string): Session { return session.fromPartition(`${PARTITION_PREFIX}${id}`); }

  private navigationAllowed(tab: AgentTab, value: string): boolean {
    try {
      const url = agentUrl(value);
      if (tab.connection.abort.aborted) return false;
      if (tab.manual) return true;
      return agentAccess(tab.policy, url) !== 'deny' && (url.origin === tab.origin
        || url.origin === tab.navigationGrant?.origin && Date.now() < tab.navigationGrant.until);
    } catch { return false; }
  }

  private configure(browserSession: Session, space: AgentSpace): void {
    if (this.configured.has(space.id)) return;
    this.configured.add(space.id);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    browserSession.setDevicePermissionHandler(() => false);
    browserSession.setSpellCheckerLanguages([]);
    browserSession.setDownloadPath(join(this.downloadRoot, space.id));
    const tabFor = (id?: number) => [...this.tabs.values()].find((tab) => tab.view.webContents.id === id);
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const tab = tabFor(details.webContentsId);
      const method = details.method.toUpperCase();
      const unsafe = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
      let cancel = !tab;
      try {
        if (details.resourceType === 'mainFrame' && (!tab || !this.navigationAllowed(tab, details.url))) cancel = true;
        if (details.resourceType === 'subFrame') agentUrl(details.url);
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
    browserSession.webRequest.onCompleted((details) => tabFor(details.webContentsId)?.driver.networkEnded(details));
    browserSession.webRequest.onErrorOccurred((details) => tabFor(details.webContentsId)?.driver.networkEnded(details));
    browserSession.on('will-download', (event, item, source) => {
      const tab = tabFor(source?.id);
      const name = basename(item.getFilename()).slice(0, 160);
      const bytes = item.getTotalBytes();
      if (!tab || tab.connection.abort.aborted || !name || downloadRisk(name) !== 'ordinary' || bytes > MAX_DOWNLOAD_BYTES) {
        event.preventDefault();
        return;
      }
      const filename = `${randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const directory = join(this.downloadRoot, space.id);
      try { mkdirSync(directory, { recursive: true, mode: 0o700 }); } catch { event.preventDefault(); return; }
      const path = join(directory, filename);
      item.setSavePath(path);
      const abort = () => item.cancel();
      tab.connection.abort.addEventListener('abort', abort, { once: true });
      item.on('updated', () => { if (item.getReceivedBytes() > MAX_DOWNLOAD_BYTES) item.cancel(); });
      item.once('done', (_event, state) => {
        tab.connection.abort.removeEventListener('abort', abort);
        if (state !== 'completed') return;
        const log = [{ name: clean(name, 160), path, bytes: item.getReceivedBytes() }, ...this.downloadList(space)];
        this.downloads.set(space.id, log.slice(0, 100));
      });
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
      const show = !this.hidden && this.selected === tab.id;
      tab.view.setVisible(show);
      if (show) tab.view.setBounds({ x: 5, y: HEADER_HEIGHT, width: Math.max(0, width - 10), height: Math.max(0, height - HEADER_HEIGHT - 5) });
    }
  }
}

export function agentTabUrl(tab: AgentTab): string {
  return cleanUrl(tab.view.webContents.getURL());
}
