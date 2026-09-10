import { describe, expect, it } from 'vitest';
import { isAllowedRemoteUrl, isAutofillTarget, isProtectedPage, isSafeAiEndpoint, isSafeUpdateEndpoint, normalizeNavigationInput, redactSensitiveText, urlOriginForSharing } from '../electron/security';
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

  it('protects Moroccan banks that the first keyword list missed', () => {
    // Each of these was reported unprotected in the 2026-09-10 audit (F-08).
    expect(isProtectedPage('https://cfgbank.com/login')).toBe(true);
    expect(isProtectedPage('https://www.sgmaroc.com/particuliers')).toBe(true);
    expect(isProtectedPage('https://www.creditagricole.ma')).toBe(true);
    expect(isProtectedPage('https://www.attijariwafabank.com/fr')).toBe(true);
    expect(isProtectedPage('https://www.bankofafrica.ma')).toBe(true);
    expect(isProtectedPage('https://cih.ma/espace-client')).toBe(true);
  });

  it('does not treat ordinary words as banking', () => {
    // Over-protection is the safe direction, but not so broad it refuses everything.
    expect(isProtectedPage('https://otherwise.org/article')).toBe(false);
    expect(isProtectedPage('https://credits.example.com/roll')).toBe(false);
    expect(isProtectedPage('https://architecture.example/gallery')).toBe(false);
    expect(isProtectedPage('https://digitronics.ma/televisions')).toBe(false);
  });

  it('allows only public HTTPS AI endpoints', () => {
    expect(isSafeAiEndpoint('https://openrouter.ai/api/v1')).toBe(true);
    expect(isSafeAiEndpoint('http://openrouter.ai/api/v1')).toBe(false);
    expect(isSafeAiEndpoint('https://127.0.0.1/api')).toBe(false);
    expect(isSafeAiEndpoint('https://192.168.1.5/api')).toBe(false);
    expect(isSafeAiEndpoint('https://169.254.169.254/latest')).toBe(false);
    expect(isSafeAiEndpoint('https://[::1]/api')).toBe(false);
  });

  it('accepts only a public HTTPS origin for the update service', () => {
    expect(isSafeUpdateEndpoint('https://downloads.example.com')).toBe(true);
    expect(isSafeUpdateEndpoint('https://downloads.example.com/tenant')).toBe(false);
    expect(isSafeUpdateEndpoint('http://downloads.example.com')).toBe(false);
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

describe('autofill targeting', () => {
  it('fills only an exact hostname and port match', () => {
    expect(isAutofillTarget('https://bank.example/login', 'https://bank.example/account')).toBe(true);
    expect(isAutofillTarget('https://bank.example/', 'https://evil.example/')).toBe(false);
    expect(isAutofillTarget('https://bank.example/', 'https://login.bank.example/')).toBe(false);
    expect(isAutofillTarget('https://bank.example/', 'https://bank.example:8443/')).toBe(false);
  });

  it('never fills an https credential into an http page', () => {
    expect(isAutofillTarget('https://bank.example/', 'http://bank.example/')).toBe(false);
  });

  it('allows filling a page that is more secure than the saved credential', () => {
    expect(isAutofillTarget('http://tool.example/', 'https://tool.example/')).toBe(true);
    expect(isAutofillTarget('http://tool.example/', 'http://tool.example/')).toBe(true);
  });

  it('refuses anything that is not an ordinary web page', () => {
    expect(isAutofillTarget('file:///etc/passwd', 'file:///etc/passwd')).toBe(false);
    expect(isAutofillTarget('https://bank.example/', 'not a url')).toBe(false);
  });
});
