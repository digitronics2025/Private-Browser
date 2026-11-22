import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BrowserWindow, WebContentsView, dialog, ipcMain, session } from 'electron';
import { guardPageNavigation } from './popup-windows.js';
import { isAllowedRemoteUrl, isProtectedPage, navigationWarning, parseWebAddress } from './security.js';
import { temporaryBrowsingHtml, TEMPORARY_TOOLBAR_HEIGHT } from './temporary-browsing-chrome.js';
import { trackerCategory } from './tracker-protection.js';
import type { AccountSpaceId } from './types.js';

interface BookmarkDestination { id: AccountSpaceId; label: string }
interface TemporaryWindow {
  window: BrowserWindow;
  view: WebContentsView;
  destination: BookmarkDestination;
  notice: string;
  ready: boolean;
  confirming: boolean;
}

export class TemporaryBrowsing {
  private current?: TemporaryWindow;

  constructor(private readonly saveBookmark: (destination: AccountSpaceId, url: string, title: string) => void) {
    ipcMain.handle('temporary:command', async (event, command: unknown, value?: unknown) => {
      const current = this.current;
      if (!current?.ready || current.window.isDestroyed() || event.sender !== current.window.webContents
        || event.senderFrame !== current.window.webContents.mainFrame || current.view.webContents.isDestroyed()) throw new Error('Temporary browsing window is unavailable.');
      return this.command(current, command, value);
    });
  }

  async open(parent: BrowserWindow, destination: BookmarkDestination): Promise<void> {
    if (this.current && !this.current.window.isDestroyed()) {
      const { window } = this.current;
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    const chromeSession = session.fromPartition(`temporary-chrome-${randomUUID()}`, { cache: false });
    const guestSession = session.fromPartition(`temporary-page-${randomUUID()}`, { cache: false });
    guestSession.setPermissionCheckHandler(() => false);
    guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    guestSession.setDisplayMediaRequestHandler((_details, callback) => callback({}));
    guestSession.setDevicePermissionHandler(() => false);
    guestSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: Boolean(trackerCategory(details.url)) }));
    guestSession.webRequest.onBeforeSendHeaders((details, callback) => callback({ requestHeaders: { ...details.requestHeaders, DNT: '1', 'Sec-GPC': '1' } }));

    const window = new BrowserWindow({ parent, width: 940, height: 710, minWidth: 510, minHeight: 365,
      title: 'Temporary browsing · Private Browser', show: false, autoHideMenuBar: true, backgroundColor: '#141923',
      webPreferences: { session: chromeSession, preload: join(import.meta.dirname, 'temporary-browsing-preload.cjs'), sandbox: true,
        contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, webviewTag: false } });
    const view = new WebContentsView({ webPreferences: { session: guestSession, sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, devTools: false, webviewTag: false, navigateOnDragDrop: false } });
    const current: TemporaryWindow = { window, view, destination, notice: '', ready: false, confirming: false };
    this.current = current;

    window.removeMenu();
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.on('page-title-updated', (event) => event.preventDefault());
    const contents = view.webContents;
    guardPageNavigation(contents);
    contents.setWindowOpenHandler(() => {
      this.notice(current, 'Pop-ups are blocked in temporary browsing.');
      return { action: 'deny' };
    });
    guestSession.on('will-download', (event) => {
      event.preventDefault();
      this.notice(current, 'Downloads are blocked in temporary browsing.');
    });
    contents.on('did-navigate', () => this.update(current));
    contents.on('did-navigate-in-page', () => this.update(current));
    contents.on('did-start-loading', () => this.update(current));
    contents.on('did-stop-loading', () => this.update(current));
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) this.notice(current, 'Could not open this address.');
    });
    contents.on('render-process-gone', () => this.notice(current, 'This temporary page closed. Enter an address to continue.'));
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.control || input.key.toLowerCase() !== 'l' || window.isDestroyed()) return;
      event.preventDefault();
      window.webContents.focus();
      window.webContents.send('temporary:focus-address');
    });
    view.setVisible(false);
    window.contentView.addChildView(view);
    const layout = () => {
      const [width, height] = window.getContentSize();
      view.setBounds({ x: 0, y: TEMPORARY_TOOLBAR_HEIGHT, width, height: Math.max(0, height - TEMPORARY_TOOLBAR_HEIGHT) });
    };
    window.on('resize', layout);
    window.once('closed', () => {
      if (this.current === current) this.current = undefined;
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      void Promise.allSettled([guestSession.clearData(), guestSession.clearAuthCache(), guestSession.closeAllConnections()]);
    });
    layout();
    try {
      const html = temporaryBrowsingHtml(randomBytes(18).toString('base64'));
      current.ready = true;
      await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      if (!window.isDestroyed()) window.show();
    } catch (error) {
      if (!window.isDestroyed()) window.destroy();
      throw error;
    }
  }

  close(accountSpaceId?: AccountSpaceId): void {
    const current = this.current;
    if (current && (!accountSpaceId || current.destination.id === accountSpaceId) && !current.window.isDestroyed()) current.window.destroy();
  }

  private snapshot(current: TemporaryWindow) {
    const contents = current.view.webContents;
    const url = contents.getURL();
    const address = isAllowedRemoteUrl(url) ? url : '';
    return { address, destination: current.destination.label, notice: current.notice,
      canBack: contents.navigationHistory.canGoBack(), canForward: contents.navigationHistory.canGoForward(),
      loading: contents.isLoading(), canKeep: Boolean(address && !isProtectedPage(address)),
      warning: address ? navigationWarning(address) : undefined };
  }

  private update(current: TemporaryWindow): void {
    if (this.current !== current || !current.ready || current.window.isDestroyed() || current.view.webContents.isDestroyed()) return;
    current.window.webContents.send('temporary:state', this.snapshot(current));
  }

  private notice(current: TemporaryWindow, message: string): void {
    current.notice = message;
    this.update(current);
  }

  private async command(current: TemporaryWindow, command: unknown, value: unknown) {
    const contents = current.view.webContents;
    if (command !== 'navigate' && value !== undefined) throw new Error('Unexpected temporary browsing input.');
    if (command === 'state') return this.snapshot(current);
    if (command === 'navigate') {
      if (typeof value !== 'string' || value.length > 4096) throw new Error('Enter an HTTP or HTTPS address.');
      const url = parseWebAddress(value);
      if (!url || !isAllowedRemoteUrl(url)) throw new Error('Enter an HTTP or HTTPS address.');
      this.notice(current, '');
      current.view.setVisible(true);
      await contents.loadURL(url).catch(() => undefined);
    } else if (command === 'back') {
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    } else if (command === 'forward') {
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    } else if (command === 'reload') {
      if (contents.isLoading()) contents.stop();
      else if (isAllowedRemoteUrl(contents.getURL())) contents.reload();
    } else if (command === 'keep') {
      await this.keep(current);
    } else if (command === 'close') {
      this.close();
    } else throw new Error('Unknown temporary browsing action.');
  }

  private async keep(current: TemporaryWindow): Promise<void> {
    if (current.confirming) return;
    const contents = current.view.webContents;
    const from = contents.getURL();
    if (!isAllowedRemoteUrl(from) || isProtectedPage(from) || contents.isLoadingMainFrame()) throw new Error('Open a regular page before keeping a bookmark.');
    const address = new URL(from);
    address.search = '';
    address.hash = '';
    const bookmark = address.href;
    const title = contents.getTitle().slice(0, 160).trim() || address.hostname;
    current.confirming = true;
    try {
      const response = await dialog.showMessageBox(current.window, { type: 'question', message: 'Keep this bookmark?',
        detail: `${title}\n${bookmark}\n\nSave this in ${current.destination.label}.`, buttons: ['Cancel', 'Keep bookmark'], defaultId: 0, cancelId: 0 });
      if (!response.response || this.current !== current || current.window.isDestroyed() || contents.isDestroyed()) return;
      if (contents.isLoadingMainFrame() || contents.getURL() !== from) throw new Error('The address changed. Review the bookmark again.');
      this.saveBookmark(current.destination.id, bookmark, title);
      this.notice(current, `Bookmark saved in ${current.destination.label}.`);
    } finally { current.confirming = false; }
  }
}
