import { randomBytes } from 'node:crypto';
import type { AccountSpaceId, WorkspaceId } from '../types.js';

export type VaultOperation = 'fill-login' | 'fill-totp' | 'capture-login';

export interface FillContext {
  webContentsId: number;
  tabId: string;
  navigationGeneration: number;
  workspaceId: WorkspaceId;
  accountSpaceId: AccountSpaceId;
  origin: string;
}

interface FillCapability extends FillContext {
  id: string;
  entryId: string;
  operation: VaultOperation;
  expiresAt: number;
}

export function normalizedWebOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only HTTP(S) origins can receive a vault fill');
  if (url.username || url.password) throw new Error('Credential-bearing page addresses are not eligible for fill');
  if (url.hostname.includes('xn--')) throw new Error('Internationalized lookalike domains require manual credential entry');
  return url.origin;
}

export class FillCapabilityStore {
  private readonly capabilities = new Map<string, FillCapability>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(context: FillContext, entryId: string, operation: VaultOperation): string {
    this.prune();
    const id = randomBytes(24).toString('base64url');
    this.capabilities.set(id, { ...context, id, entryId, operation, expiresAt: this.now() + 10_000 });
    return id;
  }

  redeem(id: string, current: FillContext, entryId: string, operation: VaultOperation): void {
    const capability = this.capabilities.get(id);
    this.capabilities.delete(id);
    if (!capability || capability.expiresAt < this.now()
      || capability.entryId !== entryId || capability.operation !== operation
      || capability.webContentsId !== current.webContentsId || capability.tabId !== current.tabId
      || capability.navigationGeneration !== current.navigationGeneration
      || capability.workspaceId !== current.workspaceId || capability.accountSpaceId !== current.accountSpaceId
      || capability.origin !== current.origin) {
      throw new Error('Vault fill expired because the page context changed');
    }
  }

  invalidateAll(): void {
    this.capabilities.clear();
  }

  invalidateTab(tabId: string): void {
    for (const [id, capability] of this.capabilities) if (capability.tabId === tabId) this.capabilities.delete(id);
  }

  private prune(): void {
    for (const [id, capability] of this.capabilities) if (capability.expiresAt < this.now()) this.capabilities.delete(id);
    while (this.capabilities.size >= 32) this.capabilities.delete(this.capabilities.keys().next().value!);
  }
}
