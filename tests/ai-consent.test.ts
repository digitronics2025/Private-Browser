import { describe, expect, it } from 'vitest';
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
