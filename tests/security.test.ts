import { describe, expect, it } from 'vitest';
import { isAllowedRemoteUrl, isProtectedPage, isSafeAiEndpoint, normalizeNavigationInput, redactSensitiveText, urlOriginForSharing } from '../electron/security';
import { createDefaultState, sanitizeState } from '../electron/state-store';
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

  it('rejects credentials embedded in URLs', () => {
    expect(() => normalizeNavigationInput('https://user:password@example.com')).toThrow(/credentials/);
    expect(isAllowedRemoteUrl('https://user:password@example.com')).toBe(false);
  });

  it('protects banking and payment pages', () => {
    expect(isProtectedPage('https://secure.bank.example/login')).toBe(true);
    expect(isProtectedPage('https://shop.example/checkout')).toBe(true);
    expect(isProtectedPage('https://digitronics.ma')).toBe(false);
  });

  it('allows only public HTTPS AI endpoints', () => {
    expect(isSafeAiEndpoint('https://openrouter.ai/api/v1')).toBe(true);
    expect(isSafeAiEndpoint('http://openrouter.ai/api/v1')).toBe(false);
    expect(isSafeAiEndpoint('https://127.0.0.1/api')).toBe(false);
    expect(isSafeAiEndpoint('https://192.168.1.5/api')).toBe(false);
    expect(isSafeAiEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isSafeAiEndpoint('https://[::1]/api')).toBe(false);
  });

  it('shares only an origin with a cloud provider', () => {
    expect(urlOriginForSharing('https://example.com/reset?token=secret#step')).toBe('https://example.com');
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

  it('repairs missing and unsafe persisted tabs', () => {
    const state = createDefaultState();
    state.tabs = [{ id: 'bad', workspaceId: 'digitronics', title: 'Unsafe', url: 'file:///etc/passwd', isHome: false }];
    state.activeTabByWorkspace = { digitronics: 'missing' };
    const repaired = sanitizeState(state);
    expect(repaired.tabs).toHaveLength(5);
    expect(repaired.tabs.every((tab) => tab.url === 'private://home')).toBe(true);
    expect(repaired.activeTabByWorkspace.digitronics).toBeTruthy();
  });

  it('generates RFC 6238-compatible TOTP values', () => {
    expect(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59)).toBe('287082');
  });
});
