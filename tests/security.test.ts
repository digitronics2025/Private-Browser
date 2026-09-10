import { describe, expect, it } from 'vitest';
import { isAllowedRemoteUrl, isProtectedPage, normalizeNavigationInput, redactSensitiveText } from '../electron/security';
import { createDefaultState } from '../electron/state-store';
import { generateTotp } from '../electron/vault';

describe('navigation security', () => {
  it('adds HTTPS to domains', () => {
    expect(normalizeNavigationInput('digitronics.ma')).toBe('https://digitronics.ma/');
  });

  it('turns plain text into a private search', () => {
    expect(normalizeNavigationInput('best television morocco')).toBe('https://duckduckgo.com/?q=best%20television%20morocco');
  });

  it('rejects privileged protocols', () => {
    expect(isAllowedRemoteUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedRemoteUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedRemoteUrl('https://example.com')).toBe(true);
  });

  it('protects banking and payment pages', () => {
    expect(isProtectedPage('https://secure.bank.example/login')).toBe(true);
    expect(isProtectedPage('https://shop.example/checkout')).toBe(true);
    expect(isProtectedPage('https://digitronics.ma')).toBe(false);
  });
});

describe('AI redaction', () => {
  it('removes secrets and payment card patterns', () => {
    const input = 'password: hunter2 card 4242 4242 4242 4242 Authorization: Bearer abc123';
    const result = redactSensitiveText(input);
    expect(result.text).not.toContain('hunter2');
    expect(result.text).not.toContain('4242 4242');
    expect(result.text).not.toContain('abc123');
    expect(result.redactions).toBeGreaterThanOrEqual(3);
  });
});

describe('local data', () => {
  it('creates one isolated home tab per workspace', () => {
    const state = createDefaultState();
    expect(state.tabs).toHaveLength(5);
    expect(new Set(state.tabs.map((tab) => tab.workspaceId)).size).toBe(5);
    expect(state.trackerBlocking).toBe(true);
  });

  it('generates RFC 6238-compatible TOTP values', () => {
    expect(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59)).toBe('287082');
  });
});
