import { randomUUID } from 'node:crypto';
import {
  AGENT_ACTIONS_PER_MINUTE, AGENT_IDLE_MS, AGENT_MAX_TABS, AGENT_SESSION_MS, agentIdentity,
} from '@private-browser/bridge-protocol/agent';
import {
  agentSpaceSettings, clientLimits, clientLimitSettings, defaultClientLimits, type ClientLimits,
} from '@private-browser/bridge-protocol/agent-permissions';
import { type DeviceIdentity } from '@private-browser/bridge-protocol';
import { exactAgentOrigin, type AgentPolicy } from './agent-policy.js';
import { makeSpace, normalizeSpaceSettings, pruneRememberedOrigins, type SpacePolicy } from './agent-space-policy.js';

type Device = ReturnType<typeof agentIdentity.parse>['device'];
export type StoredClient = Device & { limits: ClientLimits; expiresAt?: number };
export type StoredState = { version: 2; enabled: boolean; identity: DeviceIdentity; clients: StoredClient[]; spaces: SpacePolicy[] };
const legacyLimits = { actionsPerMinute: AGENT_ACTIONS_PER_MINUTE, tabs: AGENT_MAX_TABS, idleMs: AGENT_IDLE_MS, sessionMs: AGENT_SESSION_MS };
const invalid = () => new Error('Invalid Agent Mode policy.');

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(value)) throw invalid();
  return value;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid();
  return value;
}
function legacyPolicy(value: unknown): AgentPolicy {
  const { profile, origins, outside } = record(value);
  if (profile !== 'observe' && profile !== 'develop' && profile !== 'operate' || outside !== 'observe' && outside !== 'deny') throw invalid();
  return { profile, outside, origins: list(origins, 30).map((origin) => exactAgentOrigin(text(origin, 300))) };
}

function previousLimits(policy: unknown): ClientLimits {
  const { session } = record(policy);
  if (session === 'open') return { ...legacyLimits, sessionMs: clientLimitSettings.sessionMs.max };
  if (session === '8h') return { ...legacyLimits, sessionMs: 8 * AGENT_SESSION_MS };
  if (session === undefined || session === '1h') return legacyLimits;
  throw invalid();
}

function rememberedRules(value: unknown): string[] {
  return [...new Set(list(value, 30).map((rule) => exactAgentOrigin(text(rule, 300))))];
}

export function loadAgentState(value: unknown, now: number): { state: StoredState; migrated: boolean } {
  const { version, enabled, identity, clients, spaces } = record(value);
  if (version !== undefined && version !== 2 || typeof enabled !== 'boolean') throw invalid();
  const { publicKey, privateKey } = record(identity);
  const keys = { publicKey: text(publicKey, 200), privateKey: text(privateKey, 200) };
  const migrated = version === undefined;
  // A v1 file has no absolute expiry persisted. Require the owner to renew once.
  const storedClients = list(clients, 12).map((entry): StoredClient => {
    const { id, name, publicKey, limits, expiresAt, policy } = record(entry);
    if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)) throw invalid();
    return {
      id: uuid(id), name: text(name, 60), publicKey: text(publicKey, 200),
      limits: migrated ? previousLimits(policy) : clientLimits.parse(limits),
      expiresAt: migrated ? now : expiresAt,
    };
  });
  const clientIds = storedClients.map(({ id }) => id);
  if (new Set(clientIds).size !== clientIds.length) throw invalid();
  const spaceRows = list(spaces, migrated ? 8 : 9);
  const storedSpaces = spaceRows.map((entry): SpacePolicy => {
    const { id, uploadRoot, legacy, rememberedOrigins, ...settings } = record(entry);
    if (migrated) {
      const ceilings = Object.fromEntries(list(clients, 12).map((client) => {
        const row = record(client);
        return [uuid(row.id), legacyPolicy(row.policy)] as const;
      }));
      const origins = [...new Set(Object.values(ceilings).flatMap((policy) => policy.origins))];
      const space: SpacePolicy = {
        ...makeSpace(uuid(id), text(settings.name, 60), 'work'), trust: 'work', clientIds,
        origins: origins.length <= 30 ? origins : [], outside: 'observe', legacy: ceilings,
      };
      const remembered = Object.fromEntries(list(clients, 12).flatMap((entry) => {
        const client = record(entry);
        return client.rememberedOrigins === undefined ? [] : [[uuid(client.id), rememberedRules(client.rememberedOrigins)] as const];
      }));
      return { ...space, rememberedOrigins: pruneRememberedOrigins(space, remembered) };
    }
    const normalized = normalizeSpaceSettings(agentSpaceSettings.parse(settings));
    if (normalized.clientIds.some((clientId) => !clientIds.includes(clientId))) throw invalid();
    const ceilings = legacy === undefined ? undefined : Object.fromEntries(Object.entries(record(legacy)).map(([id, policy]) => {
      if (!normalized.clientIds.includes(id)) throw invalid();
      return [id, legacyPolicy(policy)] as const;
    }));
    const space: SpacePolicy = {
      ...normalized, id: uuid(id), uploadRoot: uploadRoot === undefined ? undefined : text(uploadRoot, 2_000), legacy: ceilings,
    };
    const remembered = rememberedOrigins === undefined ? undefined : Object.fromEntries(Object.entries(record(rememberedOrigins)).map(([id, rules]) => {
      if (!normalized.clientIds.includes(id)) throw invalid();
      return [id, rememberedRules(rules)] as const;
    }));
    return { ...space, rememberedOrigins: pruneRememberedOrigins(space, remembered) };
  });
  if (migrated) storedSpaces.push(makeSpace(randomUUID(), 'Open Web', 'open-web'));
  if (new Set(storedSpaces.map(({ id }) => id)).size !== storedSpaces.length
    || storedSpaces.filter((space) => space.trust === 'open-web').length !== 1
    || !storedSpaces.some((space) => space.trust === 'work')) throw invalid();
  return { state: { version: 2, enabled, identity: keys, clients: storedClients, spaces: storedSpaces }, migrated };
}

export function newAgentState(identity: DeviceIdentity): StoredState {
  return {
    version: 2, enabled: false, identity, clients: [],
    spaces: [makeSpace(randomUUID(), 'Work', 'work'), makeSpace(randomUUID(), 'Open Web', 'open-web')],
  };
}

export function newAgentClient(device: Device, now: number): StoredClient {
  return { ...device, limits: defaultClientLimits, expiresAt: now + defaultClientLimits.sessionMs };
}
