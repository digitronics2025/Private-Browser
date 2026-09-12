import { describe, expect, it } from 'vitest';
import { aiSourceRevision, classifyAiSource, maySendAiPreviewToCloud, sameAiSource } from '../electron/ai-account-spaces';
import type { AccountSpaceId, AiPagePreview, BrowserTab } from '../electron/types';

const A = '122b503d-a1b3-497a-a610-e193af8d0702' as AccountSpaceId;
const B = '78897bec-ecc1-40d3-b67e-95cdf4244284' as AccountSpaceId;
const tab = { id: 'tab-a', url: 'https://example.com/private?token=hidden', title: 'Example' } as BrowserTab;

function preview(): AiPagePreview {
  return { id: 'preview', accountSpaceId: A, tabId: tab.id, service: 'browser', sourceRevision: aiSourceRevision(A, tab, 'safe'), sourceUrl: tab.url, title: tab.title, url: 'https://example.com', text: 'safe', redactions: 1, protectedPage: false };
}

describe('AI Account Space capabilities', () => {
  it('binds source revisions to account, tab, URL, title and sanitized text', () => {
    expect(aiSourceRevision(A, tab, 'safe')).not.toBe(aiSourceRevision(B, tab, 'safe'));
    expect(aiSourceRevision(A, tab, 'safe')).not.toBe(aiSourceRevision(A, { ...tab, id: 'tab-b' }, 'safe'));
    expect(aiSourceRevision(A, tab, 'safe')).not.toBe(aiSourceRevision(A, tab, 'changed'));
  });

  it('invalidates capabilities after an account, tab or URL change', () => {
    const value = preview();
    expect(sameAiSource(value, A, tab)).toBe(true);
    expect(sameAiSource(value, B, tab)).toBe(false);
    expect(sameAiSource(value, A, { ...tab, url: 'https://example.com/next' })).toBe(false);
  });

  it('classifies Google services and refuses mailbox model input', () => {
    expect(classifyAiSource('https://mail.google.com/mail/u/0/')).toBe('gmail');
    expect(classifyAiSource('https://docs.google.com/document/d/1')).toBe('drive');
    expect(maySendAiPreviewToCloud({ ...preview(), service: 'gmail' })).toBe(false);
    expect(maySendAiPreviewToCloud(preview())).toBe(true);
  });
});
