import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateIdentity } from '@private-browser/bridge-protocol';
import { AGENT_SESSION_MS, parseAgentRequest } from '@private-browser/bridge-protocol/agent';
import { AgentHost } from '../electron/agent-host';
import type { AgentConnection, AgentPipe, AgentRequest } from '../electron/agent-pipe';
import { DEFAULT_AGENT_POLICY, type AgentPolicy } from '../electron/agent-policy';
import type { AgentTab } from '../electron/agent-workspace';
import { allowedSpaceOrigin, type SpacePolicy } from '../electron/agent-space-policy';
import { loadAgentState, type StoredState } from '../electron/agent-state';

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
    addSpace() {}
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
    isPaused() { return false; }
    possibleSignIn() { return undefined; }
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
    async create(space: SpacePolicy, connection: AgentConnection, target: URL) {
      const id = randomUUID();
      const tab = {
        id, space, connection, manual: false, signedOut: allowedSpaceOrigin(space, target, connection.device.id) !== 'drive',
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

const ownerPolicy = { ...DEFAULT_AGENT_POLICY, origins: [origin] };
const workId = randomUUID();

async function start(
  policy: AgentPolicy & { session?: '1h' | '8h' | 'open' } = ownerPolicy,
  rememberedOrigins?: string[],
  expired = false,
  files = false,
) {
  const { state } = loadAgentState({
    enabled: true, identity,
    clients: [{ ...device, policy, rememberedOrigins }],
    spaces: [{ id: workId, name: 'Work' }],
  }, initialTime);
  if (!expired) state.clients[0].expiresAt = initialTime + state.clients[0].limits.sessionMs;
  if (files) state.spaces[0] = { ...state.spaces[0], classes: { ...state.spaces[0].classes, files: true }, uploadRoot: 'fixture-folder' };
  fixture.stored = state;
  host = new AgentHost({
    data: 'test-fixture', rendezvous: 'test-pipe', chromeUrl: '', preload: '',
    parent: () => undefined, onChange: () => undefined, command: 'node', commandArgs: [],
  });
  await host.start();
}

function connect() {
  const pipe = fixture.pipe!;
  const grant = pipe.authorize(device);
  if (!grant || grant === 'expired') return;
  const { expiresAt } = grant;
  const controller = new AbortController();
  const connection: AgentConnection = {
    id: randomUUID(), device, expiresAt, abort: controller.signal,
    close: () => { controller.abort(); pipe.closed(connection); },
  };
  pipe.opened(connection);
  return connection;
}

function request(connection: AgentConnection, method: AgentRequest['method'], input: Record<string, unknown> = {}) {
  fixture.pipe!.takeAction(connection);
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
  it('requires owner renewal before allowing a migrated lease', async () => {
    await start(ownerPolicy, undefined, true);
    expect(host.status().clients[0].limits.sessionMs).toBe(AGENT_SESSION_MS);
    expect(fixture.pipe!.authorize(device)).toBe('expired');
    host.renew(device.id);
    expect(connect()?.expiresAt).toBe(initialTime + AGENT_SESSION_MS);
  });

  it('retains an eight-hour deadline and refuses reconnect after it expires', async () => {
    await start({ ...ownerPolicy, session: '8h' });
    const first = connect()!;
    expect(first.expiresAt).toBe(initialTime + 8 * AGENT_SESSION_MS);
    first.close();
    vi.setSystemTime(initialTime + AGENT_SESSION_MS + 1);
    const resumed = connect()!;
    expect(resumed.expiresAt).toBe(first.expiresAt);
    resumed.close();
    vi.setSystemTime(first.expiresAt + 1);
    expect(fixture.pipe!.authorize(device)).toBe('expired');
  });

  it('bounds the former open mode to twelve hours and requires renewal', async () => {
    await start({ ...ownerPolicy, session: 'open' });
    const first = connect()!;
    expect(first.expiresAt).toBe(initialTime + 12 * AGENT_SESSION_MS);
    first.close();
    vi.setSystemTime(first.expiresAt + 1);
    expect(fixture.pipe!.authorize(device)).toBe('expired');
    host.renew(device.id);
    expect(connect()?.expiresAt).toBe(first.expiresAt + 1 + 12 * AGENT_SESSION_MS);
  });

  it('preserves expiry through Stop and Resume and refuses revoked clients', async () => {
    await start();
    const first = connect()!;
    vi.setSystemTime(first.expiresAt + 1);
    host.stop();
    expect(first.abort.aborted).toBe(true);
    expect(host.status().clients[0].expiresAt).toBe(first.expiresAt);
    expect(connect()).toBeUndefined();
    await host.resume();
    expect(fixture.pipe!.authorize(device)).toBe('expired');
    host.renew(device.id);
    const resumed = connect()!;
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
    await start();
    const connection = connect()!;
    await openOnce(connection);
    const repeat = request(connection, 'tab_open', { url });
    const card = await pending();
    expect(card.canAllowAlways).toBe(true);
    host.decide(card.id, 'always');
    await repeat;

    expect(fixture.save).toHaveBeenCalledOnce();
    expect(fixture.save).toHaveBeenLastCalledWith(expect.stringContaining('clients.enc'), expect.objectContaining({
      spaces: expect.arrayContaining([expect.objectContaining({
        id: workId, origins: [origin], rememberedOrigins: { [device.id]: [origin] },
      })]),
    }));
    expect(connection.abort.aborted).toBe(false);
    expect(host.status().clients[0]).toMatchObject({ active: true, expiresAt: connection.expiresAt });
    await expect(request(connection, 'browser_status')).resolves.toMatchObject({ spaces: [expect.objectContaining({ origins: { mode: 'allowlist', list: [origin] } })] });
    await expect(request(connection, 'tab_open', { url })).resolves.toBeDefined();
  });

  it.each([
    ['upload_file', { ref: 'e1', path: 'fixture.txt' }],
    ['click', { ref: 'e1' }],
    ['press_key', { key: 'Enter' }],
    ['handle_dialog', { accept: true }],
    ['navigate', { url: 'http://localhost:3001/fixture' }],
  ] satisfies [AgentRequest['method'], Record<string, unknown>][])('refuses a forged always decision for %s', async (method, input) => {
    await start(ownerPolicy, undefined, false, method === 'upload_file');
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
    const { id, uploadRootPresent, migrated, ...settings } = host.status().spaces[0];
    host.setSpace(id, { ...settings, trust: 'work', origins: [], outside: 'view' });
    const saved = fixture.save.mock.lastCall?.[1] as StoredState;
    expect(saved.spaces[0].rememberedOrigins).toBeUndefined();
  });

  it('cannot remember an unlisted origin or add it through the approval dialog', async () => {
    await start({ ...ownerPolicy, origins: [] });
    const connection = connect()!;
    await openOnce(connection);
    const repeat = request(connection, 'tab_open', { url });
    const card = await pending();
    expect(card.canAllowAlways).toBe(false);
    host.decide(card.id, 'always');
    expect(host.status().pending?.id).toBe(card.id);
    host.decide(card.id, 'deny');
    await expect(repeat).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    expect(fixture.save).not.toHaveBeenCalled();
  });

  it('discards the grant when the inspected page changes before approval', async () => {
    await start();
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
