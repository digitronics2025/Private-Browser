import { describe, expect, it } from 'vitest';
import { AGENT_ACTIONS_PER_MINUTE } from '@private-browser/bridge-protocol/agent';
import { AgentConfirmation, AgentRateLimit, agentAccess, agentUrl, consequentialAction, DEFAULT_AGENT_POLICY, exactAgentOrigin } from '../electron/agent-policy';

describe('Agent permissions', () => {
  it('keeps profiles and exact origins separate', () => {
    expect(agentAccess(DEFAULT_AGENT_POLICY, agentUrl('http://localhost:8080'))).toBe('drive');
    expect(agentAccess(DEFAULT_AGENT_POLICY, agentUrl('https://localhost.example.test'))).toBe('observe');
    const origins = ['https://dev.example.test:3000'];
    expect(agentAccess({ ...DEFAULT_AGENT_POLICY, profile: 'observe', origins, outside: 'deny' }, agentUrl(origins[0]))).toBe('observe');
    const operate = { ...DEFAULT_AGENT_POLICY, profile: 'operate', origins, outside: 'deny' } as const;
    expect(agentAccess(operate, agentUrl(origins[0]))).toBe('drive');
    expect(agentAccess(operate, agentUrl('https://dev.example.test:3001'))).toBe('deny');
    expect(() => exactAgentOrigin('https://dev.example.test/app')).toThrow();
  });

  it.each([
    'file:///C:/Windows', 'chrome://settings', 'devtools://devtools', 'data:text/plain,fixture',
    'javascript:void(0)', 'private://home', 'https://www.cihbank.ma',
    'https://user:fake@example.test', // secret-guard:allow — synthetic credentials in a URL used to test rejection.
    'https://shop.example.test/%63heckout', 'https://accounts.google.com/', 'https://myvault.digitronics-electro.workers.dev/',
  ])('blocks %s before it can be loaded', (url) => { expect(() => agentUrl(url)).toThrow(); });

  it('covers multilingual labels, form writes and new origins', () => {
    const url = agentUrl('http://localhost:3000');
    for (const name of ['Delete item', 'Transférer le montant', 'تأكيد الطلب', 'تَحْوِيل']) {
      expect(consequentialAction('click', url, { name, nearby: '' })).toBe(true);
    }
    expect(consequentialAction('click', url, { name: 'Continue', nearby: '', submit: true, formMethod: 'post' })).toBe(true);
    expect(consequentialAction('click', url, { name: 'Open menu', nearby: '' })).toBe(false);
    expect(consequentialAction('navigate', url, undefined, agentUrl('http://localhost:3001'))).toBe(true);
  });

  it('makes confirmation single-use, expiring and bound to exact input and revision', () => {
    const context = { session: 'session', tab: 'tab', url: 'http://localhost:3000', revision: 'document:1', method: 'click', input: { ref: 'e1' } } as const;
    const approved = new AgentConfirmation(context, 100);
    expect(approved.spend(context, 800)).toBe(true);
    expect(approved.spend(context, 801)).toBe(false);
    expect(new AgentConfirmation(context, 100).spend(context, 125_000)).toBe(false);
    expect(new AgentConfirmation(context, 100).spend({ ...context, revision: 'document:2' }, 101)).toBe(false);
    expect(new AgentConfirmation(context, 100).spend({ ...context, input: { ref: 'e2' } } as unknown as typeof context, 101)).toBe(false);
  });

  it('limits actions in a sliding minute', () => {
    const limiter = new AgentRateLimit();
    for (let index = 0; index < AGENT_ACTIONS_PER_MINUTE; index += 1) limiter.take(100);
    expect(() => limiter.take(59_999)).toThrow();
    expect(() => limiter.take(60_100)).not.toThrow();
  });
});
