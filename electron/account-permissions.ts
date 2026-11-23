import { randomUUID } from 'node:crypto';
import type {
  AccountSpaceId,
  PermissionCapability,
  PermissionDecision,
  PermissionGrantSummary,
  PermissionPrompt,
  SitePermissionStatus,
  WorkspaceId,
} from './types.js';
import { AccountStore, type AccountSpaceRecord } from './account-store.js';
import { PERMISSION_CAPABILITIES, requireExactWebOrigin } from './account-space-validation.js';

const PROMPT_TTL_MS = 60_000;
const NOTIFICATION_ORIGINS = new Set([
  'https://mail.google.com',
  'https://calendar.google.com',
  'https://meet.google.com',
]);
const MEET_ORIGIN = 'https://meet.google.com';

export type PermissionEvaluation = 'granted' | 'denied' | 'prompt';

export class AccountPermissionManager {
  private readonly sessionGrants = new Map<string, PermissionGrantSummary>();
  private readonly oneTimeGrants = new Map<string, PermissionGrantSummary>();
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
    if (capability === 'popups') {
      const preference = account.popupPreferences?.find((item) => item.origin === origin)?.decision;
      if (preference === 'block') return 'denied';
      if (preference === 'allow') return 'granted';
    }
    const key = grantKey(accountSpaceId, origin, capability);
    if (this.oneTimeGrants.has(key)) {
      if (consumeOnce) this.oneTimeGrants.delete(key);
      return 'granted';
    }
    if (this.sessionGrants.has(key)) return 'granted';
    if (account.permissionGrants.some((grant) => grant.origin === origin && grant.capability === capability)) return 'granted';
    return 'prompt';
  }

  listGrants(accountSpaceId: AccountSpaceId): PermissionGrantSummary[] {
    return this.grantsFor(this.accounts.require(accountSpaceId));
  }

  private grantsFor(account: AccountSpaceRecord): PermissionGrantSummary[] {
    if (account.locked || account.workspaceId === 'banking') return [];
    const accountSpaceId = account.id;
    const prefix = accountSpaceId + '|';
    const grants = new Map<string, PermissionGrantSummary>();
    for (const temporary of [this.oneTimeGrants, this.sessionGrants]) {
      for (const [key, grant] of temporary) if (key.startsWith(prefix)) grants.set(key, grant);
    }
    for (const grant of account.permissionGrants) {
      grants.set(grantKey(accountSpaceId, grant.origin, grant.capability), { ...grant, duration: 'until-revoked' });
    }
    return [...grants.values()].filter(({ origin, capability }) => isCapabilityAllowedAtOrigin(capability, origin))
      .sort((a, b) => a.origin.localeCompare(b.origin) || a.capability.localeCompare(b.capability));
  }

  siteStatus(accountSpaceId: AccountSpaceId, workspaceId: WorkspaceId, origin: string): SitePermissionStatus[] {
    const blocked = () => PERMISSION_CAPABILITIES.map((capability) => ({ capability, decision: 'blocked' as const }));
    if (workspaceId === 'banking') return blocked();
    try { requireExactWebOrigin(origin); } catch { return blocked(); }
    const account = this.accounts.require(accountSpaceId);
    if (account.locked || account.workspaceId !== workspaceId) return blocked();
    const grants = new Map(this.grantsFor(account).filter((grant) => grant.origin === origin).map((grant) => [grant.capability, grant]));
    return PERMISSION_CAPABILITIES.map((capability) => {
      if (!isCapabilityAllowedAtOrigin(capability, origin)) return { capability, decision: 'blocked' };
      if (capability === 'popups') {
        const preference = account.popupPreferences?.find((item) => item.origin === origin)?.decision;
        return preference === 'block' ? { capability, decision: 'blocked-preference' }
          : preference === 'allow' ? { capability, decision: 'allowed', duration: 'until-revoked' }
            : { capability, decision: 'ask' };
      }
      const grant = grants.get(capability);
      return grant ? { capability, decision: 'allowed', duration: grant.duration } : { capability, decision: 'ask' };
    });
  }

  revoke(accountSpaceId: AccountSpaceId, workspaceId: WorkspaceId, originValue: string, capability: PermissionCapability): void {
    const origin = requireExactWebOrigin(originValue);
    const key = grantKey(accountSpaceId, origin, capability);
    if (capability === 'popups') {
      this.accounts.update(accountSpaceId, (record) => {
        record.popupPreferences = (record.popupPreferences ?? []).filter((item) => item.origin !== origin);
        record.permissionGrants = record.permissionGrants.filter((grant) => !(grant.origin === origin && grant.capability === 'popups'));
      });
      this.sessionGrants.delete(key);
      this.oneTimeGrants.delete(key);
      return;
    }
    if (this.evaluate(accountSpaceId, workspaceId, origin, capability, false) !== 'granted') return;
    const matches = (grant: { origin: string; capability: PermissionCapability }) => grant.origin === origin && grant.capability === capability;
    if (this.accounts.require(accountSpaceId).permissionGrants.some(matches)) {
      this.accounts.update(accountSpaceId, (account) => { account.permissionGrants = account.permissionGrants.filter((grant) => !matches(grant)); });
    }
    this.sessionGrants.delete(key);
    this.oneTimeGrants.delete(key);
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

  setPopupPreference(accountSpaceId: AccountSpaceId, workspaceId: WorkspaceId, originValue: string, decision: 'ask' | 'allow' | 'block'): void {
    const origin = requireExactWebOrigin(originValue);
    if (workspaceId === 'banking' || !isCapabilityAllowedAtOrigin('popups', origin)) throw new Error('Pop-up settings are unavailable for this site or Account Space');
    const account = this.accounts.require(accountSpaceId);
    if (account.workspaceId !== workspaceId || account.locked) throw new Error('Account Space is unavailable');
    const key = grantKey(accountSpaceId, origin, 'popups');
    this.accounts.update(accountSpaceId, (record) => {
      record.popupPreferences = (record.popupPreferences ?? []).filter((item) => item.origin !== origin);
      record.permissionGrants = record.permissionGrants.filter((grant) => !(grant.origin === origin && grant.capability === 'popups'));
      if (decision !== 'ask') {
        if (record.popupPreferences.length >= 100) throw new Error('Too many saved pop-up settings');
        record.popupPreferences.push({ origin, decision });
      }
    });
    this.sessionGrants.delete(key);
    this.oneTimeGrants.delete(key);
  }

  applyDecision(prompt: PermissionPrompt, decision: PermissionDecision, retainAllowOnce = false): boolean {
    if (this.consumedPromptIds.has(prompt.id)) throw new Error('Permission prompt was already used');
    this.consumedPromptIds.add(prompt.id);
    if (Date.parse(prompt.expiresAt) < this.now().getTime()) throw new Error('Permission prompt expired');
    if (this.evaluate(prompt.accountSpaceId, prompt.workspaceId, prompt.origin, prompt.capability, false) === 'denied') return false;
    const key = grantKey(prompt.accountSpaceId, prompt.origin, prompt.capability);
    if (decision === 'allow-once') {
      if (retainAllowOnce) this.oneTimeGrants.set(key, { origin: prompt.origin, capability: prompt.capability, duration: 'once' });
      return true;
    }
    if (decision === 'allow-session') {
      if (prompt.capability === 'popups') return true;
      this.sessionGrants.set(key, { origin: prompt.origin, capability: prompt.capability, duration: 'session' });
      return true;
    }
    if (decision === 'allow-always') {
      if (prompt.capability === 'popups') {
        this.setPopupPreference(prompt.accountSpaceId, prompt.workspaceId, prompt.origin, 'allow');
        return true;
      }
      this.accounts.update(prompt.accountSpaceId, (record) => {
        if (!record.permissionGrants.some((grant) => grant.origin === prompt.origin && grant.capability === prompt.capability)) {
          record.permissionGrants.push({ origin: prompt.origin, capability: prompt.capability });
        }
      });
      return true;
    }
    if (prompt.capability === 'popups') {
      this.setPopupPreference(prompt.accountSpaceId, prompt.workspaceId, prompt.origin, 'block');
    }
    return false;
  }

  clearAccount(accountSpaceId: AccountSpaceId): void {
    const prefix = `${accountSpaceId}|`;
    for (const key of [...this.sessionGrants.keys()]) if (key.startsWith(prefix)) this.sessionGrants.delete(key);
    for (const key of [...this.oneTimeGrants.keys()]) if (key.startsWith(prefix)) this.oneTimeGrants.delete(key);
  }
}

export function isCapabilityAllowedAtOrigin(capability: PermissionCapability, origin: string): boolean {
  if (capability === 'popups') return origin.startsWith('https://') || /^http:\/\/(?:localhost|127(?:\.\d{1,3}){3})(?::\d+)?$/.test(origin);
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
