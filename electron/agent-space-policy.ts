import { agentTools, isAgentMethod } from '@private-browser/bridge-protocol/agent';
import {
  canonicalAgentOrigin, matchesAgentOrigin, newAgentSpaceSettings, type AgentSpaceSettings,
} from '@private-browser/bridge-protocol/agent-permissions';
import { AgentError, agentLoopback, agentUrl, type AgentPolicy } from './agent-policy.js';

export type SpacePolicy = AgentSpaceSettings & {
  id: string;
  uploadRoot?: string;
  legacy?: Record<string, AgentPolicy>;
  rememberedOrigins?: Record<string, string[]>;
};
export type OriginAccess = 'drive' | 'view' | 'observe' | 'deny';
type Scope = 'document' | 'navigation' | 'tab';

const refusals = {
  UNKNOWN_TOOL: 'Unknown Private Browser tool.',
  POLICY_UNAVAILABLE: 'The browser policy could not be read. Check Settings → Agents.',
  SESSION_EXPIRED: 'This session expired. Renew it in Settings → Agents.',
  SPACE_UNAVAILABLE: 'Choose an Agent Account Space granted to this client.',
  ORIGIN_DENIED: 'This origin is outside the space’s allowed origins.',
  ORIGIN_READ_ONLY: 'This client can only read pages at this origin.',
  CLASS_DISABLED: 'This action class is disabled in this space.',
  DEVELOPMENT_ONLY: 'Diagnostics require an explicitly granted loopback origin.',
  FRAME_UNAVAILABLE: 'This action needs a current supported web frame.',
} as const;
type Refusal = keyof typeof refusals;
type Decision = { allow: true } | { allow: false; code: Refusal; message: string };
const deny = (code: Refusal): Decision => ({ allow: false, code, message: refusals[code] });

export function normalizeSpaceSettings(input: AgentSpaceSettings): AgentSpaceSettings {
  const grants = [...new Set(input.clientIds)];
  if (input.trust === 'open-web') {
    return { ...input, clientIds: grants, classes: { ...input.classes, diagnostic: false } };
  }
  const origins = [...new Set(input.origins.map((value) => {
    const rule = canonicalAgentOrigin(value, true);
    agentUrl(rule.replace('://*.', '://'));
    return rule;
  }))];
  return { ...input, origins, clientIds: grants };
}

export function allowedSpaceOrigin(space: SpacePolicy, url: URL, clientId: string): OriginAccess {
  if (space.trust === 'open-web') return agentLoopback(url) ? 'deny' : 'drive';
  const legacy = space.legacy?.[clientId];
  if (legacy) {
    if (!matchesAgentOrigin(legacy.origins, url)) return legacy.outside;
    return legacy.profile === 'observe' ? 'observe' : 'drive';
  }
  return matchesAgentOrigin(space.origins, url) ? 'drive' : space.outside;
}

export function canRememberNavigation(space: SpacePolicy, clientId: string, url: URL): boolean {
  if (space.trust !== 'work' || !space.clientIds.includes(clientId)) return false;
  const exact = space.legacy?.[clientId]?.origins ?? space.origins;
  return exact.includes(url.origin) && allowedSpaceOrigin(space, url, clientId) === 'drive';
}

export function pruneRememberedOrigins(space: SpacePolicy, previous = space.rememberedOrigins): SpacePolicy['rememberedOrigins'] {
  if (!previous) return undefined;
  const kept = Object.fromEntries(space.clientIds.flatMap((id) => {
    const rules = previous[id]?.filter((origin) => canRememberNavigation(space, id, new URL(origin))) ?? [];
    return rules.length ? [[id, rules] as const] : [];
  }));
  return Object.keys(kept).length ? kept : undefined;
}

export function decide(
  space: SpacePolicy | undefined,
  tool: string,
  frameOrigin: string | undefined,
  now: number,
  session: { clientId: string; expiresAt: number },
  scope: Scope = 'document',
  signedOut = false,
): Decision {
  if (!isAgentMethod(tool)) return deny('UNKNOWN_TOOL');
  if (!Number.isFinite(session.expiresAt) || now >= session.expiresAt) return deny('SESSION_EXPIRED');
  if (!space) return deny('POLICY_UNAVAILABLE');
  if (!space.clientIds.includes(session.clientId)) return deny('SPACE_UNAVAILABLE');
  const { actionClass } = agentTools[tool];
  if (scope === 'tab' && tool === 'tab_close') return { allow: true };
  if (!space.classes[actionClass] || actionClass === 'files' && space.trust === 'work' && !space.uploadRoot) return deny('CLASS_DISABLED');
  if (scope === 'tab') return { allow: true };
  let url: URL;
  try {
    if (!frameOrigin || new URL(frameOrigin).origin !== canonicalAgentOrigin(frameOrigin)) return deny('FRAME_UNAVAILABLE');
    url = agentUrl(frameOrigin);
  } catch { return deny('FRAME_UNAVAILABLE'); }
  const access = allowedSpaceOrigin(space, url, session.clientId);
  if (access === 'deny') return deny('ORIGIN_DENIED');
  if (scope === 'navigation') return { allow: true };
  if (actionClass === 'diagnostic' && (!agentLoopback(url) || space.trust !== 'work')) return deny('DEVELOPMENT_ONLY');
  if (actionClass === 'read' || (actionClass === 'view' && (access === 'view' || access === 'drive'))) return { allow: true };
  if (access !== 'drive' || signedOut) return deny('ORIGIN_READ_ONLY');
  return { allow: true };
}

export function requireDecision(result: Decision): void {
  if (!result.allow) throw new AgentError(result.code, result.message);
}

export function describeSpace(space: SpacePolicy, clientId: string) {
  const legacy = space.legacy?.[clientId];
  return {
    id: space.id, name: space.name, credentials: space.trust === 'work' ? 'owner-managed' : 'forbidden',
    origins: space.trust === 'work'
      ? { mode: 'allowlist', list: legacy ? legacy.origins : space.origins }
      : { mode: 'all-web' },
    outside: space.trust === 'work' ? legacy?.outside ?? space.outside : 'deny',
    classes: space.classes,
    uploadRootPresent: Boolean(space.uploadRoot),
  };
}

export function makeSpace(id: string, name: string, trust: SpacePolicy['trust']): SpacePolicy {
  return { ...newAgentSpaceSettings(name, trust), id };
}
