import { generateIdentity } from '@private-browser/bridge-protocol';
import { agentTools, type AgentMethod } from '@private-browser/bridge-protocol/agent';
import {
  canonicalAgentOrigin, clientLimits, defaultClientLimits, matchesAgentOrigin,
} from '@private-browser/bridge-protocol/agent-permissions';
import { describe, expect, it } from 'vitest';
import { decide, describeSpace, makeSpace, normalizeSpaceSettings, requireDecision, type SpacePolicy } from '../electron/agent-space-policy';
import { loadAgentState } from '../electron/agent-state';
import { isPublicAgentAddress } from '../electron/agent-public-proxy';

const clientId = '39780f65-9ae5-4fde-a090-f35bce8cb7ac';
const spaceId = '33442f3e-bbd0-47bf-aea7-c6f48640e83d';
const session = { clientId, expiresAt: 500 };
const listed = 'https://app.example.com';
const unlisted = 'https://help.example.org';
const loopback = 'http://127.0.0.1:3000';
const work = (): SpacePolicy => ({
  ...makeSpace(spaceId, 'Work', 'work'), trust: 'work', clientIds: [clientId], origins: [listed, loopback], outside: 'view',
});
const open = (): SpacePolicy => ({ ...makeSpace(spaceId, 'Open Web', 'open-web'), clientIds: [clientId] });

describe('Agent origin rules', () => {
  it.each([
    ['HTTPS://App.Example.com:443', listed], ['http://app.example.com:80/', 'http://app.example.com'],
    ['https://app.example.com:8080', 'https://app.example.com:8080'], ['https://example.com.', 'https://example.com.'],
    ['https://BÜCHER.example.com', 'https://xn--bcher-kva.example.com'], ['http://[0:0::1]:3000', 'http://[::1]:3000'],
    ['https://*.App.Example.com:443', 'https://*.app.example.com'],
  ])('normalizes %s', (input, origin) => expect(canonicalAgentOrigin(input, true)).toBe(origin));

  it.each([
    'example.org', 'https://example.org/path', 'https://example.org/#', 'https://example.org?',
    'https://a b.example.org', 'https://example.org\\x', 'https://%65xample.org', 'https://someone@example.org',
    'https://..example.org', 'https://a-.example.org', 'https://example.org:bad', 'https://example.org:99999',
    'http://0x7f000001', 'http://127.1', 'http://0177.0.0.1', 'http://127.0.0.1.', 'http://[::1',
    'https://*.co.uk', 'https://*.github.io', 'https://*.example.org.', 'https://anything.*.example.org',
  ])('refuses malformed or overly broad rule %s', (input) => expect(() => canonicalAgentOrigin(input, true)).toThrow());

  it('matches exact settings and only explicitly wildcarded subdomains', () => {
    expect(() => canonicalAgentOrigin('https://*.example.com')).toThrow();
    for (const url of ['https://a.example.com', 'https://a.b.example.com']) expect(matchesAgentOrigin(['https://*.example.com'], new URL(url))).toBe(true);
    for (const url of ['https://example.com', 'https://evilexample.com', 'http://a.example.com', 'https://a.example.com:8443']) {
      expect(matchesAgentOrigin(['https://*.example.com'], new URL(url))).toBe(false);
    }
    const idn = canonicalAgentOrigin('https://bücher.example.com');
    expect(matchesAgentOrigin([idn], new URL('https://xn--bcher-kva.example.com'))).toBe(true);
    expect(matchesAgentOrigin([listed], new URL('https://аpp.example.com'))).toBe(false);
    expect(matchesAgentOrigin([listed], new URL('https://app.example.com.'))).toBe(false);
  });
});

describe('Agent space decisions', () => {
  it('uses a classified registry and strict inputs for every tool', () => {
    const expected = {
      read: 'browser_status tabs_list snapshot get_text screenshot console_messages network_requests performance_snapshot accessibility_audit downloads_list dev_servers',
      view: 'scroll hover emulate wait_for tab_select record_start record_stop',
      interact: 'navigate tab_open tab_close go_back go_forward reload click type check select_option drag press_key handle_dialog',
      files: 'upload_file', diagnostic: 'evaluate',
    };
    for (const [actionClass, methods] of Object.entries(expected)) {
      const entries = Object.entries(agentTools).filter(([, tool]) => tool.actionClass === actionClass);
      expect(entries.map(([name]) => name).sort()).toEqual(methods.split(' ').sort());
      for (const [, tool] of entries) expect(tool.input.safeParse({ policy: { allWeb: true } }).success).toBe(false);
    }
  });

  it('fails closed before executing unknown tools, expired sessions and invalid policy', () => {
    expect(decide(work(), 'set_policy', listed, 200, session)).toMatchObject({ code: 'UNKNOWN_TOOL' });
    expect(decide(undefined, 'snapshot', listed, 200, session)).toMatchObject({ code: 'POLICY_UNAVAILABLE' });
    expect(decide(work(), 'click', listed, 500, session)).toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(decide(work(), 'snapshot', listed, 200, { ...session, expiresAt: Infinity })).toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(decide(work(), 'snapshot', listed, 200, { ...session, clientId: 'another-client' })).toMatchObject({ code: 'SPACE_UNAVAILABLE' });
    for (const origin of [undefined, 'file:///tmp/file', 'data:text/plain,hi', 'chrome://settings', 'javascript:void(0)', 'blob:https://a.test/1', listed + '/path', 'https://accounts.google.com']) {
      expect(decide(work(), 'click', origin, 200, session)).toMatchObject({ code: 'FRAME_UNAVAILABLE' });
    }
  });

  it('checks the executing document and controls display tools outside the Work list', () => {
    for (const method of ['snapshot', 'emulate', 'scroll', 'hover', 'wait_for'] as const) {
      expect(decide(work(), method, unlisted, 200, session, 'document', true)).toEqual({ allow: true });
    }
    for (const method of ['reload', 'click', 'type', 'check', 'press_key'] as const) {
      expect(decide(work(), method, unlisted, 200, session)).toMatchObject({ code: 'ORIGIN_READ_ONLY' });
      expect(decide(work(), method, listed, 200, session)).toEqual({ allow: true });
    }
    expect(decide(work(), 'click', listed, 200, session, 'document', true)).toMatchObject({ code: 'ORIGIN_READ_ONLY' });
    expect(decide(work(), 'navigate', unlisted, 200, session, 'navigation')).toEqual({ allow: true });
    expect(decide(work(), 'tab_close', undefined, 200, session, 'tab')).toEqual({ allow: true });
    expect(decide(work(), 'tab_select', undefined, 200, session, 'tab')).toEqual({ allow: true });
    const base = work();
    expect(decide({ ...base, classes: { ...base.classes, view: false } }, 'tab_select', undefined, 200, session, 'tab')).toMatchObject({ code: 'CLASS_DISABLED' });
    expect(decide({ ...base, trust: 'work', origins: [listed], outside: 'observe' }, 'emulate', unlisted, 200, session)).toMatchObject({ code: 'ORIGIN_READ_ONLY' });
    expect(decide({ ...base, trust: 'work', origins: [listed], outside: 'deny' }, 'navigate', unlisted, 200, session, 'navigation')).toMatchObject({ code: 'ORIGIN_DENIED' });
  });

  it('limits diagnostics to an explicit Work loopback and files to enabled grants', () => {
    const item = work();
    const diagnostic = { ...item, classes: { ...item.classes, diagnostic: true } };
    expect(decide(diagnostic, 'evaluate', listed, 200, session)).toMatchObject({ code: 'DEVELOPMENT_ONLY' });
    expect(decide(diagnostic, 'evaluate', loopback, 200, session)).toEqual({ allow: true });
    expect(decide({ ...diagnostic, trust: 'work', outside: 'view', origins: [] }, 'evaluate', loopback, 200, session)).toMatchObject({ code: 'ORIGIN_READ_ONLY' });
    expect(decide({ ...item, classes: { ...item.classes, read: false } }, 'snapshot', listed, 200, session)).toMatchObject({ code: 'CLASS_DISABLED' });
    expect(decide(diagnostic, 'evaluate', 'http://localhost.:3000', 200, session)).toMatchObject({ code: 'DEVELOPMENT_ONLY' });
    expect(decide({ ...open(), classes: { ...open().classes, diagnostic: true } }, 'evaluate', listed, 200, session)).toMatchObject({ code: 'DEVELOPMENT_ONLY' });
    const files = { ...item, classes: { ...item.classes, files: true } };
    expect(decide(files, 'upload_file', listed, 200, session)).toMatchObject({ code: 'CLASS_DISABLED' });
    expect(decide({ ...files, uploadRoot: 'approved-fixtures' }, 'upload_file', listed, 200, session)).toEqual({ allow: true });
    for (const method of ['click', 'type', 'emulate'] as AgentMethod[]) expect(decide(open(), method, unlisted, 200, session)).toEqual({ allow: true });
    expect(decide(open(), 'navigate', loopback, 200, session, 'navigation')).toMatchObject({ code: 'ORIGIN_DENIED' });
  });

  it('migrates existing IDs and ceilings without assigning Open Web or renewing leases', () => {
    const identity = generateIdentity();
    const old = { enabled: true, identity, clients: [{
      id: clientId, name: 'Test client', publicKey: identity.publicKey, policy: { origins: [listed], profile: 'observe', outside: 'deny' },
    }], spaces: [{ id: spaceId, name: 'Agent Account Space' }] };
    const result = loadAgentState(old, 500);
    expect(result.migrated).toBe(true);
    const [space, publicSpace] = result.state.spaces;
    expect(space).toMatchObject({ id: spaceId, trust: 'work', name: 'Agent Account Space', clientIds: [clientId] });
    expect(publicSpace).toMatchObject({ trust: 'open-web', clientIds: [] });
    expect(result.state.clients[0].expiresAt).toBe(500);
    expect(decide(space, 'click', listed, 200, session)).toMatchObject({ code: 'ORIGIN_READ_ONLY' });
    expect(decide(space, 'snapshot', unlisted, 200, session)).toMatchObject({ code: 'ORIGIN_DENIED' });
    expect(loadAgentState(JSON.parse(JSON.stringify(result.state)), 900)).toEqual({ state: result.state, migrated: false });
    expect(() => loadAgentState({ ...result.state, version: 4 }, 500)).toThrow();
    expect(() => loadAgentState({ ...result.state, sessionCapMs: undefined }, 500)).toThrow();
    expect(() => loadAgentState({ ...result.state, spaces: [{ ...space, clientIds: ['unknown-client'] }] }, 500)).toThrow();
    expect(normalizeSpaceSettings({ ...open(), trust: 'open-web', classes: { ...open().classes, diagnostic: true } }).classes.diagnostic).toBe(false);
  });

  it('normalizes owner saves and reports only effective grants', () => {
    const space = work();
    const input = { ...space, trust: 'work' as const, outside: 'view' as const, clientIds: [clientId, clientId],
      origins: ['https://APP.example.com:443', listed, 'https://*.test.example.org'] };
    expect(normalizeSpaceSettings(input)).toMatchObject({ clientIds: [clientId], origins: [listed, 'https://*.test.example.org'] });
    expect(describeSpace(space, clientId)).toMatchObject({ credentials: 'owner-managed', outside: 'view', uploadRootPresent: false });
    expect(describeSpace({ ...open(), uploadRoot: 'private-folder' }, clientId)).toMatchObject({ origins: { mode: 'all-web' }, uploadRootPresent: true });
    expect(JSON.stringify(describeSpace({ ...open(), uploadRoot: 'private-folder' }, clientId))).not.toContain('private-folder');
    const legacy = { ...space, legacy: { [clientId]: { profile: 'operate' as const, outside: 'deny' as const, origins: [listed] } } };
    expect(describeSpace(legacy, clientId)).toMatchObject({ origins: { list: [listed] }, outside: 'deny' });
    expect(decide(legacy, 'click', listed, 200, session)).toEqual({ allow: true });
    expect(() => requireDecision(decide(space, 'upload_file', listed, 200, session))).toThrow('disabled');
    expect(() => requireDecision(decide(space, 'click', listed, 200, session))).not.toThrow();
  });

  it('caps limits and accepts bounded defaults', () => {
    expect(clientLimits.parse(defaultClientLimits)).toEqual(defaultClientLimits);
    expect(clientLimits.parse({ actionsPerMinute: 500, tabs: 20, idleMs: 9_000_000, sessionMs: 90_000_000 }))
      .toEqual({ actionsPerMinute: 240, tabs: 12, idleMs: 3_600_000, sessionMs: 86_400_000 });
    expect(() => clientLimits.parse({ ...defaultClientLimits, tabs: 0 })).toThrow();
  });

  it('classifies public peers without treating mapped, local, or special ranges as public', () => {
    for (const ip of ['93.184.215.14', '1.1.1.1', '2606:4700::1']) expect(isPublicAgentAddress(ip)).toBe(true);
    for (const ip of ['0.0.0.0','10.10.0.1','100.64.0.1','127.0.0.2','169.254.169.254','172.18.0.1','192.168.0.1','198.18.0.5',
      '203.0.113.2','239.0.0.1','::1','::ffff:127.0.0.1','2001:db8::1','2002:7f00:1::1','fc00::1','fe80::1%12','example.com']) {
      expect(isPublicAgentAddress(ip), ip).toBe(false);
    }
  });
});
