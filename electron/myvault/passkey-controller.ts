import type { WebContents } from 'electron';
import type { WorkspaceId } from '../types.js';
import { workspaceVaultPolicy } from './workspace-policy.js';

export const PASSKEY_RELEASE_GATE = Object.freeze({
  enabled: false,
  failingGate: 'No automated Electron Playwright gate proves document-start interception before the first inline script with a live CDP binding.',
});

export interface PasskeyOptIns {
  global: boolean;
  workspaces: Partial<Record<WorkspaceId, boolean>>;
  sites: Record<string, boolean>;
}

export function canInstallPasskeyProvider(workspaceId: WorkspaceId, origin: string, optIns: PasskeyOptIns, devToolsOpen: boolean): boolean {
  if (!PASSKEY_RELEASE_GATE.enabled || devToolsOpen || !workspaceVaultPolicy(workspaceId).passkeys) return false;
  return optIns.global && optIns.workspaces[workspaceId] === true && optIns.sites[origin] === true;
}

/** The shim always preserves and calls the original operation for every non-created/non-asserted outcome. */
export function passkeyShimSource(bindingName: string): string {
  return `(() => {
    const originalCreate = navigator.credentials.create.bind(navigator.credentials);
    const originalGet = navigator.credentials.get.bind(navigator.credentials);
    const pending = new Map();
    let sequence = 0;
    window.addEventListener('myvault-passkey-response', (event) => {
      if (event.source !== window || !(event instanceof MessageEvent)) return;
      const detail = event.data;
      if (!detail || detail.channel !== 'myvault-passkeys-v1' || typeof detail.id !== 'string') return;
      const resolve = pending.get(detail.id); pending.delete(detail.id); if (resolve) resolve(detail);
    });
    const ask = (ceremony, options) => new Promise((resolve) => {
      const id = String(++sequence); pending.set(id, resolve);
      globalThis[${JSON.stringify(bindingName)}](JSON.stringify({ channel: 'myvault-passkeys-v1', id, ceremony, options }));
    });
    navigator.credentials.create = async (options) => {
      if (!options || !options.publicKey) return originalCreate(options);
      try { const answer = await ask('create', options.publicKey); if (answer.outcome === 'created') return answer.credential; } catch {}
      return originalCreate(options);
    };
    navigator.credentials.get = async (options) => {
      if (!options || !options.publicKey) return originalGet(options);
      try { const answer = await ask('get', options.publicKey); if (answer.outcome === 'asserted') return answer.credential; } catch {}
      return originalGet(options);
    };
  })();`;
}

export class InternalPasskeyController {
  private readonly bindingName = `__myvaultPasskey_${crypto.randomUUID().replace(/-/g, '')}`;

  async installAtDocumentStart(contents: WebContents): Promise<boolean> {
    if (!PASSKEY_RELEASE_GATE.enabled || contents.isDevToolsOpened()) return false;
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Runtime.enable');
    await contents.debugger.sendCommand('Page.enable');
    await contents.debugger.sendCommand('Runtime.addBinding', { name: this.bindingName });
    await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: passkeyShimSource(this.bindingName), worldName: '' });
    return true;
  }

  detach(contents: WebContents): void {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  }
}
