import { randomUUID } from 'node:crypto';
import type {
  AccountSpaceId,
  PermissionCapability,
  PermissionDecision,
  PermissionPrompt,
  WorkspaceId,
} from './types.js';
import { AccountStore } from './account-store.js';
import { requireExactWebOrigin } from './account-space-validation.js';

const PROMPT_TTL_MS = 60_000;
const NOTIFICATION_ORIGINS = new Set([
  'https://mail.google.com',
  'https://calendar.google.com',
  'https://meet.google.com',
]);
const MEET_ORIGIN = 'https://meet.google.com';

export type PermissionEvaluation = 'granted' | 'denied' | 'prompt';

export class AccountPermissionManager {
  private readonly sessionGrants = new Set<string>();
  private readonly oneTimeGrants = new Map<string, number>();
  private readonly consumedPromptIds = new Set<string>();

  constructor(
    private readonly accounts: AccountStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  evaluate(
    accountSpaceId: AccountSpaceId,
    workspaceId: WorkspaceId,
    originValue: string,
    capability: PermissionCapability,
    consumeOnce = true,
  ): PermissionEvaluation {
    if (workspaceId === 'banking') return 'denied';
    let origin: string;
    try {
      origin = requireExactWebOrigin(originValue);
    } catch {
      return 'denied';
    }
    if (!isCapabilityAllowedAtOrigin(capability, origin)) return 'denied';
    const account = this.accounts.require(accountSpaceId);
    if (account.workspaceId !== workspaceId || account.locked) return 'denied';
    const key = grantKey(accountSpaceId, origin, capability);
    const once = this.oneTimeGrants.get(key) ?? 0;
    if (once > 0) {
      if (consumeOnce) {
        if (once === 1) this.oneTimeGrants.delete(key);
        else this.oneTimeGrants.set(key, once - 1);
      }
      return 'granted';
    }
    if (this.sessionGrants.has(key)) return 'granted';
    if (account.permissionGrants.some((grant) => grant.origin === origin && grant.capability === capability)) return 'granted';
    return 'prompt';
  }

  createPrompt(accountSpaceId: AccountSpaceId, workspaceId: WorkspaceId, originValue: string, capability: PermissionCapability): PermissionPrompt {
    const origin = requireExactWebOrigin(originValue);
    if (this.evaluate(accountSpaceId, workspaceId, origin, capability, false) === 'denied') throw new Error('Permission is denied by workspace or origin policy');
    const createdAt = this.now();
    return {
      id: randomUUID(),
      accountSpaceId,
      workspaceId,
      origin,
      capability,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + PROMPT_TTL_MS).toISOString(),
    };
  }

  applyDecision(prompt: PermissionPrompt, decision: PermissionDecision, retainAllowOnce = false): boolean {
    if (this.consumedPromptIds.has(prompt.id)) throw new Error('Permission prompt was already used');
    this.consumedPromptIds.add(prompt.id);
    if (Date.parse(prompt.expiresAt) < this.now().getTime()) throw new Error('Permission prompt expired');
    if (this.evaluate(prompt.accountSpaceId, prompt.workspaceId, prompt.origin, prompt.capability, false) === 'denied') return false;
    const key = grantKey(prompt.accountSpaceId, prompt.origin, prompt.capability);
    if (decision === 'allow-once') {
      if (retainAllowOnce) this.oneTimeGrants.set(key, 1);
      return true;
    }
    if (decision === 'allow-session') {
      this.sessionGrants.add(key);
      return true;
    }
    if (decision === 'allow-always') {
      this.accounts.update(prompt.accountSpaceId, (record) => {
        if (!record.permissionGrants.some((grant) => grant.origin === prompt.origin && grant.capability === prompt.capability)) {
          record.permissionGrants.push({ origin: prompt.origin, capability: prompt.capability });
        }
      });
      return true;
    }
    return false;
  }

  clearAccount(accountSpaceId: AccountSpaceId): void {
    const prefix = `${accountSpaceId}|`;
    for (const key of [...this.sessionGrants]) if (key.startsWith(prefix)) this.sessionGrants.delete(key);
    for (const key of [...this.oneTimeGrants.keys()]) if (key.startsWith(prefix)) this.oneTimeGrants.delete(key);
  }
}

export function isCapabilityAllowedAtOrigin(capability: PermissionCapability, origin: string): boolean {
  if (capability === 'notifications') return NOTIFICATION_ORIGINS.has(origin);
  if (capability === 'microphone' || capability === 'camera' || capability === 'camera-and-microphone' || capability === 'display-capture') {
    return origin === MEET_ORIGIN;
  }
  if (capability === 'geolocation') return false;
  return origin.startsWith('https://') || /^http:\/\/(?:localhost|127(?:\.\d{1,3}){3})(?::\d+)?$/.test(origin);
}

function grantKey(accountSpaceId: AccountSpaceId, origin: string, capability: PermissionCapability): string {
  return `${accountSpaceId}|${origin}|${capability}`;
}
