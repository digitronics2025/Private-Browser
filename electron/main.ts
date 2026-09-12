import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  safeStorage,
  session,
  shell,
  WebContentsView,
  type IpcMainInvokeEvent,
  type Session,
} from 'electron';
import { downloadRisk, isAllowedRemoteUrl, isAllowedSitePermission, isAutofillTarget, isProtectedPage, navigationWarning, normalizeNavigationInput, redactSensitiveText, stripTrackingParameters, urlOriginForSharing } from './security.js';
import { ClipboardGuard } from './clipboard-guard.js';
import { verifyDownload, type ExpectedInstaller } from './download-verify.js';
import { AiProviderStore } from './ai-provider.js';
import { WORKSPACES } from './state-store.js';
import { AccountStore } from './account-store.js';
import { AccountSpaceStateStore } from './account-space-state.js';
import { RuntimeStateStore } from './runtime-state-store.js';
import type {
  AccountSpaceId,
  AiApproval,
  AiPagePreview,
  AiProviderInput,
  BrowserSnapshot,
  BrowserTab,
  DeveloperConsoleEntry,
  DeveloperNetworkIssue,
  DevToolsMode,
  DownloadEntry,
  PrivacyEvent,
  RuntimeBrowserStateV2,
  VaultItemInput,
  UpdateServiceInput,
  WorkspaceId,
} from './types.js';
import { VaultStore } from './vault.js';
import { UpdateServiceStore } from './update-service.js';
import { readUpdateBootstrap, removeUpdateBootstrap } from './update-bootstrap.js';
import { canUseDeveloperTools, makeDeveloperReport, sanitizeDiagnosticText, sanitizeDiagnosticUrl } from './developer-tools.js';
import { IpcGuard } from './ipc-guard.js';

interface RuntimeTab {
  view?: WebContentsView;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  favicon?: string;
  developerToolsOpen: boolean;
  console: Array<DeveloperConsoleEntry & { redactions: number }>;
  network: Array<DeveloperNetworkIssue & { redactions: number }>;
}

interface Layout {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

const FAVICON_TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_FAVICON_BYTES = 32 * 1024;

const TRACKER_HOSTS = [
  '2mdn.net',
  'adnxs.com',
  'adsrvr.org',
  'amazon-adsystem.com',
  'app-measurement.com',
  'clarity.ms',
  'criteo.com',
  'criteo.net',
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googleadservices.com',
  'googletagmanager.com',
  'connect.facebook.net',
  'fullstory.com',
  'analytics.twitter.com',
  'hotjar.com',
  'mixpanel.com',
  'newrelic.com',
  'optimizely.com',
  'segment.io',
  'scorecardresearch.com',
  'sentry.io',
  'taboola.com',
  'quantserve.com',
  'mc.yandex.ru',
];

class BrowserController {
  private readonly runtimeTabs = new Map<string, RuntimeTab>();
  private readonly downloads = new Map<string, DownloadEntry>();
  private readonly configuredSessions = new Set<string>();
  private readonly pendingAiPreviews = new Map<string, { preview: AiPagePreview; sourceUrl: string; expiresAt: number }>();
  private readonly aiApprovals = new Map<string, { preview: AiPagePreview; sourceUrl: string; expiresAt: number }>();
  private readonly clipboardGuard = new ClipboardGuard(clipboard);
  private readonly faviconCache = new Map<string, string>();
  private expectedInstaller?: ExpectedInstaller;
  private layout: Layout = { top: 128, left: 0, right: 366, bottom: 0 };
  private window!: BrowserWindow;

  constructor(
    private readonly store: RuntimeStateStore,
    private readonly vault: VaultStore,
    private readonly aiProvider: AiProviderStore,
    private readonly updates: UpdateServiceStore,
  ) {
    const state = this.store.get();
    const active = this.activeTab(state);
    this.runtimeTabs.set(active.id, this.newRuntimeTab());
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
      for (const runtime of this.runtimeTabs.values()) {
        runtime.view?.webContents.close();
        runtime.view = undefined;
      }
    });

    const devUrl = process.env.VITE_DEV_SERVER_URL;
    const productionUrl = pathToFileURL(join(import.meta.dirname, '../dist/index.html')).toString();
    const trustedDevelopmentOrigin = devUrl ? new URL(devUrl).origin : undefined;
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    this.window.webContents.on('will-navigate', (event, url) => {
      let allowed = url === productionUrl;
      try { allowed ||= Boolean(trustedDevelopmentOrigin && new URL(url).origin === trustedDevelopmentOrigin); } catch { allowed = false; }
      if (!allowed) event.preventDefault();
    });
    await this.window.loadURL(devUrl ?? productionUrl);

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
        developerToolsAllowed: canUseDeveloperTools(tab.workspaceId, tab.isHome, tab.url),
        developerToolsOpen: runtime?.developerToolsOpen ?? false,
        securityWarning: tab.isHome ? undefined : navigationWarning(tab.url),
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
      activeAccountSpaceId: this.activeAccountSpaceId(persisted),
      accountSpaces: persisted.accountSpaces,
      accountHealth: persisted.accountHealth,
      recovery: persisted.recovery,
    };
  }

  broadcast(): void {
    if (!this.window.isDestroyed()) this.window.webContents.send('browser:state', this.getSnapshot());
  }

  isTrustedSender(event: IpcMainInvokeEvent): boolean {
    return !this.window.isDestroyed()
      && event.sender === this.window.webContents
      && event.senderFrame === this.window.webContents.mainFrame;
  }

  focus(): void {
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
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
      runtime?.view?.webContents.closeDevTools();
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

  async newTab(workspaceId?: WorkspaceId, url = 'private://home', accountSpaceId?: AccountSpaceId): Promise<void> {
    const state = this.store.get();
    const targetWorkspace = WORKSPACES.some((item) => item.id === workspaceId) ? workspaceId! : state.activeWorkspaceId;
    const targetAccount = accountSpaceId ?? state.activeAccountSpaceByWorkspace[targetWorkspace];
    if (!targetAccount || !state.accountSpaces.some((account) => account.id === targetAccount && account.workspaceId === targetWorkspace)) {
      throw new Error('Account Space does not belong to the selected workspace');
    }
    const id = randomUUID();
    this.hideAllViews();
    this.store.update((next) => {
      next.activeWorkspaceId = targetWorkspace;
      next.activeAccountSpaceByWorkspace[targetWorkspace] = targetAccount;
      next.tabs.push({
        id,
        accountSpaceId: targetAccount,
        workspaceId: targetWorkspace,
        title: 'New tab',
        url: 'private://home',
        isHome: true,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        developerToolsAllowed: false,
        developerToolsOpen: false,
      });
      next.activeTabByAccountSpace[targetAccount] = id;
    });
    this.runtimeTabs.set(id, this.newRuntimeTab());
    this.broadcast();
    if (url !== 'private://home') await this.navigate(url);
  }

  async closeTab(tabId: string): Promise<void> {
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const accountTabs = state.tabs.filter((candidate) => candidate.accountSpaceId === tab.accountSpaceId);
    const closedIndex = accountTabs.findIndex((candidate) => candidate.id === tabId);
    const siblings = accountTabs.filter((candidate) => candidate.id !== tab.id);
    const nextId = siblings[Math.min(closedIndex, siblings.length - 1)]?.id;
    const wasActive = state.activeTabByAccountSpace[tab.accountSpaceId] === tabId;
    const runtime = this.runtimeTabs.get(tabId);
    if (runtime?.view) {
      this.window.contentView.removeChildView(runtime.view);
      runtime.view.webContents.close();
    }
    this.runtimeTabs.delete(tabId);
    this.store.update((next) => {
      next.tabs = next.tabs.filter((candidate) => candidate.id !== tabId);
      if (wasActive && nextId) next.activeTabByAccountSpace[tab.accountSpaceId] = nextId;
    });
    if (!nextId) await this.newTab(tab.workspaceId, 'private://home', tab.accountSpaceId);
    else if (wasActive) await this.activateTab(nextId);
    else this.broadcast();
  }

  async activateTab(tabId: string): Promise<void> {
    const state = this.store.get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    this.hideAllViews();
    this.store.update((next) => {
      next.activeWorkspaceId = tab.workspaceId;
      next.activeAccountSpaceByWorkspace[tab.workspaceId] = tab.accountSpaceId;
      next.activeTabByAccountSpace[tab.accountSpaceId] = tab.id;
    });
    await this.showActiveTab();
  }

  async switchWorkspace(workspaceId: WorkspaceId): Promise<void> {
    if (!WORKSPACES.some((item) => item.id === workspaceId)) return;
    this.hideAllViews();
    this.store.update((state) => { state.activeWorkspaceId = workspaceId; });
    await this.showActiveTab();
  }

  async switchAccountSpace(accountSpaceId: AccountSpaceId): Promise<void> {
    const state = this.store.get();
    const account = state.accountSpaces.find((candidate) => candidate.id === accountSpaceId);
    if (!account || account.workspaceId !== state.activeWorkspaceId) {
      throw new Error('Account Space does not belong to the active workspace');
    }
    if (account.locked || state.recovery?.accountSpaceId === accountSpaceId) {
      throw new Error('Account Space is locked or unavailable');
    }
    this.hideAllViews();
    this.store.update((next) => {
      next.activeAccountSpaceByWorkspace[next.activeWorkspaceId] = accountSpaceId;
    });
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
      const existing = next.bookmarks.findIndex((item) => item.url === tab.url && item.accountSpaceId === tab.accountSpaceId);
      if (existing >= 0) next.bookmarks.splice(existing, 1);
      else next.bookmarks.unshift({ id: randomUUID(), title: tab.title, url: tab.url, workspaceId: tab.workspaceId, accountSpaceId: tab.accountSpaceId, createdAt: new Date().toISOString() });
    });
    this.broadcast();
  }

  async openBookmark(id: string): Promise<void> {
    const bookmark = this.store.get().bookmarks.find((item) => item.id === id);
    if (!bookmark) return;
    await this.newTab(bookmark.workspaceId, bookmark.url, bookmark.accountSpaceId);
  }

  toggleTrackerBlocking(): void {
    this.store.update((state) => { state.trackerBlocking = !state.trackerBlocking; });
    this.broadcast();
  }

  toggleDeveloperTools(mode: DevToolsMode): void {
    if (!['right', 'bottom', 'detach'].includes(mode)) throw new Error('Unsupported DevTools position');
    const target = this.requireDeveloperTarget();
    if (target.contents.isDevToolsOpened()) target.contents.closeDevTools();
    else target.contents.openDevTools({ mode, activate: true, title: `Private Browser DevTools — ${target.tab.title}` });
  }

  async captureDeveloperDiagnostics() {
    const target = this.requireDeveloperTarget();
    const sourceUrl = target.tab.url;
    const rawPage = await target.contents.executeJavaScript(`(() => ({
      title: document.title || '',
      readyState: document.readyState,
      language: document.documentElement.lang || '',
      scripts: document.scripts.length,
      stylesheets: document.styleSheets.length,
      images: document.images.length,
      links: document.links.length,
      forms: document.forms.length,
      iframes: document.querySelectorAll('iframe').length
    }))()`, true) as {
      title: string;
      readyState: string;
      language: string;
      scripts: number;
      stylesheets: number;
      images: number;
      links: number;
      forms: number;
      iframes: number;
    };

    const current = this.requireDeveloperTarget();
    if (current.tab.id !== target.tab.id || current.tab.url !== sourceUrl) throw new Error('The page changed; capture diagnostics again');
    const title = sanitizeDiagnosticText(rawPage.title, 300);
    const language = sanitizeDiagnosticText(String(rawPage.language ?? ''), 50);
    const url = sanitizeDiagnosticUrl(sourceUrl);
    const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(Number(value), 1_000_000) : 0;
    const console = current.runtime.console.slice(-50).map(({ redactions: _redactions, ...entry }) => entry);
    const network = current.runtime.network.slice(-50).map(({ redactions: _redactions, ...entry }) => entry);
    const redactions = title.redactions + language.redactions + url.redactions
      + current.runtime.console.slice(-50).reduce((sum, entry) => sum + entry.redactions, 0)
      + current.runtime.network.slice(-50).reduce((sum, entry) => sum + entry.redactions, 0);
    const report = makeDeveloperReport({
      capturedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      page: {
        title: title.text,
        url: url.text,
        readyState: ['loading', 'interactive', 'complete'].includes(rawPage.readyState) ? rawPage.readyState : 'unknown',
        language: language.text,
        scripts: count(rawPage.scripts),
        stylesheets: count(rawPage.stylesheets),
        images: count(rawPage.images),
        links: count(rawPage.links),
        forms: count(rawPage.forms),
        iframes: count(rawPage.iframes),
      },
      console,
      network,
      redactions,
    });
    this.addPrivacyEvent('local-read', 'Developer diagnostics captured', `${title.text || 'Untitled'} · ${redactions} redaction(s)`);
    return report;
  }

  clearDeveloperDiagnostics(): void {
    const target = this.requireDeveloperTarget();
    target.runtime.console.length = 0;
    target.runtime.network.length = 0;
    this.broadcast();
  }

  async prepareAiPreview(): Promise<AiPagePreview> {
    this.pruneAiCapabilities();
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
    const safeTitle = redactSensitiveText(tab.title);
    const preview: AiPagePreview = { id: randomUUID(), title: safeTitle.text, url: urlOriginForSharing(tab.url), text: result.text.slice(0, 12000), redactions: result.redactions + safeTitle.redactions, protectedPage: false };
    this.pendingAiPreviews.set(preview.id, { preview, sourceUrl: tab.url, expiresAt: Date.now() + 5 * 60_000 });
    return preview;
  }

  approveAiPreview(previewId: string): AiApproval {
    const pending = this.pendingAiPreviews.get(previewId);
    this.pendingAiPreviews.delete(previewId);
    if (!pending || pending.expiresAt < Date.now()) throw new Error('The page preview expired; read the page again');
    const preview = pending.preview;
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (tab.url !== pending.sourceUrl || isProtectedPage(tab.url)) throw new Error('The page changed or is protected');
    const token = randomUUID();
    this.aiApprovals.set(token, { preview, sourceUrl: pending.sourceUrl, expiresAt: Date.now() + 5 * 60_000 });
    this.addPrivacyEvent('cloud-approved', 'Cloud context approved', `${preview.title} · ${preview.redactions} redaction(s)`);
    return { token, preview };
  }

  getAiProvider() {
    return this.aiProvider.status();
  }

  configureAiProvider(input: AiProviderInput) {
    const status = this.aiProvider.configure(input);
    this.addPrivacyEvent('vault', 'AI provider configured', status.endpoint ?? 'Encrypted provider');
    return status;
  }

  clearAiProvider() {
    const status = this.aiProvider.clear();
    this.addPrivacyEvent('vault', 'AI provider removed', 'Encrypted provider credentials cleared');
    return status;
  }

  async askAi(token: string, questionValue: string): Promise<string> {
    const approval = this.aiApprovals.get(token);
    this.aiApprovals.delete(token);
    const question = questionValue.trim();
    if (!approval || approval.expiresAt < Date.now()) throw new Error('AI approval expired; approve the page again');
    if (!question || question.length > 2000) throw new Error('Enter a question under 2,000 characters');
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (tab.url !== approval.sourceUrl || isProtectedPage(tab.url)) throw new Error('The page changed or is protected');
    const answer = await this.aiProvider.ask(approval.preview, question);
    this.addPrivacyEvent('cloud-approved', 'Cloud AI request completed', approval.preview.title);
    return answer;
  }

  /**
   * Drop every pending preview and live approval.
   *
   * Clearing the panel used to only make the renderer forget the token, leaving
   * the captured page text and the capability itself alive in this process for
   * the full five minutes. There was no way for the UI to undo an approval it
   * had just offered.
   */
  revokeAiContext(): void {
    const had = this.pendingAiPreviews.size + this.aiApprovals.size;
    this.pendingAiPreviews.clear();
    this.aiApprovals.clear();
    if (had) this.addPrivacyEvent('blocked', 'Cloud context revoked', 'The approved page text was discarded before it was used');
  }

  listVault() {
    return { available: this.vault.isAvailable(), reason: this.vault.reason(), items: this.vault.list() };
  }

  addVaultItem(input: VaultItemInput) {
    if (!input.label.trim() || !input.url.trim() || !input.username.trim() || !input.password) throw new Error('Complete all required fields');
    if (input.label.length > 200 || input.url.length > 2000 || input.username.length > 500 || input.password.length > 5000 || (input.totpSecret?.length ?? 0) > 500) throw new Error('A vault field is too long');
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

  resetCorruptVault(): boolean {
    const reset = this.vault.resetCorrupt();
    if (reset) this.addPrivacyEvent('vault', 'Corrupt vault reset', 'The unreadable encrypted file was preserved as a backup');
    return reset;
  }

  copyPassword(id: string): void {
    this.copySensitiveValue(this.vault.getPassword(id));
    this.addPrivacyEvent('vault', 'Password copied', 'Clipboard clears automatically after 30 seconds');
  }

  copyTotp(id: string): { secondsRemaining: number } {
    const result = this.vault.getTotp(id);
    this.copySensitiveValue(result.code);
    this.addPrivacyEvent('vault', 'Authenticator code copied', 'Generated locally; clipboard auto-clear enabled');
    return { secondsRemaining: result.secondsRemaining };
  }

  /** Clear a still-pending copied secret now — used on quit, so exiting inside
   *  the 30-second window does not leave a password on the clipboard. */
  async flushClipboard(): Promise<void> {
    await this.clipboardGuard.flush();
  }

  async autofill(id: string): Promise<void> {
    const contents = this.activeContents();
    const state = this.store.get();
    const tab = this.activeTab(state);
    if (!contents || tab.isHome) throw new Error('Open the saved website first');
    const credential = this.vault.getForAutofill(id);
    if (!isAutofillTarget(credential.url, tab.url)) throw new Error('This credential belongs to another website, or this page is not secure');
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
    if (!item || item.state !== 'completed' || !item.savePath) return;
    // A file whose checksum did not match the manifest is the one case where the
    // app knows something is wrong; opening it anyway would waste the check.
    if (item.checksum === 'mismatch') throw new Error('This download does not match the published checksum and will not be opened. Delete it and download again.');
    if (item.risk !== 'ordinary' && item.checksum !== 'verified') {
      throw new Error('Private Browser will not open executable or deceptive downloads unless they match a verified Private Browser release. Review the file in its folder and scan it first.');
    }
    void shell.openPath(item.savePath);
  }

  showDownload(id: string): void {
    const item = this.downloads.get(id);
    if (item?.savePath) shell.showItemInFolder(item.savePath);
  }

  isDefaultBrowser(): boolean {
    return app.isDefaultProtocolClient('http') && app.isDefaultProtocolClient('https');
  }

  setDefaultBrowser(): boolean {
    const http = app.setAsDefaultProtocolClient('http');
    const https = app.setAsDefaultProtocolClient('https');
    return http && https;
  }

  getUpdateService() {
    return this.updates.status(app.getVersion());
  }

  configureUpdateService(input: UpdateServiceInput) {
    const status = this.updates.configure(input, app.getVersion());
    this.addPrivacyEvent('vault', 'Download service connected', status.endpoint ?? 'Encrypted update service');
    return status;
  }

  clearUpdateService() {
    const status = this.updates.clear(app.getVersion());
    this.addPrivacyEvent('vault', 'Download service disconnected', 'Encrypted access token removed');
    return status;
  }

  async checkForUpdates() {
    const result = await this.updates.check(app.getVersion());
    this.expectedInstaller = { filename: result.latest.filename, sha256: result.latest.sha256.toLowerCase(), sizeBytes: result.latest.sizeBytes };
    return result;
  }

  async openUpdatePage(): Promise<void> {
    const result = await this.checkForUpdates();
    await this.newTab('development', result.latest.downloadPageUrl);
  }

  async checkForUpdatesInBackground(): Promise<void> {
    if (!this.getUpdateService().configured || this.window.isDestroyed()) return;
    try {
      const result = await this.checkForUpdates();
      if (result.state === 'available') this.window.webContents.send('updates:available', result);
    } catch {
      // Background checks stay quiet; explicit checks show actionable errors.
    }
  }

  private activeAccountSpaceId(state: RuntimeBrowserStateV2): AccountSpaceId {
    const id = state.activeAccountSpaceByWorkspace[state.activeWorkspaceId];
    if (!id) throw new Error('The active workspace has no Account Space');
    return id;
  }

  private activeTab(state: RuntimeBrowserStateV2) {
    const accountSpaceId = this.activeAccountSpaceId(state);
    const id = state.activeTabByAccountSpace[accountSpaceId];
    const tab = state.tabs.find((candidate) => candidate.id === id && candidate.accountSpaceId === accountSpaceId)
      ?? state.tabs.find((candidate) => candidate.accountSpaceId === accountSpaceId);
    if (!tab) throw new Error('The active Account Space has no tab');
    return tab;
  }

  private newRuntimeTab(): RuntimeTab {
    return { loading: false, canGoBack: false, canGoForward: false, developerToolsOpen: false, console: [], network: [] };
  }

  private developerTarget(tabId = this.activeTab(this.store.get()).id) {
    const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId);
    const runtime = this.runtimeTabs.get(tabId);
    const contents = runtime?.view?.webContents;
    if (!tab || !runtime || !contents || !canUseDeveloperTools(tab.workspaceId, tab.isHome, tab.url)) return undefined;
    return { tab, runtime, contents };
  }

  private requireDeveloperTarget() {
    const target = this.developerTarget();
    if (!target) throw new Error('Developer tools are available only for non-protected pages in the Development workspace');
    return target;
  }

  private recordConsoleMessage(tabId: string, details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void {
    if (details.level !== 'warning' && details.level !== 'error') return;
    const target = this.developerTarget(tabId);
    if (!target || (details.sourceId && isProtectedPage(details.sourceId))) return;
    const message = sanitizeDiagnosticText(details.message);
    const source = sanitizeDiagnosticUrl(details.sourceId);
    target.runtime.console.push({
      at: new Date().toISOString(),
      level: details.level,
      message: message.text,
      source: source.text,
      line: Math.max(0, details.lineNumber || 0),
      redactions: message.redactions + source.redactions,
    });
    if (target.runtime.console.length > 100) target.runtime.console.splice(0, target.runtime.console.length - 100);
  }

  private recordNetworkIssue(details: Electron.OnCompletedListenerDetails | Electron.OnErrorOccurredListenerDetails): void {
    if (!details.webContentsId || isProtectedPage(details.url)) return;
    const match = [...this.runtimeTabs.entries()].find(([, runtime]) => runtime.view?.webContents.id === details.webContentsId);
    if (!match) return;
    const target = this.developerTarget(match[0]);
    if (!target) return;
    const url = sanitizeDiagnosticUrl(details.url);
    const error = sanitizeDiagnosticText(details.error || '', 300);
    target.runtime.network.push({
      at: new Date().toISOString(),
      method: details.method.slice(0, 16),
      resourceType: details.resourceType,
      url: url.text,
      ...('statusCode' in details ? { status: details.statusCode } : {}),
      ...(error.text ? { error: error.text } : {}),
      redactions: url.redactions + error.redactions,
    });
    if (target.runtime.network.length > 100) target.runtime.network.splice(0, target.runtime.network.length - 100);
  }

  private activeContents() {
    const tab = this.activeTab(this.store.get());
    return this.runtimeTabs.get(tab.id)?.view?.webContents;
  }

  private ensureView(tabId: string): WebContentsView {
    let runtime = this.runtimeTabs.get(tabId);
    if (!runtime) {
      runtime = this.newRuntimeTab();
      this.runtimeTabs.set(tabId, runtime);
    }
    if (runtime.view) return runtime.view;
    const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId)!;
    const partition = this.store.partitionFor(tab.accountSpaceId);
    const ses = session.fromPartition(partition);
    this.configureSession(ses, partition, tab.workspaceId, tab.accountSpaceId);
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
      if (tab.workspaceId === 'banking') {
        this.addPrivacyEvent('blocked', 'Popup blocked in Banking', 'Banking pages cannot open new tabs');
      } else if (isAllowedRemoteUrl(url)) {
        void this.newTab(tab.workspaceId, stripTrackingParameters(url), tab.accountSpaceId);
      }
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedRemoteUrl(url)) {
        event.preventDefault();
        return;
      }
      const sanitized = stripTrackingParameters(url);
      if (sanitized !== url) {
        event.preventDefault();
        void view.webContents.loadURL(sanitized);
      }
    });
    view.webContents.on('will-redirect', (event, url) => {
      if (!isAllowedRemoteUrl(url)) {
        event.preventDefault();
        return;
      }
      const sanitized = stripTrackingParameters(url);
      if (sanitized !== url) {
        event.preventDefault();
        void view.webContents.loadURL(sanitized);
      }
    });
    view.webContents.on('will-attach-webview', (event) => event.preventDefault());
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
    view.webContents.on('page-favicon-updated', (_event, favicons) => void this.updateFavicon(tabId, ses, favicons[0]));
    view.webContents.on('devtools-opened', () => this.updateRuntime(tabId, { developerToolsOpen: true }));
    view.webContents.on('devtools-closed', () => this.updateRuntime(tabId, { developerToolsOpen: false }));
    view.webContents.on('console-message', (details) => this.recordConsoleMessage(tabId, details));
    view.webContents.on('context-menu', (_event, params) => {
      if (!this.developerTarget(tabId)) return;
      Menu.buildFromTemplate([
        { label: 'Inspect element', click: () => {
          view.webContents.inspectElement(params.x, params.y);
          if (!view.webContents.isDevToolsOpened()) view.webContents.openDevTools({ mode: 'right', activate: true });
        } },
        { type: 'separator' },
        { label: 'Reload', click: () => view.webContents.reload() },
      ]).popup({ window: this.window });
    });
    view.webContents.on('before-input-event', (event, input) => this.handleShortcut(event, input));
    view.webContents.on('render-process-gone', () => this.updateRuntime(tabId, { loading: false }));
    return view;
  }

  private configureSession(ses: Session, partition: string, workspaceId: WorkspaceId, accountSpaceId: AccountSpaceId): void {
    if (this.configuredSessions.has(partition)) return;
    this.configuredSessions.add(partition);
    ses.setUserAgent(ses.getUserAgent().replace(/\sElectron\/\S+/g, '').replace(/\sPrivate Browser\/\S+/g, ''));
    const protectedWorkspace = WORKSPACES.find((workspace) => workspace.id === workspaceId)!.protected;
    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      callback(isAllowedSitePermission(permission, details.requestingUrl, protectedWorkspace, details.isMainFrame));
    });
    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => (
      isAllowedSitePermission(permission, details.requestingUrl ?? requestingOrigin, protectedWorkspace, details.isMainFrame)
    ));
    ses.webRequest.onBeforeRequest((details, callback) => {
      const blocking = this.store.get().trackerBlocking;
      let blocked = false;
      if (blocking) {
        try {
          const hostname = new URL(details.url).hostname;
          blocked = TRACKER_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
        } catch { blocked = false; }
      }
      callback({ cancel: blocked });
    });
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } });
    });
    ses.webRequest.onCompleted((details) => {
      if (details.statusCode >= 400) this.recordNetworkIssue(details);
    });
    ses.webRequest.onErrorOccurred((details) => this.recordNetworkIssue(details));
    ses.on('will-download', (event, item) => {
      if (protectedWorkspace) {
        event.preventDefault();
        this.addPrivacyEvent('blocked', 'Download blocked in Banking', item.getFilename().slice(0, 300));
        return;
      }
      const id = randomUUID();
      const entry: DownloadEntry = {
        id,
        accountSpaceId,
        filename: item.getFilename(),
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        state: 'progressing',
        risk: downloadRisk(item.getFilename()),
      };
      this.downloads.set(id, entry);
      item.on('updated', (_downloadEvent, state) => {
        Object.assign(entry, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state });
        this.broadcast();
      });
      item.once('done', (_downloadEvent, state) => {
        Object.assign(entry, { receivedBytes: item.getReceivedBytes(), totalBytes: item.getTotalBytes(), state, savePath: item.getSavePath() });
        this.broadcast();
        if (state !== 'completed') return;
        void verifyDownload(entry.savePath ?? '', entry.filename, this.expectedInstaller).then((checksum) => {
          if (checksum === 'unchecked') return;
          entry.checksum = checksum;
          this.addPrivacyEvent(
            checksum === 'verified' ? 'vault' : 'blocked',
            checksum === 'verified' ? 'Installer checksum verified' : 'Installer checksum did NOT match',
            checksum === 'verified'
              ? `${entry.filename} matches the signed release manifest`
              : `${entry.filename} does not match the published checksum — do not run it`,
          );
          this.broadcast();
        });
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
    for (const runtime of this.runtimeTabs.values()) {
      runtime.view?.webContents.closeDevTools();
      runtime.view?.setVisible(false);
    }
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

  /**
   * Fetch a page's favicon inside that page's OWN session partition and hand the
   * renderer an inert `data:` URL.
   *
   * The chrome window has no partition of its own, so rendering the page-chosen
   * URL directly in an `<img>` made the trusted window fetch it on the default
   * session: outside tracker blocking, and shared by all five workspaces, which
   * let a site correlate activity across them — including Banking. Doing the
   * fetch here keeps it inside the workspace's cookie jar and behind the same
   * request filter as the page itself, and lets the renderer CSP drop `https:`
   * from `img-src` entirely.
   */
  private async updateFavicon(tabId: string, ses: Session, url?: string): Promise<void> {
    if (!url) {
      this.updateRuntime(tabId, { favicon: undefined });
      return;
    }
    const tab = this.store.get().tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const cacheKey = `${tab.accountSpaceId}:${url}`;
    const cached = this.faviconCache.get(cacheKey);
    if (cached) {
      this.updateRuntime(tabId, { favicon: cached });
      return;
    }
    if (!isAllowedRemoteUrl(url)) return;
    try {
      const response = await ses.fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'follow' });
      if (!response.ok) return;
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!FAVICON_TYPES.has(type)) return;
      const bytes = Buffer.from(await response.arrayBuffer());
      // The icon rides along in every state broadcast, so keep it small.
      if (!bytes.byteLength || bytes.byteLength > MAX_FAVICON_BYTES) return;
      const dataUrl = `data:${type};base64,${bytes.toString('base64')}`;
      if (this.faviconCache.size >= 200) this.faviconCache.delete(this.faviconCache.keys().next().value!);
      this.faviconCache.set(cacheKey, dataUrl);
      this.updateRuntime(tabId, { favicon: dataUrl });
    } catch {
      // A site without a reachable icon is ordinary, not an error worth showing.
    }
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
    const sanitizedUrl = stripTrackingParameters(url);
    if (isProtectedPage(sanitizedUrl)) this.runtimeTabs.get(tabId)?.view?.webContents.closeDevTools();
    this.store.update((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return;
      tab.url = sanitizedUrl;
      tab.isHome = false;
      if (addHistory && tab.workspaceId !== 'banking') {
        state.history.unshift({ id: randomUUID(), title: tab.title, url: sanitizedUrl, workspaceId: tab.workspaceId, accountSpaceId: tab.accountSpaceId, visitedAt: new Date().toISOString() });
        state.history = state.history.slice(0, 2500);
      }
    });
    this.updateRuntime(tabId, {});
  }

  private addPrivacyEvent(kind: PrivacyEvent['kind'], title: string, detail: string): void {
    this.store.update((state) => {
      const accountSpaceId = state.activeAccountSpaceByWorkspace[state.activeWorkspaceId];
      state.privacyLog.unshift({ id: randomUUID(), at: new Date().toISOString(), kind, title, detail, accountSpaceId, service: kind === 'vault' ? 'vault' : 'browser' });
      state.privacyLog = state.privacyLog.slice(0, 100);
    });
    this.broadcast();
  }

  private copySensitiveValue(value: string): void {
    this.clipboardGuard.copy(value);
  }

  private pruneAiCapabilities(): void {
    const now = Date.now();
    for (const [id, item] of this.pendingAiPreviews) if (item.expiresAt < now) this.pendingAiPreviews.delete(id);
    for (const [id, item] of this.aiApprovals) if (item.expiresAt < now) this.aiApprovals.delete(id);
    while (this.pendingAiPreviews.size > 20) this.pendingAiPreviews.delete(this.pendingAiPreviews.keys().next().value!);
    while (this.aiApprovals.size > 20) this.aiApprovals.delete(this.aiApprovals.keys().next().value!);
  }

  private handleShortcut(event: Electron.Event, input: Electron.Input): void {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const command = input.control || input.meta;
    const key = input.key.toLowerCase();
    if (input.key === 'F12' || (command && input.shift && key === 'i')) {
      event.preventDefault();
      void Promise.resolve().then(() => this.toggleDeveloperTools('right')).catch(() => undefined);
    } else if (command && key === 'l') {
      event.preventDefault();
      this.window.webContents.send('browser:focus-address');
    } else if (command && key === 't') {
      event.preventDefault();
      void this.newTab();
    } else if (command && key === 'w') {
      event.preventDefault();
      void this.closeTab(this.activeTab(this.store.get()).id);
    } else if (command && key === 'r') {
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
let pendingLaunchUrl = process.argv.find((argument) => isAllowedRemoteUrl(argument));
app.enableSandbox();
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'default_public_interface_only');
app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
  event.preventDefault();
  callback(false);
});
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const url = commandLine.find((argument) => isAllowedRemoteUrl(argument));
    if (url) void controller?.newTab(undefined, url);
    controller?.focus();
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (isAllowedRemoteUrl(url)) {
      if (controller) void controller.newTab(undefined, url);
      else pendingLaunchUrl = url;
    }
  });
}

function assertTrusted(event: IpcMainInvokeEvent): void {
  if (!controller?.isTrustedSender(event)) throw new Error('Untrusted IPC sender');
}

const ipcGuard = new IpcGuard();

function handle(channel: string, callback: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrusted(event);
    ipcGuard.check(event.sender.id, args);
    return callback(event, ...args);
  });
}

if (hasSingleInstanceLock) void app.whenReady().then(async () => {
  const userDataPath = app.getPath('userData');
  const accountStore = new AccountStore(join(userDataPath, 'account-spaces'), safeStorage);
  const persistedState = new AccountSpaceStateStore({
    paths: {
      legacyFilePath: join(userDataPath, 'browser-state.json'),
      manifestFilePath: join(userDataPath, 'browser-state-v2.json'),
      accountStateDirectory: join(userDataPath, 'account-browsing'),
      migrationJournalPath: join(userDataPath, 'browser-state-v2.migration.json'),
    },
    accountStore,
  });
  const store = new RuntimeStateStore(persistedState, accountStore, persistedState.initialize());
  const vault = new VaultStore(join(userDataPath, 'vault.enc'));
  const aiProvider = new AiProviderStore(join(userDataPath, 'ai-provider.enc'));
  const updates = new UpdateServiceStore(join(userDataPath, 'update-service.enc'));
  const updateBootstrapPath = join(process.resourcesPath, 'private-browser-update.json');
  try {
    const updateBootstrap = readUpdateBootstrap(updateBootstrapPath);
    if (updateBootstrap) updates.bootstrap(updateBootstrap, app.getVersion());
  } catch {
    console.error('update_bootstrap_invalid');
  } finally {
    // Remove the plaintext bootstrap whatever happened to it. Previously it was
    // deleted only when it had been stored successfully, so on a machine with no
    // OS encryption — exactly the machine least able to protect it — the shared
    // download token stayed readable in the install directory forever. Losing the
    // convenience of first-launch enrolment is the cheaper failure.
    removeUpdateBootstrap(updateBootstrapPath);
  }
  controller = new BrowserController(store, vault, aiProvider, updates);

  handle('browser:get-state', () => controller!.getSnapshot());
  handle('browser:navigate', (_event, value: string) => controller!.navigate(value));
  handle('browser:back', () => controller!.goBack());
  handle('browser:forward', () => controller!.goForward());
  handle('browser:reload', () => controller!.reload());
  handle('browser:stop', () => controller!.stop());
  handle('browser:new-tab', (_event, workspaceId?: WorkspaceId, url?: string, accountSpaceId?: AccountSpaceId) => controller!.newTab(workspaceId, url, accountSpaceId));
  handle('browser:close-tab', (_event, id: string) => controller!.closeTab(id));
  handle('browser:activate-tab', (_event, id: string) => controller!.activateTab(id));
  handle('browser:switch-workspace', (_event, id: WorkspaceId) => controller!.switchWorkspace(id));
  handle('browser:switch-account-space', (_event, id: AccountSpaceId) => controller!.switchAccountSpace(id));
  handle('browser:set-layout', (_event, layout: Layout) => controller!.setLayout(layout));
  handle('browser:toggle-bookmark', () => controller!.toggleBookmark());
  handle('browser:open-bookmark', (_event, id: string) => controller!.openBookmark(id));
  handle('browser:toggle-tracker-blocking', () => controller!.toggleTrackerBlocking());
  handle('browser:open-download', (_event, id: string) => controller!.openDownload(id));
  handle('browser:show-download', (_event, id: string) => controller!.showDownload(id));
  handle('developer:toggle-tools', (_event, mode: DevToolsMode) => controller!.toggleDeveloperTools(mode));
  handle('developer:capture-diagnostics', () => controller!.captureDeveloperDiagnostics());
  handle('developer:clear-diagnostics', () => controller!.clearDeveloperDiagnostics());
  handle('ai:prepare-preview', () => controller!.prepareAiPreview());
  handle('ai:approve-preview', (_event, previewId: string) => controller!.approveAiPreview(previewId));
  handle('ai:provider-status', () => controller!.getAiProvider());
  handle('ai:configure-provider', (_event, input: AiProviderInput) => controller!.configureAiProvider(input));
  handle('ai:clear-provider', () => controller!.clearAiProvider());
  handle('ai:ask', (_event, token: string, question: string) => controller!.askAi(token, question));
  handle('ai:revoke', () => controller!.revokeAiContext());
  handle('vault:list', () => controller!.listVault());
  handle('vault:add', (_event, input: VaultItemInput) => controller!.addVaultItem(input));
  handle('vault:remove', (_event, id: string) => controller!.removeVaultItem(id));
  handle('vault:reset-corrupt', () => controller!.resetCorruptVault());
  handle('vault:copy-password', (_event, id: string) => controller!.copyPassword(id));
  handle('vault:copy-totp', (_event, id: string) => controller!.copyTotp(id));
  handle('vault:autofill', (_event, id: string) => controller!.autofill(id));
  handle('system:copy', (_event, value: string) => clipboard.writeText(String(value).slice(0, 100_000)));
  handle('system:is-default-browser', () => controller!.isDefaultBrowser());
  handle('system:set-default-browser', () => controller!.setDefaultBrowser());
  handle('updates:status', () => controller!.getUpdateService());
  handle('updates:configure', (_event, input: UpdateServiceInput) => controller!.configureUpdateService(input));
  handle('updates:clear', () => controller!.clearUpdateService());
  handle('updates:check', () => controller!.checkForUpdates());
  handle('updates:open-page', () => controller!.openUpdatePage());

  await controller.createWindow();
  setTimeout(() => void controller?.checkForUpdatesInBackground(), 10_000).unref();
  setInterval(() => void controller?.checkForUpdatesInBackground(), 24 * 60 * 60_000).unref();
  if (pendingLaunchUrl) {
    const url = pendingLaunchUrl;
    pendingLaunchUrl = undefined;
    await controller.newTab(undefined, url);
  }
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await controller!.createWindow();
  });
});

app.on('before-quit', () => {
  void controller?.flushClipboard();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
