import { getDomain } from 'tldts';
import type { AgentSpaceSettings, ClientLimits } from './agent-permissions.js';

export const actionClasses = ['read', 'view', 'interact', 'files', 'diagnostic'] as const;
export type AgentActionClass = typeof actionClasses[number];
export const agentSessionCapSettings = { default: 12 * 60 * 60_000, min: 60_000, max: 24 * 60 * 60_000 } as const;
export const clientLimitSettings = {
  actionsPerMinute: { default: 120, min: 1, max: 240 },
  tabs: { default: 8, min: 1, max: 12 },
  idleMs: { default: 30 * 60_000, min: 60_000, max: 60 * 60_000 },
  sessionMs: { ...agentSessionCapSettings, default: 8 * 60 * 60_000 },
} as const;
export const defaultClientLimits: ClientLimits = {
  actionsPerMinute: clientLimitSettings.actionsPerMinute.default,
  tabs: clientLimitSettings.tabs.default,
  idleMs: clientLimitSettings.idleMs.default,
  sessionMs: clientLimitSettings.sessionMs.default,
};

const originAddress = /^(https?):\/\/([^/?#]+)\/?$/iu;
const ipv4 = /^(?:[0-9]+\.){3}[0-9]+$/u;
const invalidOrigin = () => new Error('Enter HTTP or HTTPS, a host and an optional port. Remove paths and account information.');

export function canonicalAgentOrigin(value: string, allowWildcard = false): string {
  const match = originAddress.exec(value.trim());
  if (!match || /[@%\\\s\p{C}]/u.test(match[2])) throw invalidOrigin();
  const [, scheme, authority] = match;
  const wildcard = authority.startsWith('*.');
  if (wildcard && !allowWildcard || authority.slice(wildcard ? 2 : 0).includes('*')) throw invalidOrigin();
  const hostPort = authority.slice(wildcard ? 2 : 0);
  const parts = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::[0-9]+)?$/iu.exec(hostPort);
  if (!parts) throw invalidOrigin();
  const url = new URL(scheme + '://' + hostPort);
  const hostname = url.hostname.replace(/\.$/u, '');
  if (ipv4.test(hostname) && (!ipv4.test(parts[1]) || parts[1] !== hostname)) throw invalidOrigin();
  if (!hostname.startsWith('[') && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(hostname)) throw invalidOrigin();
  if (wildcard && (!getDomain(hostname, { allowPrivateDomains: true }) || url.hostname.endsWith('.'))) {
    throw new Error('Choose a registrable domain and omit the trailing dot for a subdomain rule.');
  }
  return wildcard ? url.protocol + '//*.' + url.host : url.origin;
}

export function matchesAgentOrigin(rules: readonly string[], url: URL): boolean {
  return rules.some((rule) => {
    if (rule === url.origin) return true;
    const marker = rule.indexOf('://*.');
    if (marker === -1) return false;
    const suffix = new URL(rule.replace('://*.', '://'));
    return suffix.protocol === url.protocol && suffix.port === url.port && url.hostname.endsWith('.' + suffix.hostname);
  });
}

export function newAgentSpaceSettings(name: string, trust: AgentSpaceSettings['trust']): AgentSpaceSettings {
  const shared = {
    name, clientIds: [], downloadQuotaMb: 500,
    classes: { read: true, view: true, interact: true, files: trust === 'open-web', diagnostic: false },
  };
  return trust === 'open-web' ? { ...shared, trust } : { ...shared, trust, origins: [], outside: 'view' };
}
