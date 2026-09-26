import { MIN_CHROME_TOP, type ContentInsets } from './chrome-layout.js';
import { isAllowedRemoteUrl } from './security.js';

/**
 * Side apps: a trusted web app (today, claude.ai) shown in the side panel next
 * to the page, the way Chrome shows an extension's side panel.
 *
 * This file holds the pure rules — which apps exist, where each may navigate,
 * and where its view may sit — so the IPC validator and the tests can use them
 * without loading Electron. The view itself is in `side-apps.ts`.
 */

export type SideAppId = 'claude';
export type SideAppStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'crashed';
export type SideAppCommand = 'back' | 'forward' | 'reload' | 'home' | 'open-in-tab';

export const SIDE_APP_IDS: readonly SideAppId[] = ['claude'];
export const SIDE_APP_COMMANDS: readonly SideAppCommand[] = ['back', 'forward', 'reload', 'home', 'open-in-tab'];

export interface SideAppDefinition {
  id: SideAppId;
  name: string;
  homeUrl: string;
  /** Top-level hosts the app may navigate to. A leading dot also admits every subdomain. */
  hosts: readonly string[];
  partition: string;
}

export interface SideAppSnapshot {
  id: SideAppId;
  name: string;
  status: SideAppStatus;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface SideAppRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const SIDE_APPS: Readonly<Record<SideAppId, SideAppDefinition>> = {
  claude: {
    id: 'claude',
    name: 'Claude',
    homeUrl: 'https://claude.ai/new',
    // Sign-in leaves claude.ai for Google or Apple and comes back by redirect.
    hosts: ['claude.ai', '.claude.ai', 'anthropic.com', '.anthropic.com', 'accounts.google.com', 'appleid.apple.com'],
    partition: 'persist:private-browser-side-app-claude',
  },
};

/** The smallest side-app view worth showing; anything narrower is hidden. */
const MIN_SIDE_APP_SIZE = 120;

export function isSideAppId(value: unknown): value is SideAppId {
  return typeof value === 'string' && (SIDE_APP_IDS as readonly string[]).includes(value);
}

export function isSideAppCommand(value: unknown): value is SideAppCommand {
  return typeof value === 'string' && (SIDE_APP_COMMANDS as readonly string[]).includes(value);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\./.test(hostname);
}

/**
 * Whether a top-level navigation stays inside the app. HTTPS only; plain HTTP
 * is admitted solely for a loopback host, which only a test override can list.
 */
export function isSideAppUrl(app: Pick<SideAppDefinition, 'hosts'>, value: string): boolean {
  if (!isAllowedRemoteUrl(value)) return false;
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(host))) return false;
  return app.hosts.some((allowed) => allowed.startsWith('.') ? host.endsWith(allowed) : host === allowed);
}

/**
 * Fit the rectangle the renderer asked for inside the side-panel strip the main
 * process already knows about: never over the tab strip, toolbar or page. The
 * renderer is trusted but a bug there must not slide a remote view over the
 * address bar and its security chip.
 */
export function clampSideAppBounds(requested: SideAppRect, insets: ContentInsets, contentWidth: number, contentHeight: number): SideAppRect | null {
  const left = Math.round(Math.max(requested.x, contentWidth - insets.right));
  const top = Math.round(Math.max(requested.y, MIN_CHROME_TOP, insets.top));
  const right = Math.round(Math.min(requested.x + requested.width, contentWidth));
  const bottom = Math.round(Math.min(requested.y + requested.height, contentHeight));
  if (right - left < MIN_SIDE_APP_SIZE || bottom - top < MIN_SIDE_APP_SIZE) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Test runs point the app at a local server instead of the real site. Honoured
 * only in an unpackaged build, like `PRIVATE_BROWSER_E2E_USER_DATA`.
 */
export function sideAppDefinition(id: SideAppId, packaged: boolean, override = process.env.PRIVATE_BROWSER_E2E_SIDE_APP_URL): SideAppDefinition {
  const definition = SIDE_APPS[id];
  if (packaged || !override || !isAllowedRemoteUrl(override)) return definition;
  return { ...definition, homeUrl: override, hosts: [new URL(override).hostname] };
}
