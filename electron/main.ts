import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  session,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron';
import { isAllowedRemoteUrl, isProtectedPage, normalizeNavigationInput, redactSensitiveText } from './security.js';
import { StateStore, WORKSPACES } from './state-store.js';
import type {
  AiPagePreview,
  BrowserSnapshot,
  BrowserTab,
  DownloadEntry,
  PersistedState,
  PrivacyEvent,
  VaultItemInput,
  WorkspaceId,
} from './types.js';
import { VaultStore } from './vault.js';

interface RuntimeTab {
  view?: WebContentsView;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon?: string;
}

interface Layout {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

const TRACKER_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'connect.facebook.net',
  'analytics.twitter.com',
  'hotjar.com',
  'scorecardresearch.com',
];

class BrowserController {
  private readonly runtimeTabs = new Map<string, RuntimeTab>();
  private readonly downloads = new Map<string, DownloadEntry>();
  private readonly configuredSessions = new Set<string>();
  private layout: Layout = { top: 104, left: 78, right: 356, bottom: 0 };
  private window!: BrowserWindow;

  constructor(
    private readonly store: StateStore,
    private readonly vault: VaultStore,
  ) {
    for (const tab of this.store.get().tabs) {
      this.runtimeTabs.set(tab.id, { loading: false, canGoBack: false, canGoForward: false });
    }
  }

  async createWindow(): Promise<void> {
    this.window = new BrowserWindow({
      width: 1500,
      height: 940,
      minWidth: 1050,
      minHeight: 680,
      backgroundColor: '#0b0d12',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#10131a', symbolColor: '#aeb6c8', height: 39 },
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    Menu.setApplicationMenu(null);
    this.window.on('resize', () => this.applyLayout());
    this.window.on('closed', () => {
      for (const runtime of this.runtimeTabs.values()) runtime.view?.webContents.close();
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) await this.window.loadURL(devUrl);
    else await this.window.loadFile(join(import.meta.dirname, '../dist/index.html'));

    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedRemoteUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    this.window.once('ready-to-show', () => this.window.show());
    await this.showActiveTab();
  }

  getSnapshot(): BrowserSnapshot {
    const persisted = this.store.get();
    const tabs: BrowserTab[] = persisted.tabs.map((tab) => {
      const runtime = this.runtimeTabs.get(tab.id);
      return {
        ...tab,
        loading: runtime?.loading ?? false,
        canGoBack: runtime?.canGoBack ?? false,
        canGoForward: runtime?.canGoForward ?? false,
        favicon: runtime?.favicon,
      };
    });
    return {
      workspaces: WORKSPACES,
      activeWorkspaceId: persisted.activeWorkspaceId,
      activeTabId: this.activeTab(persisted).id,
      tabs,
      bookmarks: persisted.bookmarks,
      history: persisted.history.slice(0, 100),
      downloads: [...this.downloads.values()],
      privacyLog: persisted.privacyLog.slice(0, 50),
      trackerBlocking: persisted.trackerBlocking,
    };
  }

  broadcast(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send('browser:state', this.getSnapshot());
  }

  setLayout(layout: Layout): void {
    this.layout = {
      top: Math.max(80, Math.round(layout.top)),
      left: Math.max(0, Math.round(layout.left)),
      right: Math.max(0, Math.round(layout.right)),
      bottom: Math.max(0, Math.round(layout.bottom)),
    };
    this.applyLayout();
  }

  async navigate(value: string): Promise<void> {
    const url = normalizeNavigationInput(value);
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (url === 'private://home') {
      this.store.update((next) => {
        const target = next.tabs.find((candidate) => candidate.id === tab.id);
        if (target) Object.assign(target, { url, title: 'New tab', isHome: true });
      });
      const runtime = this.runtimeTabs.get(tab.id);
      runtime?.view?.setVisible(false);
      this.broadcast();
      return;
    }
    if (!isAllowedRemoteUrl(url)) throw new Error('Only HTTP and HTTPS pages are allowed');
    this.store.update((next) => {
      const target = next.tabs.find((candidate) => candidate.id === tab.id);
      if (target) Object.assign(target, { url, isHome: false });
    });
    const view = this.ensureView(tab.id);
    view.setVisible(true);
    this.applyLayout();
    await view.webContents.loadURL(url);
    this.broadcast();
  }

  async newTab(workspaceId?: WorkspaceId, url = 'private://home'): Promise<void> {
    const state = this.store.get();
    const targetWorkspace = WORKSPACES.some((item) => item.id === workspaceId) ? workspaceId! : state.activeWorkspaceId;
    const id = randomUUID();
    this.hideAllViews();
    this.store.update((next) => {
      next.activeWorkspaceId = targetWorkspace;
      next.tabs.push({ id, workspaceId: targetWorkspace, title: 'New tab', url: 'private://home', isHome: true });
      next.activeTabByWorkspace[targetWorkspace] = id;
    });
    this.runtimeTabs.set(id, { loading: false, canGoBack: false, canGoForward: false });
    this.broadcast();
    if (url !== 'private://home') await this.navigate(url);
  }

  async closeTab(tabId: string): Promise<void> {
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const siblings = state.tabs.filter((candidate) => candidate.workspaceId === tab.workspaceId && candidate.id !== tab.id);
    const nextId = siblings.at(-1)?.id;
    const runtime = this.runtimeTabs.get(tabId);
    if (runtime?.view) {
      this.window.contentView.removeChildView(runtime.view);
      runtime.view.webContents.close();
    }
    this.runtimeTabs.delete(tabId);
    this.store.update((next) => {
      next.tabs = next.tabs.filter((candidate) => candidate.id !== tabId);
      if (nextId) next.activeTabByWorkspace[tab.workspaceId] = nextId;
    });
    if (!nextId) await this.newTab(tab.workspaceId);
    else await this.activateTab(nextId);
  }

  async activateTab(tabId: string): Promise<void> {
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    this.hideAllViews();
    this.store.update((next) => {
      next.activeWorkspaceId = tab.workspaceId;
      next.activeTabByWorkspace[tab.workspaceId] = tab.id;
    });
    await this.showActiveTab();
  }

  async switchWorkspace(workspaceId: WorkspaceId): Promise<void> {
    if (!WORKSPACES.some((item) => item.id === workspaceId)) return;
    this.hideAllViews();
    this.store.update((state) => { state.activeWorkspaceId = workspaceId; });
    await this.showActiveTab();
  }

  goBack(): void {
    const contents = this.activeContents();
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  }

  goForward(): void {
    const contents = this.activeContents();
    if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  }

  reload(): void {
    this.activeContents()?.reload();
  }

  stop(): void {
    this.activeContents()?.stop();
  }

  toggleBookmark(): void {
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (tab.isHome) return;
    this.store.update((next) => {
      const existing = next.bookmarks.findIndex((item) => item.url === tab.url && item.workspaceId === tab.workspaceId);
      if (existing >= 0) next.bookmarks.splice(existing, 1);
      else next.bookmarks.unshift({ id: randomUUID(), title: tab.title, url: tab.url, workspaceId: tab.workspaceId, createdAt: new Date().toISOString() });
    });
    this.broadcast();
  }

  async openBookmark(id: string): Promise<void> {
    const bookmark = this.store.get().bookmarks.find((item) => item.id === id);
    if (!bookmark) return;
    await this.newTab(bookmark.workspaceId, bookmark.url);
  }

  toggleTrackerBlocking(): void {
    this.store.update((state) => { state.trackerBlocking = !state.trackerBlocking; });
    this.broadcast();
  }

  async prepareAiPreview(): Promise<AiPagePreview> {
    const state = this.store.get();
    const tab = this.activeTab(state);
    const workspace = WORKSPACES.find((item) => item.id === tab.workspaceId)!;
    if (workspace.protected || isProtectedPage(tab.url)) {
      this.addPrivacyEvent('blocked', 'AI access blocked', `Protected page: ${tab.title}`);
      throw new Error('AI access is disabled for protected and banking pages');
    }
    const contents = this.activeContents();
    if (!contents || tab.isHome) throw new Error('Open a webpage first');
    const rawText = await contents.executeJavaScript(`document.body ? document.body.innerText.slice(0, 20000) : ''`, true) as string;
    const result = redactSensitiveText(rawText);
    this.addPrivacyEvent('local-read', 'Local page preview', `${tab.title} · ${result.redactions} redaction(s)`);
    return { title: tab.title, url: tab.url, text: result.text.slice(0, 12000), redactions: result.redactions, protectedPage: false };
  }

  approveAiPreview(preview: AiPagePreview): AiPagePreview {
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (tab.url !== preview.url || isProtectedPage(preview.url)) throw new Error('The page changed or is protected');
    const safe = redactSensitiveText(preview.text);
    const approved = { ...preview, text: safe.text, redactions: preview.redactions + safe.redactions };
    this.addPrivacyEvent('cloud-approved', 'Cloud context approved', `${preview.title} · ${approved.redactions} redaction(s)`);
    return approved;
  }

  listVault() {
    return { available: this.vault.isAvailable(), items: this.vault.list() };
  }

  addVaultItem(input: VaultItemInput) {
    if (!input.label.trim() || !input.url.trim() || !input.username.trim() || !input.password) throw new Error('Complete all required fields');
    const normalizedUrl = normalizeNavigationInput(input.url);
    if (!isAllowedRemoteUrl(normalizedUrl)) throw new Error('Enter a valid website');
    const result = this.vault.add({ ...input, label: input.label.trim(), url: normalizedUrl, username: input.username.trim() });
    this.addPrivacyEvent('vault', 'Vault entry saved', input.label.trim());
    return result;
  }

  removeVaultItem(id: string): boolean {
    const removed = this.vault.remove(id);
    if (removed) this.addPrivacyEvent('vault', 'Vault entry removed', 'A credential was deleted');
    return removed;
  }

  revealPassword(id: string): string {
    this.addPrivacyEvent('vault', 'Password revealed', 'Explicit local reveal');
    return this.vault.revealPassword(id);
  }

  getTotp(id: string) {
    this.addPrivacyEvent('vault', 'Authenticator code generated', 'Generated locally');
    return this.vault.getTotp(id);
  }

  async autofill(id: string): Promise<void> {
    const contents = this.activeContents();
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (!contents || tab.isHome) throw new Error('Open the saved website first');
    const credential = this.vault.getForAutofill(id);
    if (new URL(credential.url).hostname !== new URL(tab.url).hostname) throw new Error('This credential belongs to another website');
    const payload = JSON.stringify({ username: credential.username, password: credential.password });
    await contents.executeJavaScript(`(() => {
      const credential = ${payload};
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const password = document.querySelector('input[type="password"]');
      const username = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i], input[name*="email" i]');
      if (username) setValue(username, credential.username);
      if (password) setValue(password, credential.password);
      if (!password) throw new Error('No password field found');
    })()`, true);
    this.addPrivacyEvent('vault', 'Credential autofilled', new URL(tab.url).hostname);
  }

  openDownload(id: string): void {
    const item = this.downloads.get(id);
    if (item?.state === 'completed' && item.savePath) void shell.openPath(item.savePath);
  }

  showDownload(id: string): void {
    const item = this.downloads.get(id);
    if (item?.savePath) shell.showItemInFolder(item.savePath);
  }

  private activeTab(state: PersistedState) {
    const id = state.activeTabByWorkspace[state.activeWorkspaceId];
    return state.tabs.find((tab) => tab.id === id) ?? state.tabs.find((tab) => tab.workspaceId === state.activeWorkspaceId) ?? state.tabs[0];
  }

  private activeContents() {
    const tab = this.activeTab(this.store.get());
    return this.runtimeTabs.get(tab.id)?.view?.webContents;
  }

  private ensureView(tabId: string): WebContentsView {
    const runtime = this.runtimeTabs.get(tabId)!;
    if (runtime.view) return runtime.view;
    const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId)!;
    const partition = `persist:private-browser-${tab.workspaceId}`;
    const ses = session.fromPartition(partition);
    this.configureSession(ses, partition);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    runtime.view = view;
    this.window.contentView.addChildView(view);
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedRemoteUrl(url)) void this.newTab(tab.workspaceId, url);
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedRemoteUrl(url)) event.preventDefault();
    });
    view.webContents.on('did-start-loading', () => this.updateRuntime(tabId, { loading: true }));
    view.webContents.on('did-stop-loading', () => this.updateRuntime(tabId, { loading: false }));
    view.webContents.on('did-navigate', (_event, url) => this.commitNavigation(tabId, url));
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) this.commitNavigation(tabId, url, false); });
    view.webContents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      this.store.update((state) => {
        const target = state.tabs.find((candidate) => candidate.id === tabId);
        if (target) target.title = title || 'Untitled';
      });
      this.broadcast();
    });
    view.webContents.on('page-favicon-updated', (_event, favicons) => this.updateRuntime(tabId, { favicon: favicons[0] }));
    view.webContents.on('before-input-event', (event, input) => this.handleShortcut(event, input));
    view.webContents.on('render-process-gone', () => this.updateRuntime(tabId, { loading: false }));
    return view;
  }

  private configureSession(ses: Session, partition: string): void {
    if (this.configuredSessions.has(partition)) return;
    this.configuredSessions.add(partition);
    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
    });
    ses.setPermissionCheckHandler((_webContents, permission) => permission === 'fullscreen' || permission === 'clipboard-sanitized-write');
    ses.webRequest.onBeforeRequest((details, callback) => {
      const blocking = this.store.get().trackerBlocking;
      let blocked = false;
      if (blocking) {
        try { blocked = TRACKER_HOSTS.some((host) => new URL(details.url).hostname.endsWith(host)); } catch { blocked = false; }
      }
      callback({ cancel: blocked });
    });
    ses.on('will-download', (_event, item) => {
      const id = randomUUID();
      const entry: DownloadEntry = {
        id,
        filename: item.getFilename(),
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
      };
      this.downloads.set(id, entry);
      item.on('updated', (_downloadEvent, state) => {
        Object.assign(entry, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state });
        this.broadcast();
      });
      item.once('done', (_downloadEvent, state) => {
        Object.assign(entry, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state, savePath: item.getSavePath() });
        this.broadcast();
      });
      this.broadcast();
    });
  }

  private async showActiveTab(): Promise<void> {
    const tab = this.activeTab(this.store.get());
    if (!tab.isHome && isAllowedRemoteUrl(tab.url)) {
      const view = this.ensureView(tab.id);
      view.setVisible(true);
      this.applyLayout();
      if (!view.webContents.getURL()) await view.webContents.loadURL(tab.url);
    }
    this.broadcast();
  }

  private hideAllViews(): void {
    for (const runtime of this.runtimeTabs.values()) runtime.view?.setVisible(false);
  }

  private applyLayout(): void {
    const state = this.store.get();
    const active = this.activeTab(state);
    const runtime = this.runtimeTabs.get(active.id);
    if (!runtime?.view || active.isHome || this.window.isDestroyed()) return;
    const [width, height] = this.window.getContentSize();
    runtime.view.setBounds({
      x: this.layout.left,
      y: this.layout.top,
      width: Math.max(100, width - this.layout.left - this.layout.right),
      height: Math.max(100, height - this.layout.top - this.layout.bottom),
    });
  }

  private updateRuntime(tabId: string, patch: Partial<RuntimeTab>): void {
    const runtime = this.runtimeTabs.get(tabId);
    if (!runtime) return;
    Object.assign(runtime, patch);
    if (runtime.view) {
      runtime.canGoBack = runtime.view.webContents.navigationHistory.canGoBack();
      runtime.canGoForward = runtime.view.webContents.navigationHistory.canGoForward();
    }
    this.broadcast();
  }

  private commitNavigation(tabId: string, url: string, addHistory = true): void {
    if (!isAllowedRemoteUrl(url)) return;
    this.store.update((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      tab.url = url;
      tab.isHome = false;
      if (addHistory) {
        state.history.unshift({ id: randomUUID(), title: tab.title, url, workspaceId: tab.workspaceId, visitedAt: new Date().toISOString() });
        state.history = state.history.slice(0, 500);
      }
    });
    this.updateRuntime(tabId, {});
  }

  private addPrivacyEvent(kind: PrivacyEvent['kind'], title: string, detail: string): void {
    this.store.update((state) => {
      state.privacyLog.unshift({ id: randomUUID(), at: new Date().toISOString(), kind, title, detail });
      state.privacyLog = state.privacyLog.slice(0, 100);
    });
    this.broadcast();
  }

  private handleShortcut(event: Electron.Event, input: Electron.Input): void {
    const command = input.control || input.meta;
    if (command && input.key.toLowerCase() === 'l') {
      event.preventDefault();
      this.window.webContents.send('browser:focus-address');
    } else if (command && input.key.toLowerCase() === 't') {
      event.preventDefault();
      void this.newTab();
    } else if (command && input.key.toLowerCase() === 'w') {
      event.preventDefault();
      void this.closeTab(this.activeTab(this.store.get()).id);
    } else if (command && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      this.reload();
    } else if (input.alt && input.key === 'Left') {
      event.preventDefault();
      this.goBack();
    } else if (input.alt && input.key === 'Right') {
      event.preventDefault();
      this.goForward();
    }
  }
}

let controller: BrowserController | undefined;

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!controller || event.sender !== BrowserWindow.getAllWindows()[0]?.webContents) throw new Error('Untrusted IPC sender');
}

function handle(channel: string, callback: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrusted(event);
    return callback(event, ...args);
  });
}

app.whenReady().then(async () => {
  const store = new StateStore(join(app.getPath('userData'), 'browser-state.json'));
  const vault = new VaultStore(join(app.getPath('userData'), 'vault.enc'));
  controller = new BrowserController(store, vault);

  handle('browser:get-state', () => controller!.getSnapshot());
  handle('browser:navigate', (_event, value: string) => controller!.navigate(value));
  handle('browser:back', () => controller!.goBack());
  handle('browser:forward', () => controller!.goForward());
  handle('browser:reload', () => controller!.reload());
  handle('browser:stop', () => controller!.stop());
  handle('browser:new-tab', (_event, workspaceId?: WorkspaceId, url?: string) => controller!.newTab(workspaceId, url));
  handle('browser:close-tab', (_event, id: string) => controller!.closeTab(id));
  handle('browser:activate-tab', (_event, id: string) => controller!.activateTab(id));
  handle('browser:switch-workspace', (_event, id: WorkspaceId) => controller!.switchWorkspace(id));
  handle('browser:set-layout', (_event, layout: Layout) => controller!.setLayout(layout));
  handle('browser:toggle-bookmark', () => controller!.toggleBookmark());
  handle('browser:open-bookmark', (_event, id: string) => controller!.openBookmark(id));
  handle('browser:toggle-tracker-blocking', () => controller!.toggleTrackerBlocking());
  handle('browser:open-download', (_event, id: string) => controller!.openDownload(id));
  handle('browser:show-download', (_event, id: string) => controller!.showDownload(id));
  handle('ai:prepare-preview', () => controller!.prepareAiPreview());
  handle('ai:approve-preview', (_event, preview: AiPagePreview) => controller!.approveAiPreview(preview));
  handle('vault:list', () => controller!.listVault());
  handle('vault:add', (_event, input: VaultItemInput) => controller!.addVaultItem(input));
  handle('vault:remove', (_event, id: string) => controller!.removeVaultItem(id));
  handle('vault:reveal', (_event, id: string) => controller!.revealPassword(id));
  handle('vault:totp', (_event, id: string) => controller!.getTotp(id));
  handle('vault:autofill', (_event, id: string) => controller!.autofill(id));
  handle('system:copy', (_event, value: string) => clipboard.writeText(String(value).slice(0, 100_000)));

  await controller.createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await controller!.createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
