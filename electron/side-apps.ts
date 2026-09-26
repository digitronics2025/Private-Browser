import { Menu, session, WebContentsView, type BrowserWindow, type HandlerDetails, type Session, type WindowOpenHandlerResponse } from 'electron';
import type { ContentInsets } from './chrome-layout.js';
import { adoptPopupWindow, popupWindowResponse, wantsPopupWindow } from './popup-windows.js';
import { downloadRisk, isAllowedRemoteUrl, stripTrackingParameters } from './security.js';
import { clampSideAppBounds, isSideAppUrl, SIDE_APP_IDS, sideAppDefinition, type SideAppCommand, type SideAppDefinition, type SideAppId, type SideAppRect, type SideAppSnapshot, type SideAppStatus } from './side-app-registry.js';
import type { PrivacyEvent } from './types.js';

/**
 * The side app's view. A side app is just another hostile remote page: its own
 * `WebContentsView` with no preload and no Node, its own session partition, and
 * no route to the page beside it — it cannot read, script or capture a tab. It
 * is pinned to its own hosts; every other link opens as an ordinary tab. The
 * rules it applies live in `side-app-registry.ts`.
 */

const POPUP_WINDOW_MS = 10_000;
const MAX_POPUPS_PER_WINDOW = 5;

export interface SideAppHostDeps {
  window: () => BrowserWindow | undefined;
  packaged: boolean;
  /** Open a link the app cannot keep as a tab in the active Account Space. */
  openInTab: (url: string) => void;
  handleShortcut: (event: Electron.Event, input: Electron.Input) => void;
  isBlockedRequest: (url: string) => boolean;
  privacyEvent: (kind: PrivacyEvent['kind'], title: string, detail: string) => void;
  changed: () => void;
}

interface SideAppRuntime {
  definition: SideAppDefinition;
  view?: WebContentsView;
  status: SideAppStatus;
  requested: SideAppRect | null;
}

export interface SideAppLayoutInput {
  insets: ContentInsets;
  contentWidth: number;
  contentHeight: number;
  /** Full screen, a menu over the chrome, or a protected workspace. */
  suppressed: boolean;
}

export class SideAppHost {
  private readonly apps = new Map<SideAppId, SideAppRuntime>();
  private readonly configuredSessions = new Set<string>();
  private lastLayout?: SideAppLayoutInput;

  constructor(private readonly deps: SideAppHostDeps) {
    for (const id of SIDE_APP_IDS) this.apps.set(id, { definition: sideAppDefinition(id, deps.packaged), status: 'idle', requested: null });
  }

  snapshot(): SideAppSnapshot[] {
    return [...this.apps.values()].map(({ definition, view, status }) => {
      const history = view && !view.webContents.isDestroyed() ? view.webContents.navigationHistory : undefined;
      return {
        id: definition.id,
        name: definition.name,
        status,
        canGoBack: history?.canGoBack() ?? false,
        canGoForward: history?.canGoForward() ?? false,
      };
    });
  }

  /** The renderer reports where the app's slot is on screen, or null when it is not showing. */
  setBounds(id: SideAppId, rect: SideAppRect | null): void {
    this.runtime(id).requested = rect;
    if (this.lastLayout) this.layout(this.lastLayout);
  }

  layout(input: SideAppLayoutInput): void {
    this.lastLayout = input;
    for (const runtime of this.apps.values()) {
      const bounds = !input.suppressed && runtime.requested
        ? clampSideAppBounds(runtime.requested, input.insets, input.contentWidth, input.contentHeight)
        : null;
      if (!bounds) {
        this.hide(runtime);
        continue;
      }
      const view = this.ensureView(runtime);
      if (!view) continue;
      view.setBounds(bounds);
      view.setVisible(true);
    }
  }

  async command(id: SideAppId, command: SideAppCommand): Promise<void> {
    const runtime = this.runtime(id);
    const contents = runtime.view && !runtime.view.webContents.isDestroyed() ? runtime.view.webContents : undefined;
    switch (command) {
      case 'back': if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); return;
      case 'forward': if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); return;
      case 'reload':
        if (!contents) return;
        // A crashed or never-loaded page has nothing to reload.
        if (runtime.status === 'crashed' || !contents.getURL()) await this.load(runtime, runtime.definition.homeUrl);
        else contents.reload();
        return;
      case 'home': if (contents) await this.load(runtime, runtime.definition.homeUrl); return;
      case 'open-in-tab': {
        const url = contents?.getURL();
        this.deps.openInTab(url && isSideAppUrl(runtime.definition, url) ? url : runtime.definition.homeUrl);
        return;
      }
    }
  }

  /** Sign out and forget everything the app stored: cookies, storage, cache. */
  async clearData(id: SideAppId): Promise<void> {
    const runtime = this.runtime(id);
    this.destroyView(runtime);
    const ses = session.fromPartition(runtime.definition.partition);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    runtime.status = 'idle';
    this.deps.privacyEvent('vault', `${runtime.definition.name} signed out`, `Cookies, storage and cache for the ${runtime.definition.name} side panel were deleted`);
    this.deps.changed();
    if (this.lastLayout) this.layout(this.lastLayout);
  }

  /** The window is closing: drop every view with it. */
  closeAll(): void {
    for (const runtime of this.apps.values()) this.destroyView(runtime);
  }

  private runtime(id: SideAppId): SideAppRuntime {
    const runtime = this.apps.get(id);
    if (!runtime) throw new Error('Unknown side app');
    return runtime;
  }

  private hide(runtime: SideAppRuntime): void {
    const view = runtime.view;
    if (!view || view.webContents.isDestroyed() || !view.getVisible()) return;
    // Keyboard focus must not stay inside a view nobody can see.
    const focused = view.webContents.isFocused();
    view.setVisible(false);
    const window = this.deps.window();
    if (focused && window && !window.isDestroyed()) window.webContents.focus();
  }

  private destroyView(runtime: SideAppRuntime): void {
    const view = runtime.view;
    runtime.view = undefined;
    if (!view) return;
    const window = this.deps.window();
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private ensureView(runtime: SideAppRuntime): WebContentsView | undefined {
    if (runtime.view && !runtime.view.webContents.isDestroyed()) return runtime.view;
    const window = this.deps.window();
    if (!window || window.isDestroyed()) return undefined;
    const { definition } = runtime;
    const ses = session.fromPartition(definition.partition);
    this.configureSession(ses, definition);
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
    view.setVisible(false);
    window.contentView.addChildView(view);
    this.guard(runtime, view, window);
    void this.load(runtime, definition.homeUrl);
    return view;
  }

  private async load(runtime: SideAppRuntime, url: string): Promise<void> {
    const contents = runtime.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    // Failures are reported through `did-fail-load`; the rejection adds nothing.
    await contents.loadURL(url).catch(() => undefined);
  }

  private setStatus(runtime: SideAppRuntime, status: SideAppStatus): void {
    if (runtime.status === status) return;
    runtime.status = status;
    this.deps.changed();
  }

  /** Every listener is attached before the first load, and none of them can throw. */
  private guard(runtime: SideAppRuntime, view: WebContentsView, window: BrowserWindow): void {
    const { definition } = runtime;
    const contents = view.webContents;
    const popupTimes: number[] = [];

    const openFromApp = ({ url, disposition }: HandlerDetails, popup?: BrowserWindow): WindowOpenHandlerResponse => {
      if (!isAllowedRemoteUrl(url)) return { action: 'deny' };
      const now = Date.now();
      while (popupTimes.length && now - popupTimes[0]! > POPUP_WINDOW_MS) popupTimes.shift();
      if (popupTimes.length >= MAX_POPUPS_PER_WINDOW) {
        this.deps.privacyEvent('blocked', 'Popups blocked', `The ${definition.name} side panel opened too many windows`);
        return { action: 'deny' };
      }
      popupTimes.push(now);
      const foreground = popup ? !popup.isDestroyed() && popup.isFocused() : contents.isFocused();
      // A sign-in window of the app's own needs `window.opener`; anything else is a link for a tab.
      if (foreground && wantsPopupWindow(disposition) && isSideAppUrl(definition, url)) return popupWindowResponse(window);
      this.deps.openInTab(stripTrackingParameters(url));
      return { action: 'deny' };
    };
    contents.setWindowOpenHandler((details) => openFromApp(details));
    contents.on('did-create-window', (child) => adoptPopupWindow(child, (popup) => (details) => openFromApp(details, popup)));

    contents.on('will-navigate', (event, url) => {
      if (!isAllowedRemoteUrl(url)) {
        event.preventDefault();
        return;
      }
      if (!isSideAppUrl(definition, url)) {
        // A plain link in an answer: the page belongs in a tab, not in the panel.
        event.preventDefault();
        this.deps.openInTab(stripTrackingParameters(url));
        return;
      }
      const sanitized = stripTrackingParameters(url);
      if (sanitized !== url) {
        event.preventDefault();
        void this.load(runtime, sanitized);
      }
    });
    contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame || (isAllowedRemoteUrl(url) && isSideAppUrl(definition, url))) return;
      event.preventDefault();
      this.deps.privacyEvent('blocked', `${definition.name} redirect blocked`, `The side panel may only visit ${definition.name}'s own sites`);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());

    contents.on('did-start-loading', () => this.setStatus(runtime, 'loading'));
    contents.on('did-stop-loading', () => { if (runtime.status === 'loading') this.setStatus(runtime, 'ready'); });
    contents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
      // -3 is an aborted load, which a newer navigation replaced.
      if (isMainFrame && errorCode !== -3) this.setStatus(runtime, 'failed');
    });
    contents.on('did-navigate', () => this.deps.changed());
    contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => { if (isMainFrame) this.deps.changed(); });
    contents.on('render-process-gone', () => this.setStatus(runtime, 'crashed'));
    contents.on('page-title-updated', (event) => event.preventDefault());
    contents.on('before-input-event', (event, input) => this.deps.handleShortcut(event, input));
    contents.on('context-menu', (_event, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [];
      if (params.linkURL && isAllowedRemoteUrl(params.linkURL)) {
        template.push({ label: 'Open link in new tab', click: () => this.deps.openInTab(stripTrackingParameters(params.linkURL)) }, { type: 'separator' });
      }
      if (params.isEditable) template.push({ role: 'cut', enabled: params.editFlags.canCut }, { role: 'copy', enabled: params.editFlags.canCopy }, { role: 'paste', enabled: params.editFlags.canPaste });
      else if (params.selectionText) template.push({ role: 'copy' });
      template.push({ role: 'selectAll' });
      Menu.buildFromTemplate(template).popup({ window });
    });
  }

  private configureSession(ses: Session, definition: SideAppDefinition): void {
    if (this.configuredSessions.has(definition.partition)) return;
    this.configuredSessions.add(definition.partition);
    // The copy button is the one capability a chat needs. No camera, microphone,
    // notifications, location or screen: the panel is a conversation, not a tab.
    const allowed = (permission: string, url: string | undefined, isMainFrame: boolean) =>
      permission === 'clipboard-sanitized-write' && isMainFrame && Boolean(url) && isSideAppUrl(definition, url!);
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => callback(allowed(permission, details.requestingUrl, details.isMainFrame)));
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => allowed(permission, details.requestingUrl ?? requestingOrigin, details.isMainFrame));
    ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: this.deps.isBlockedRequest(details.url) }));
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } });
    });
    // Files the app produces (documents, images, code) save through the native
    // dialog. Programs and disguised files never reach the disk.
    ses.on('will-download', (event, item) => {
      if (downloadRisk(item.getFilename()) === 'ordinary') return;
      event.preventDefault();
      this.deps.privacyEvent('blocked', `${definition.name} download blocked`, item.getFilename().slice(0, 300));
    });
  }
}
