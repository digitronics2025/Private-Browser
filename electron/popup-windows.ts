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
export function popupWindowResponse(parent: BrowserWindow): WindowOpenHandlerResponse {
  return { action: 'allow', outlivesOpener: false, overrideBrowserWindowOptions: popupWindowOptions(parent) };
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
