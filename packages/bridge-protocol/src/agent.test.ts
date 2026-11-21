import { describe, expect, it } from 'vitest';
import { generateEphemeralKeyPair, openPayload, sealPayload } from './index.js';
import { agentKeys, agentTools, parseAgentRequest } from './agent.js';

const id = 'e140c2fe-12ed-43a2-be0f-915e24b1e594';
const url = 'http://localhost:3000/';
const examples = {
  browser_status: {}, tabs_list: {}, tab_open: { url }, tab_select: { tabId: id }, tab_close: { tabId: id },
  navigate: { url }, go_back: {}, go_forward: {}, reload: {}, wait_for: { url }, snapshot: {}, screenshot: {},
  get_text: {}, click: { ref: 'e1' }, type: { ref: 'e1', text: 'fixture text' }, press_key: { key: 'Enter' },
  select_option: { ref: 'e1', value: 'option' }, check: { ref: 'e1', checked: true }, hover: { ref: 'e1' },
  scroll: { y: 600 }, drag: { fromRef: 'e1', toRef: 'e2' }, handle_dialog: { accept: false },
  upload_file: { ref: 'e1', path: 'fixture.txt' }, downloads_list: {}, console_messages: {},
  network_requests: {}, emulate: { device: 'mobile' }, evaluate: { expression: 'window.innerWidth' },
  accessibility_audit: {}, performance_snapshot: {}, dev_servers: {}, record_start: {}, record_stop: {},
} satisfies Record<keyof typeof agentTools, unknown>;

describe('Agent channel', () => {
  it('validates every tool and rejects extra fields and other bridge methods', () => {
    for (const [method, input] of Object.entries(examples)) {
      expect(parseAgentRequest({ kind: 'request', id, method, input }).input).toEqual(input);
      expect(() => parseAgentRequest({ kind: 'request', id, method, input: { ...input, approve: true } })).toThrow();
    }
    expect(() => parseAgentRequest({ kind: 'request', id, method: 'server.start', input: {} })).toThrow();
    expect(() => agentTools.wait_for.input.parse({ url, text: 'two conditions' })).toThrow();
    expect(() => agentTools.type.input.parse({ ref: 'e1', text: 'x'.repeat(4_001) })).toThrow();
  });

  it('domain-separates directions and rejects stale sequence numbers', () => {
    const browser = generateEphemeralKeyPair();
    const client = generateEphemeralKeyPair();
    const browserKeys = agentKeys({ privateKey: browser.privateKey, peerPublicKey: client.publicKey, challenge: 'agent fixture handshake' });
    const clientKeys = agentKeys({ privateKey: client.privateKey, peerPublicKey: browser.publicKey, challenge: 'agent fixture handshake' });
    const frame = sealPayload(clientKeys.client, id, 0, { action: 'snapshot' });
    expect(openPayload(browserKeys.client, frame, id, 0)).toEqual({ action: 'snapshot' });
    expect(() => openPayload(browserKeys.client, frame, id, 1)).toThrow();
    expect(() => openPayload(browserKeys.browser, frame, id, 0)).toThrow();
  });
});
