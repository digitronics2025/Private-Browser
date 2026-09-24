import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ipcMain, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import type { FillContext } from './fill-capability.js';
import { FillPickerSessions, fillPickerHtml, type FillPickerChoice, type FillPickerRow, type Rect } from './fill-picker-model.js';

const IDLE_TIMEOUT_MS = 10_000;

export interface FillPickerHandlers {
  choose(choice: FillPickerChoice): void;
}

/**
 * Chrome-style saved-login list, drawn by the browser above the page.
 *
 * The page never receives the usernames: they live in a separate sandboxed
 * view with its own one-purpose preload, stacked over the tab's view. A choice
 * is only a row index; the main process maps it back to the entry it listed.
 */
export class FillPicker {
  private readonly sessions = new FillPickerSessions();
  private view?: WebContentsView;
  private owner?: BrowserWindow;
  private highlighted = -1;
  private idleTimer?: NodeJS.Timeout;

  constructor(private readonly parent: () => BrowserWindow | undefined, private readonly handlers: FillPickerHandlers) {
    ipcMain.on('fill-picker:choose', (event, nonce: unknown, index: unknown) => {
      // Anything but the open overlay is ignored outright, so it cannot even close the list.
      if (!this.view || event.sender.id !== this.view.webContents.id) return;
      const choice = this.sessions.take(event.sender.id, nonce, index);
      this.close();
      if (choice) this.handlers.choose(choice);
    });
  }

  get isOpen(): boolean {
    return Boolean(this.view);
  }

  /** The context the open list was made for, so callers can close it when that context ends. */
  get context(): FillContext | undefined {
    return this.sessions.current?.context;
  }

  /** `page` keeps keyboard focus: the list is clicked or driven by keys typed in the field, never typed into. */
  show(context: FillContext, rows: FillPickerRow[], bounds: Rect, page: WebContents): void {
    this.close();
    const window = this.parent();
    if (!rows.length || !window || window.isDestroyed()) return;
    const cspNonce = randomBytes(18).toString('base64url');
    const ipcNonce = randomBytes(24).toString('base64url');
    const view = new WebContentsView({
      webPreferences: {
        preload: join(import.meta.dirname, 'fill-picker-preload.cjs'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, devTools: false,
        additionalArguments: [`--fill-picker-nonce=${ipcNonce}`],
      },
    });
    view.setBackgroundColor('#00000000');
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('will-navigate', (event) => event.preventDefault());
    // A discarded list's late events (its renderer going away, its load being cut
    // short) must never close the list that replaced it.
    const closeIfCurrent = () => { if (this.view === view) this.close(); };
    view.webContents.on('render-process-gone', closeIfCurrent);
    const returnFocus = () => { if (this.view === view && !page.isDestroyed()) page.focus(); };
    view.webContents.on('focus', returnFocus);
    view.webContents.once('did-finish-load', returnFocus);
    this.sessions.open(context, rows.map((row) => row.entryId), view.webContents.id, ipcNonce);
    this.view = view;
    this.highlighted = -1;
    view.setBounds(bounds);
    window.contentView.addChildView(view);
    this.owner = window;
    if (!page.isDestroyed()) page.focus();
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fillPickerHtml(rows, cspNonce))}`).catch(closeIfCurrent);
    this.armIdleTimer();
  }

  /** Arrow keys arrive in the page; move the highlight without moving focus. */
  moveHighlight(delta: 1 | -1): void {
    const rows = this.sessions.current?.rows ?? 0;
    if (!this.view || !rows) return;
    this.highlighted = this.highlighted < 0 ? (delta > 0 ? 0 : rows - 1) : (this.highlighted + delta + rows) % rows;
    this.view.webContents.send('fill-picker:highlight', this.highlighted);
    this.armIdleTimer();
  }

  /** Enter in the page: returns false when no row is highlighted, so the key goes through. */
  chooseHighlighted(): boolean {
    if (!this.view || this.highlighted < 0) return false;
    const choice = this.sessions.takeIndex(this.highlighted);
    this.close();
    if (choice) this.handlers.choose(choice);
    return true;
  }

  close(): void {
    this.sessions.clear();
    this.highlighted = -1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const view = this.view;
    const owner = this.owner;
    this.view = undefined;
    this.owner = undefined;
    if (!view) return;
    if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }
}
