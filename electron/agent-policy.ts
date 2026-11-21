import { createHash, randomUUID } from 'node:crypto';
import { AGENT_ACTIONS_PER_MINUTE, type AgentMethod } from '@private-browser/bridge-protocol/agent';
import { canonicalAgentOrigin } from '@private-browser/bridge-protocol/agent-permissions';
import { stableStringify } from '@private-browser/bridge-protocol';
import { isAllowedRemoteUrl, isProtectedPage } from './security.js';

export type AgentProfile = 'observe' | 'develop' | 'operate';
export interface AgentPolicy {
  profile: AgentProfile;
  origins: string[];
  outside: 'observe' | 'deny';
}

export const DEFAULT_AGENT_POLICY: AgentPolicy = { profile: 'develop', origins: [], outside: 'observe' };
export const CONFIRMATION_MS = 120_000;

const actionWords = [
  'pay', 'buy', 'purchase', 'order', 'checkout', 'confirm', 'delete', 'remove', 'publish', 'post', 'send',
  'transfer', 'approve', 'authorize', 'authorise', 'sign', 'subscribe', 'submit', 'consent',
  'payer', 'acheter', 'commander', 'confirmer', 'supprimer', 'retirer', 'publier', 'poster', 'envoyer',
  'transférer', 'approuver', 'autoriser', 'signer', 'abonner', 'soumettre', 'accepter',
  'ادفع', 'دفع', 'اشتر', 'شراء', 'اطلب', 'طلب', 'أكد', 'تأكيد', 'احذف', 'حذف', 'أزل', 'إزالة',
  'انشر', 'نشر', 'أرسل', 'إرسال', 'حول', 'تحويل', 'وافق', 'موافقة', 'اعتماد', 'تفويض', 'وقع', 'توقيع', 'اشترك', 'اشتراك',
];
const actionPattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${actionWords.map(normalize).join('|')})(?=$|[^\\p{L}\\p{N}])`, 'u');

function normalize(text: string): string {
  return text.normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Cf}\u0640]/gu, '');
}

export function agentLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

const excludedHosts = [
  'accounts.google.com', 'oauth2.googleapis.com', 'myaccount.google.com', 'passwords.google.com',
  'myvault.digitronics-electro.workers.dev',
];

export function agentUrl(value: string): URL {
  if (!isAllowedRemoteUrl(value)) throw new AgentError('URL_DENIED', 'Choose a supported web address.');
  const url = new URL(value);
  const rawOrigin = /^https?:\/\/[^/?#]+/iu.exec(value)?.[0];
  try { if (!rawOrigin || canonicalAgentOrigin(rawOrigin) !== url.origin) throw new Error(); }
  catch { throw new AgentError('URL_DENIED', 'Choose a supported web address with an unambiguous host.'); }
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(url.pathname); } catch {
    throw new AgentError('URL_DENIED', 'This address has an invalid path.');
  }
  const host = url.hostname.replace(/\.$/, '');
  if (isProtectedPage(url.href) || isProtectedPage(`${url.origin}${decodedPath}`)
    || excludedHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))) {
    throw new AgentError('URL_DENIED', 'This address is protected.');
  }
  return url;
}

export function exactAgentOrigin(value: string): string {
  const url = agentUrl(value.trim());
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new AgentError('ORIGIN_REQUIRED', 'Enter an exact origin with its scheme and port.');
  }
  return url.origin;
}

export function agentAccess(policy: AgentPolicy, url: URL): 'drive' | 'observe' | 'deny' {
  if (policy.profile === 'observe') return policy.outside === 'deny' && !policy.origins.includes(url.origin) && !agentLoopback(url) ? 'deny' : 'observe';
  if (policy.origins.includes(url.origin) || (policy.profile === 'develop' && agentLoopback(url))) return 'drive';
  return policy.outside;
}

export interface AgentElementAction {
  name: string;
  nearby: string;
  formMethod?: string;
  formTarget?: string;
  link?: string;
  submit?: boolean;
}

export function consequentialAction(method: AgentMethod, current: URL, element?: AgentElementAction, destination?: URL, allowPublicLink = false): boolean {
  if (method === 'upload_file' || method === 'handle_dialog' || method === 'drag') return true;
  if (destination && current.origin !== destination.origin) return true;
  if (element?.link && agentUrl(element.link).origin !== current.origin && !allowPublicLink) return true;
  if (method === 'press_key') return true;
  if (method !== 'click' && method !== 'type' && method !== 'check' && method !== 'select_option') return false;
  if (/\/(?:oauth2?|consent|authorize)(?:\/|$)/i.test(current.pathname)) return true;
  if (element?.submit && element.formMethod?.toUpperCase() !== 'GET') return true;
  return actionPattern.test(normalize(`${element?.name ?? ''} ${element?.nearby ?? ''}`));
}

export class AgentError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function agentError(error: unknown): { code: string; message: string } {
  if (error instanceof AgentError) return { code: error.code, message: error.message };
  return { code: 'AGENT_ACTION_FAILED', message: 'The browser could not complete this action. Refresh the snapshot and try again.' };
}

export class AgentRateLimit {
  private actions: number[] = [];

  take(now = Date.now(), actionsPerMinute = AGENT_ACTIONS_PER_MINUTE): void {
    this.actions = this.actions.filter((at) => now - at < 60_000);
    if (this.actions.length >= actionsPerMinute) {
      throw new AgentError('RATE_LIMIT', 'This client reached its action limit. Try again in one minute.');
    }
    this.actions.push(now);
  }
}

type Context = { session: string; tab: string; url: string; revision: string; method: AgentMethod; input: unknown };
const actionHash = (value: Context) => createHash('sha256').update(stableStringify(value)).digest('hex');

export class AgentConfirmation {
  readonly id = randomUUID();
  readonly expiresAt: number;
  private hash: string | undefined;

  constructor(value: Context, now = Date.now()) {
    this.hash = actionHash(value);
    this.expiresAt = now + CONFIRMATION_MS;
  }

  spend(value: Context, now = Date.now()): boolean {
    const expected = this.hash;
    this.hash = undefined;
    return Boolean(expected && now < this.expiresAt && actionHash(value) === expected);
  }
}
