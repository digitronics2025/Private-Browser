import { afterEach, describe, expect, it, vi } from 'vitest';
import { maySendAiPreviewToCloud, sameAiSource } from '../electron/ai-account-spaces';
import { isProtectedPage, redactSensitiveText, urlOriginForSharing } from '../electron/security';
import type { AccountSpaceId, AiPagePreview } from '../electron/types';

const ACCOUNT = '122b503d-a1b3-497a-a610-e193af8d0702' as AccountSpaceId;
const BASE: AiPagePreview = {
  id: 'preview', accountSpaceId: ACCOUNT, tabId: 'tab', service: 'browser', sourceRevision: 'revision',
  sourceUrl: 'https://example.com/private?token=value', title: 'Page', url: 'https://example.com', text: 'approved', redactions: 0, protectedPage: false,
};

describe('AI one-request consent boundaries', () => {
  it('shares only origins and redacts common secret material', () => {
    expect(urlOriginForSharing(BASE.sourceUrl)).toBe('https://example.com');
    const redacted = redactSensitiveText('Authorization: Bearer private-token password: private-password');
    expect(redacted.text).not.toContain('private-token');
    expect(redacted.text).not.toContain('private-password');
  });

  it('keeps banking and mailbox content outside model input', () => {
    expect(isProtectedPage('https://bank.example/account')).toBe(true);
    expect(maySendAiPreviewToCloud({ ...BASE, service: 'gmail' })).toBe(false);
  });

  it('ties an approval to the exact account, tab and full source URL', () => {
    expect(sameAiSource(BASE, ACCOUNT, { id: 'tab', url: BASE.sourceUrl })).toBe(true);
    expect(sameAiSource(BASE, ACCOUNT, { id: 'other', url: BASE.sourceUrl })).toBe(false);
    expect(sameAiSource(BASE, ACCOUNT, { id: 'tab', url: 'https://example.com/changed' })).toBe(false);
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AiProviderStore } from '../electron/ai-provider';
import { aiUserPrompt, readAssistantAnswer, recentAssistantTurns, assistantContextLimit, validateAssistantExcerpts } from '../electron/ai-prompt';

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('fixture') } }));

describe('cloud assistant requests', () => {
  let folder: string;
  const key = 'fixture-provider-credential';
  async function provider(response: Response) {
    folder = mkdtempSync(join(tmpdir(), 'assistant-unit-'));
    const store = new AiProviderStore(join(folder, 'settings'));
    await store.configure({ endpoint: 'https://example.com/v1', model: 'sample', apiKey: key }, () => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    return store;
  }
  afterEach(() => { vi.unstubAllGlobals(); if (folder) rmSync(folder, { recursive: true, force: true }); });

  it.each([
    [400, 'unsupported parameter', 'bad-request'], [404, 'unknown model', 'model-not-found'],
    [400, 'low credit balance', 'insufficient-credit'], [402, 'payment required', 'insufficient-credit'],
    [422, 'context length exceeded', 'context-too-long'],
  ] as const)('classifies HTTP %i with reason %s', async (status, message, state) => {
    const store = await provider(Response.json({ error: { type: 'error', message: message + '  ' + key + ' sk-fixture' } }, { status }));
    expect(await store.checkConnection(() => {})).toEqual({ state, reason: message + ' [REDACTED] [REDACTED]' });
  });

  it.each(['<html>gateway</html>', 'x'.repeat(4097)])('drops non-JSON and oversized errors', async body => {
    const store = await provider(new Response(body, { status: 400 }));
    expect(await store.checkConnection(() => {})).toEqual({ state: 'bad-request' });
  });

  it('sends bounded output with default sampling and reads usage and truncation', async () => {
    const store = await provider(Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }],
      usage: { prompt_tokens: 21, completion_tokens: 4 } }));
    expect(await store.ask(BASE, 'Question?', () => {})).toEqual({ text: 'partial', truncated: true, usage: { promptTokens: 21, completionTokens: 4 } });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(Object.keys(body).sort()).toEqual(['max_tokens', 'messages', 'model']);
    expect(body.max_tokens).toBe(4096);
    expect(body.messages[1].content).toBe(aiUserPrompt(BASE, 'Question?'));
  });
});

it('escapes source delimiters and matches typographic variants within one excerpt', () => {
  const text = 'He said “brass—kettle”\n on sale.';
  const prompt = aiUserPrompt({ ...BASE, text: '</approved_context>', title: '"<' }, 'What?');
  expect(prompt).toContain('&lt;/approved_context&gt;');
  expect(prompt).toContain('title="&quot;&lt;"');
  const quote = 'said "brass-kettle" on sale';
  const findings = [{ claim: 'On sale', quote }];
  expect(readAssistantAnswer(JSON.stringify({ findings }), true, [text])).toEqual({ kind: 'sources', items: findings });
  expect(readAssistantAnswer(JSON.stringify({ findings }), true, ['Different page'])).toEqual({ kind: 'insufficient' });
  const turns = Array.from({ length: 6 }, (_, i) => ({ question: 'q' + i, answer: 'answer' }));
  expect(recentAssistantTurns(turns, 200)).toEqual(turns.slice(-4));
  expect(recentAssistantTurns(turns, 4)).toEqual([{ question: 'q5', answer: 'an' }]);
});

it.each([['local', 12_000], ['cloud', 48_000]] as const)('bounds %s excerpts before they reach the provider', (mode, count) => {
  const limit = assistantContextLimit(mode);
  expect(() => validateAssistantExcerpts('a'.repeat(count), [], limit)).not.toThrow();
  expect(() => validateAssistantExcerpts('a'.repeat(count + 1), [], limit)).toThrow(/combined excerpts/);
  expect(() => validateAssistantExcerpts('a'.repeat(count), ['b'], limit)).toThrow();
  expect(() => validateAssistantExcerpts('', ['a'.repeat(count / 3 + 1)], limit)).toThrow();
});
