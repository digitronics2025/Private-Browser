import type { BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails, WebContents, WindowOpenHandlerResponse } from 'electron';
import { isAllowedRemoteUrl, stripTrackingParameters } from './security.js';

/**
 * Chromium reports `new-window` only when `window.open` asked for a popup
 * (window features such as a size, or `popup`). Payment and sign-in flows open
 * that way and then talk to their opener through `window.opener` and
 * `postMessage`; turned into a tab they have no opener, and Google Pay fails
 * with OR_BIBED_15 ("pop-ups may be turned off"). Links and plain
 * `window.open(url)` still become tabs.
 */
export function wantsPopupWindow(disposition: HandlerDetails['disposition']): boolean {
  return disposition === 'new-window';
}

export type PopupAddressType = 'empty' | 'about:blank' | 'http' | 'https' | 'other';

/** Classifies only the opening address; never returns path, query or fragment data. */
export function popupAddressType(value: string): PopupAddressType {
  if (value === '') return 'empty';
  if (value === 'about:blank') return 'about:blank';
  try {
    const protocol = new URL(value).protocol;
    if (protocol === 'http:') return 'http';
    if (protocol === 'https:') return 'https';
  } catch { /* classify malformed and non-web values without exposing them */ }
  return 'other';
}

export function isAllowedPopupOpeningAddress(value: string): boolean {
  return isAllowedRemoteUrl(value) || value === '' || value === 'about:blank';
}

/**
 * A popup window has no address bar, so its title always leads with the host
 * it is showing: a page cannot dress itself up as another site's sign-in box.
 */
export function popupTitle(url: string, pageTitle: string): string {
  let host = 'Popup';
  try { host = new URL(url).host || host; } catch { /* keep the placeholder */ }
  const title = pageTitle.trim().slice(0, 200);
  return title && title !== host ? `${host} — ${title}` : host;
}

/**
 * The same hardening as a tab's page view. The opener's session is inherited
 * by Chromium, so the popup shares its Account Space's cookies and handlers
 * and no other. `outlivesOpener: false` closes it with the tab, including when
 * the tab is closed or its Account Space locked.
 */
export function popupWindowResponse(parent: BrowserWindow, createWindow?: (options: BrowserWindowConstructorOptions) => WebContents): WindowOpenHandlerResponse {
  return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: popupWindowOptions(parent), createWindow };
}

function popupWindowOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    parent,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  };
}

type PopupReviewOutcome = 'continued' | 'cancelled' | 'expired' | 'changed';

interface PopupReviewInputs {
  url: string;
  method: 'GET' | 'POST';
  current: () => boolean;
  ask: (signal: AbortSignal) => Promise<boolean>;
  finish: (outcome: PopupReviewOutcome) => void;
}

/** Holds a popup's first request before its HTTP method or body leaves the session. */
export class PopupReview {
  private active?: { contentsId: number; request: PopupReviewInputs; hold?: (allowed: boolean) => void; signal: AbortSignal; settle: (outcome: PopupReviewOutcome) => void };

  get pending(): boolean { return Boolean(this.active); }

  cancel(): void { this.active?.settle('changed'); }

  start(child: BrowserWindow, request: PopupReviewInputs, timeoutMs = 30_000): void {
    const abort = new AbortController();
    const contentsId = child.webContents.id;
    const active = { contentsId, request, hold: undefined as ((allowed: boolean) => void) | undefined, signal: abort.signal, settle: (outcome: PopupReviewOutcome) => settle(outcome) };
    const finishChild = () => settle('changed');
    const timer = setTimeout(() => settle('expired'), timeoutMs);
    const settle = (outcome: PopupReviewOutcome) => {
      if (this.active !== active) return;
      this.active = undefined;
      clearTimeout(timer);
      abort.abort();
      child.removeListener('closed', finishChild);
      const allowed = outcome === 'continued' && request.current() && !child.isDestroyed();
      active.hold?.(allowed);
      if (allowed) child.show();
      else if (!child.isDestroyed()) child.destroy();
      request.finish(allowed ? 'continued' : outcome === 'continued' ? 'changed' : outcome);
    };
    this.active = active;
    child.once('closed', finishChild);
    void Promise.resolve().then(() => request.ask(abort.signal)).then(
      (approved) => active.settle(approved ? 'continued' : 'cancelled'), () => active.settle('cancelled'),
    );
  }

  hold(details: { webContentsId?: number; url: string; resourceType: string; method: string }, reply: (allowed: boolean) => void): boolean {
    const active = this.active;
    if (!active || details.webContentsId !== active.contentsId) return false;
    const isBlankStart = active.request.url === '' || active.request.url === 'about:blank';
    const url = isBlankStart ? undefined : new URL(active.request.url);
    if (url) url.hash = '';
    const matchesInitialRequest = url
      ? details.url === url.href && details.method === active.request.method
      : isAllowedRemoteUrl(details.url) && (details.method === 'GET' || details.method === 'POST');
    if (active.hold || details.resourceType !== 'mainFrame' || !matchesInitialRequest) {
      reply(false);
      return true;
    }
    active.hold = reply;
    return true;
  }
}

/** Keeps a page on http(s) and strips campaign identifiers, for tabs and popups alike. */
export function guardPageNavigation(contents: WebContents): void {
  const guard = (event: Electron.Event, url: string) => {
    if (!isAllowedRemoteUrl(url)) {
      event.preventDefault();
      return;
    }
    const sanitized = stripTrackingParameters(url);
    if (sanitized !== url) {
      event.preventDefault();
      void contents.loadURL(sanitized);
    }
  };
  contents.on('will-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

/**
 * Attaches every guard to a popup window the moment Electron creates it. Its
 * own `window.open` calls go through `openHandlerFor(child)`, and any popup it
 * opens in turn is adopted the same way.
 */
export function adoptPopupWindow(
  child: BrowserWindow,
  openHandlerFor: (window: BrowserWindow) => (details: HandlerDetails) => WindowOpenHandlerResponse,
): void {
  const contents = child.webContents;
  child.removeMenu();
  contents.setWindowOpenHandler(openHandlerFor(child));
  guardPageNavigation(contents);
  const retitle = (pageTitle = contents.getTitle()) => {
    if (!child.isDestroyed()) child.setTitle(popupTitle(contents.getURL(), pageTitle));
  };
  contents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    retitle(title);
  });
  contents.on('did-navigate', () => retitle());
  contents.on('did-create-window', (grandchild) => adoptPopupWindow(grandchild, openHandlerFor));
  retitle();
}
