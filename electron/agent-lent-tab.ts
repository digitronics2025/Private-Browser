import { randomUUID } from 'node:crypto';
import type { WebContentsView } from 'electron';
import { AgentDriver } from './agent-driver.js';
import { agentUrl, AgentError } from './agent-policy.js';
import { makeSpace } from './agent-space-policy.js';
import type { AgentConnection } from './agent-pipe.js';
import type { AgentTab } from './agent-workspace.js';

const LOAN_MS = 15 * 60_000;

export interface LendableTab {
  tabId: string;
  view: WebContentsView;
  current(): boolean;
}

export class AgentLentTab {
  readonly tab: AgentTab;
  readonly origin: string;
  readonly contentsId: number;
  readonly expiresAt: number;
  readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly listenCleanup: () => void;
  private readonly files: (() => Promise<void>)[] = [];

  constructor(readonly source: LendableTab, connection: AgentConnection, returned: () => void) {
    const contents = source.view.webContents;
    if (!source.current() || contents.isDestroyed() || contents.debugger.isAttached() || contents.isLoadingMainFrame()) {
      throw new AgentError('LOAN_UNAVAILABLE', 'Select a loaded tab with Developer Tools closed.');
    }
    this.origin = agentUrl(contents.getURL()).origin;
    this.contentsId = contents.id;
    this.expiresAt = Math.min(Date.now() + LOAN_MS, connection.expiresAt);
    this.tab = {
      id: randomUUID(), view: source.view,
      space: { ...makeSpace('lent', 'Lent tab', 'work'), trust: 'work', clientIds: [connection.device.id], origins: [this.origin], outside: 'deny' },
      connection, manual: false, origin: this.origin, signedOut: false, partition: contents.session,
      driver: new AgentDriver(contents),
    };
    const starts = (_event: Electron.Event, url: string, _inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !this.sameOrigin(url)) returned();
    };
    const frame = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
      if (event.isMainFrame && !this.sameOrigin(event.url)) {
        event.preventDefault();
        returned();
      }
    };
    const redirect = (event: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
      if (event.isMainFrame && !this.sameOrigin(event.url)) {
        event.preventDefault();
        returned();
      }
    };
    contents.on('did-start-navigation', starts);
    contents.on('will-frame-navigate', frame);
    contents.on('will-redirect', redirect);
    contents.once('destroyed', returned);
    contents.once('devtools-opened', returned);
    contents.debugger.once('detach', returned);
    connection.abort.addEventListener('abort', returned, { once: true });
    this.timer = setTimeout(returned, Math.max(0, this.expiresAt - Date.now()));
    this.listenCleanup = () => {
      connection.abort.removeEventListener('abort', returned);
      if (!contents.isDestroyed()) {
        contents.removeListener('did-start-navigation', starts);
        contents.removeListener('will-frame-navigate', frame);
        contents.removeListener('will-redirect', redirect);
        contents.removeListener('destroyed', returned);
        contents.removeListener('devtools-opened', returned);
        contents.debugger.removeListener('detach', returned);
      }
    };
  }

  sameOrigin(value: string): boolean {
    try { return agentUrl(value).origin === this.origin; } catch { return false; }
  }

  valid(): boolean {
    const contents = this.source.view.webContents;
    return !this.controller.signal.aborted && !this.tab.connection.abort.aborted
      && Date.now() < this.expiresAt && this.source.current() && !contents.isDestroyed() && this.sameOrigin(contents.getURL());
  }

  retainUpload(clean: () => Promise<void>): void {
    if (this.controller.signal.aborted) { void clean(); return; }
    this.files.push(clean);
    if (this.files.length > 8) void this.files.shift()?.();
  }

  return(): void {
    this.controller.abort();
    clearTimeout(this.timer);
    this.listenCleanup();
    this.tab.driver.dispose();
    for (const clean of this.files.splice(0)) void clean();
  }
}
