import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateIdentity } from '@private-browser/bridge-protocol';
import { AGENT_SESSION_MS, parseAgentRequest } from '@private-browser/bridge-protocol/agent';
import { AgentHost } from '../electron/agent-host';
import type { AgentConnection, AgentPipe, AgentRequest } from '../electron/agent-pipe';
import { DEFAULT_AGENT_POLICY, type AgentPolicy } from '../electron/agent-policy';
import type { AgentSpace, AgentTab } from '../electron/agent-workspace';

type PipeCallbacks = ConstructorParameters<typeof AgentPipe>[0];

const fixture = vi.hoisted(() => ({
  stored: undefined as unknown,
  pipe: undefined as PipeCallbacks | undefined,
  save: vi.fn(),
  siteRevision: vi.fn<() => string | null>(),
}));

vi.mock('electron', () => ({ dialog: {}, nativeImage: {} }));
vi.mock('../electron/agent-audit', () => ({
  AgentAudit: class {
    add() {}
    list() { return []; }
  },
  agentStorageAvailable: () => true,
  readAgentFile: () => fixture.stored,
  writeAgentFile: fixture.save,
}));
vi.mock('../electron/agent-pipe', () => ({
  AgentPipe: class {
    constructor(options: PipeCallbacks) { fixture.pipe = options; }
    async start() {}
    stop() {}
  },
}));
vi.mock('../electron/agent-workspace', () => ({
  agentTabUrl: (tab: AgentTab) => tab.view.webContents.getURL(),
  AgentWorkspace: class {
    private tabs = new Map<string, AgentTab>();
    private addresses = new Map<string, string>();
    selected?: string;
    broadcast() {}
    summaries() { return []; }
    async show() {}
    setHidden() {}
    get(id: string) { return this.tabs.get(id); }
    forConnection(connection: AgentConnection) {
      return [...this.tabs.values()].filter((tab) => tab.connection === connection);
    }
    closeConnection(connection: AgentConnection) {
      for (const tab of this.forConnection(connection)) this.close(tab.id);
    }
    closeAll() {
      for (const id of this.tabs.keys()) this.close(id);
    }
    close(id: string) {
      this.tabs.delete(id);
      this.addresses.delete(id);
    }
    async create(space: AgentSpace, connection: AgentConnection, policy: AgentPolicy) {
      const id = randomUUID();
      const tab = {
        id, space, connection, policy, manual: false,
        view: { webContents: {
          getURL: () => this.addresses.get(id),
          isDestroyed: () => !this.tabs.has(id),
          isLoadingMainFrame: () => false,
        } },
        driver: {
          run: async (command: string) => {
            if (command === 'siteApprovalRevision') return fixture.siteRevision();
            if (command === 'inspect') {
              return { revision: 'document:1', private: false, role: 'button', name: 'Delete entry', nearby: '' };
            }
            return 'document:1';
          },
          dialogRevision: () => 'document:1',
        },
      } as unknown as AgentTab;
      this.tabs.set(id, tab);
      this.selected = id;
      return tab;
    }
    async load(tab: AgentTab, destination: URL) {
      this.addresses.set(tab.id, destination.href);
      tab.origin = destination.origin;
    }
  },
}));

const origin = 'http://localhost:3000';
const url = origin + '/fixture';
const initialTime = new Date('2026-01-01T00:00:00Z').getTime();
const identity = generateIdentity();
const device = { id: randomUUID(), name: 'Codex', publicKey: identity.publicKey };
let host: AgentHost;

async function start(policy: Omit<AgentPolicy, 'session'> & { session?: AgentPolicy['session'] }, rememberedOrigins?: string[]) {
  fixture.stored = {
    enabled: true, identity,
    clients: [{ ...device, policy, rememberedOrigins, uploadFolder: 'approved-fixture-folder' }],
    spaces: [{ id: randomUUID(), name: 'Agent Account Space' }],
  };
  host = new AgentHost({
    data: 'test-fixture', rendezvous: 'test-pipe', chromeUrl: '', preload: '',
    parent: () => undefined, onChange: () => undefined, command: 'node', commandArgs: [],
    discover: async () => [],
  });
  await host.start();
}

function connect() {
  const pipe = fixture.pipe!;
  const expiresAt = pipe.authorize(device);
  if (expiresAt === undefined) return;
  const controller = new AbortController();
  const connection: AgentConnection = {
    id: randomUUID(), device, expiresAt, abort: controller.signal,
    close: () => { controller.abort(); pipe.closed(connection); },
  };
  pipe.opened(connection);
  return connection;
}

function request(connection: AgentConnection, method: AgentRequest['method'], input: Record<string, unknown> = {}) {
  return fixture.pipe!.request(connection, parseAgentRequest({ kind: 'request', id: randomUUID(), method, input }));
}

async function pending() {
  return vi.waitFor(() => {
    const card = host.status().pending;
    if (!card) throw new Error('Expected an approval card.');
    return card;
  });
}

async function openOnce(connection: AgentConnection) {
  const opening = request(connection, 'tab_open', { url });
  const card = await pending();
  expect(card.canAllowAlways).toBe(false);
  host.decide(card.id, 'allow');
  return opening;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(initialTime);
  fixture.pipe = undefined;
  fixture.save.mockReset();
  fixture.siteRevision.mockReset().mockReturnValue('document:1');
});

afterEach(() => {
  host?.stop();
  vi.useRealTimers();
});

describe('Agent Host sessions', () => {
  it('loads a legacy stored policy as one hour and requires renewal after expiry', async () => {
    const { session, ...legacy } = DEFAULT_AGENT_POLICY;
    await start(legacy);
    expect(host.status().clients[0].policy.session).toBe(session);
    const first = connect()!;
    expect(first.expiresAt).toBe(initialTime + AGENT_SESSION_MS);
    expect(host.status().clients[0].expiresAt).toBe(first.expiresAt);
    first.close();
    vi.setSystemTime(first.expiresAt + 1);
    expect(connect()).toBeUndefined();
    host.renew(device.id);
    expect(connect()?.expiresAt).toBe(first.expiresAt + 1 + AGENT_SESSION_MS);
  });

  it('reuses a valid eight-hour lease and renews it on reconnect after expiry', async () => {
    await start({ ...DEFAULT_AGENT_POLICY, session: '8h' });
    const first = connect()!;
    expect(first.expiresAt).toBe(initialTime + 8 * AGENT_SESSION_MS);
    first.close();
    vi.setSystemTime(initialTime + AGENT_SESSION_MS + 1);
    const resumed = connect()!;
    expect(resumed.expiresAt).toBe(first.expiresAt);
    resumed.close();
    vi.setSystemTime(first.expiresAt + 1);
    expect(connect()?.expiresAt).toBe(first.expiresAt + 1 + 8 * AGENT_SESSION_MS);
  });

  it('refreshes the bounded open lease on every reconnect', async () => {
    await start({ ...DEFAULT_AGENT_POLICY, session: 'open' });
    const first = connect()!;
    expect(first.expiresAt).toBe(initialTime + 24 * AGENT_SESSION_MS);
    first.close();
    const later = initialTime + AGENT_SESSION_MS + 1;
    vi.setSystemTime(later);
    const resumed = connect()!;
    expect(resumed.expiresAt).toBe(later + 24 * AGENT_SESSION_MS);
    resumed.close();
    vi.setSystemTime(resumed.expiresAt + 1);
    expect(connect()?.expiresAt).toBe(resumed.expiresAt + 1 + 24 * AGENT_SESSION_MS);
  });

  it('closes sessions and clears leases on Stop, refuses until Resume, and denies revoked clients', async () => {
    await start(DEFAULT_AGENT_POLICY);
    const first = connect()!;
    vi.setSystemTime(first.expiresAt + 1);
    host.stop();
    expect(first.abort.aborted).toBe(true);
    expect(host.status().clients[0].expiresAt).toBeUndefined();
    expect(connect()).toBeUndefined();
    await host.resume();
    const resumed = connect()!;
    expect(resumed.expiresAt).toBe(first.expiresAt + 1 + AGENT_SESSION_MS);
    host.revoke(device.id);
    expect(resumed.abort.aborted).toBe(true);
    expect(connect()).toBeUndefined();
    host.stop();
    await host.resume();
    expect(connect()).toBeUndefined();
  });
});

describe('Agent Host remembered site approval', () => {
  it('saves an exact origin without closing the session and uses the saved policy', async () => {
    await start(DEFAULT_AGENT_POLICY);
    const connection = connect()!;
    await openOnce(connection);
    const repeat = request(connection, 'tab_open', { url });
    const card = await pending();
    expect(card.canAllowAlways).toBe(true);
    host.decide(card.id, 'always');
    await repeat;

    expect(fixture.save).toHaveBeenCalledOnce();
    expect(fixture.save).toHaveBeenLastCalledWith(expect.stringContaining('clients.enc'), expect.objectContaining({
      clients: [expect.objectContaining({
        policy: { ...DEFAULT_AGENT_POLICY, origins: [origin] }, rememberedOrigins: [origin],
      })],
    }));
    expect(connection.abort.aborted).toBe(false);
    expect(host.status().clients[0]).toMatchObject({ active: true, expiresAt: connection.expiresAt });
    await expect(request(connection, 'browser_status')).resolves.toMatchObject({ allowedOrigins: [origin] });
    await expect(request(connection, 'tab_open', { url })).resolves.toBeDefined();
  });

  it.each([
    ['upload_file', { ref: 'e1', path: 'fixture.txt' }],
    ['click', { ref: 'e1' }],
    ['press_key', { key: 'Enter' }],
    ['handle_dialog', { accept: true }],
    ['navigate', { url: 'http://localhost:3001/fixture' }],
  ] satisfies [AgentRequest['method'], Record<string, unknown>][])('refuses a forged always decision for %s', async (method, input) => {
    await start(DEFAULT_AGENT_POLICY);
    const connection = connect()!;
    await openOnce(connection);
    const action = request(connection, method, input);
    const card = await pending();
    expect(card.canAllowAlways).toBe(false);
    host.decide(card.id, 'always');
    expect(host.status().pending?.id).toBe(card.id);
    host.decide(card.id, 'deny');
    await expect(action).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('keeps prompting for a sensitive page even at an approved origin', async () => {
    await start({ ...DEFAULT_AGENT_POLICY, origins: [origin] }, [origin]);
    const connection = connect()!;
    await openOnce(connection);
    fixture.siteRevision.mockReturnValue(null);
    const repeat = request(connection, 'tab_open', { url });
    const card = await pending();
    expect(card.canAllowAlways).toBe(false);
    host.decide(card.id, 'always');
    expect(host.status().pending?.id).toBe(card.id);
    host.decide(card.id, 'deny');
    await expect(repeat).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('keeps existing manual origin permissions separate from remembered approvals', async () => {
    await start({ ...DEFAULT_AGENT_POLICY, origins: [origin] });
    const connection = connect()!;
    await openOnce(connection);
    const repeat = request(connection, 'tab_open', { url });
    const card = await pending();
    expect(card.canAllowAlways).toBe(true);
    host.decide(card.id, 'deny');
    await expect(repeat).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('forgets approvals when their origin is removed from client settings', async () => {
    await start({ ...DEFAULT_AGENT_POLICY, origins: [origin] }, [origin]);
    host.setPolicy(device.id, DEFAULT_AGENT_POLICY);
    expect(fixture.save).toHaveBeenLastCalledWith(expect.stringContaining('clients.enc'), expect.objectContaining({
      clients: [expect.objectContaining({ rememberedOrigins: [] })],
    }));
  });

  it('discards the grant when the inspected page changes before approval', async () => {
    await start(DEFAULT_AGENT_POLICY);
    const connection = connect()!;
    await openOnce(connection);
    const repeat = request(connection, 'tab_open', { url });
    const card = await pending();
    expect(card.canAllowAlways).toBe(true);
    fixture.siteRevision.mockReturnValue('document:2');
    host.decide(card.id, 'always');
    await expect(repeat).rejects.toMatchObject({ code: 'PAGE_CHANGED' });
    expect(fixture.save).not.toHaveBeenCalled();
  });
});
