import { describe, expect, it } from 'vitest';
import { downloadRisk, isAllowedRemoteUrl, isAllowedSitePermission, isAutofillTarget, isProtectedPage, isSafeAiEndpoint, isSafeUpdateEndpoint, navigationWarning, normalizeNavigationInput, parseWebAddress, redactSensitiveText, stripTrackingParameters, urlOriginForSharing } from '../electron/security';
import { isSameSiteFillCandidate, registrableSite } from '../electron/myvault/site-match';
import { createDefaultState, sanitizeState } from '../electron/state-store';
import { generateTotp } from '../electron/vault';

describe('navigation security', () => {
  it('adds HTTPS to domains', () => {
    expect(normalizeNavigationInput('digitronics.ma')).toBe('https://digitronics.ma/');
  });

  it('turns plain text into a private search', () => {
    expect(normalizeNavigationInput('best television morocco')).toBe('https://duckduckgo.com/?q=best%20television%20morocco');
  });

  it('searches the chosen engine and escapes the query into its template', () => {
    expect(normalizeNavigationInput('best television morocco', 'https://www.google.com/search?q=%s')).toBe('https://www.google.com/search?q=best%20television%20morocco');
    expect(normalizeNavigationInput('a&b=c #x $&', 'https://www.google.com/search?q=%s')).toBe('https://www.google.com/search?q=a%26b%3Dc%20%23x%20%24%26');
    expect(normalizeNavigationInput('tv', 'https://example.com/s/%s?src=pb')).toBe('https://example.com/s/tv?src=pb');
    expect(normalizeNavigationInput('tenten.ma', 'https://www.google.com/search?q=%s')).toBe('https://tenten.ma/');
    expect(normalizeNavigationInput('   ', 'https://www.google.com/search?q=%s')).toBe('private://home');
  });

  it('tells a web address apart from a search', () => {
    expect(parseWebAddress('tenten.ma')).toBe('https://tenten.ma/');
    expect(parseWebAddress(' https://example.com/?utm_source=x&id=1 ')).toBe('https://example.com/?id=1');
    expect(parseWebAddress('localhost:4317')).toBe('http://localhost:4317');
    expect(parseWebAddress('weather')).toBeUndefined();
    expect(parseWebAddress('file:///C:/Windows')).toBeUndefined();
    expect(parseWebAddress('javascript:alert(1)')).toBeUndefined();
    expect(() => parseWebAddress('https://user:password@example.com')).toThrow(/credentials/); // secret-guard:allow
  });

  it('rejects privileged protocols', () => {
    expect(isAllowedRemoteUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedRemoteUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedRemoteUrl('https://example.com')).toBe(true);
  });

  it('rejects credentials embedded in URLs', () => {
    expect(() => normalizeNavigationInput('https://user:password@example.com')).toThrow(/credentials/); // secret-guard:allow
    expect(isAllowedRemoteUrl('https://user:password@example.com')).toBe(false); // secret-guard:allow
  });

  it('removes common tracking identifiers without changing useful parameters', () => {
    expect(stripTrackingParameters('https://example.com/item?id=7&utm_source=mail&fbclid=abc#details')).toBe('https://example.com/item?id=7#details');
    expect(normalizeNavigationInput('https://example.com/?gclid=abc&q=tv')).toBe('https://example.com/?q=tv');
  });

  it('warns about cleartext and internationalized look-alike domains', () => {
    expect(navigationWarning('http://example.com')).toBe('insecure');
    expect(navigationWarning('http://localhost:5173')).toBeUndefined();
    expect(navigationWarning('https://xn--80ak6aa92e.com')).toBe('idn');
    expect(navigationWarning('https://digitronics.ma')).toBeUndefined();
  });

  it('allows only narrow, secure, top-frame permissions outside Banking', () => {
    expect(isAllowedSitePermission('fullscreen', 'https://video.example/watch', false, true)).toBe(true);
    expect(isAllowedSitePermission('clipboard-sanitized-write', 'http://localhost:5173', false, true)).toBe(true);
    expect(isAllowedSitePermission('media', 'https://video.example/watch', false, true)).toBe(false);
    expect(isAllowedSitePermission('fullscreen', 'http://example.com', false, true)).toBe(false);
    expect(isAllowedSitePermission('fullscreen', 'https://video.example/watch', true, true)).toBe(false);
    expect(isAllowedSitePermission('fullscreen', 'https://video.example/watch', false, false)).toBe(false);
  });

  it('classifies executable and deceptive downloads', () => {
    expect(downloadRisk('invoice.pdf.exe')).toBe('deceptive');
    expect(downloadRisk('installer.msi')).toBe('dangerous');
    expect(downloadRisk('report.pdf')).toBe('ordinary');
    // F-32: types Windows runs or mounts that a denylist missed are never "ordinary".
    for (const name of ['app.msix', 'update.appinstaller', 'disk.vhdx', 'disk.vhd', 'link.url', 'app.application', 'x.appref-ms', 'x.wsh', 'x.msc', 'x.diagcab', 'x.settingcontent-ms', 'x.library-ms', 'setup.exe.', 'setup.exe ', 'README']) {
      expect(downloadRisk(name), name).not.toBe('ordinary');
    }
    for (const name of ['photo.JPG', 'archive.zip', 'notes.txt', 'sheet.xlsx', 'clip.mp4']) expect(downloadRisk(name), name).toBe('ordinary');
    expect(downloadRisk('invoice.pdf.msix')).toBe('deceptive');
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

  it('rejects the loopback spellings the first guard missed', () => {
    // All three were confirmed to slip through in the 2026-09-10 audit (F-19).
    expect(isSafeAiEndpoint('https://[::]/api')).toBe(false);
    expect(isSafeAiEndpoint('https://[::ffff:127.0.0.1]/api')).toBe(false);
    expect(isSafeAiEndpoint('https://localhost./api')).toBe(false);
    // A trailing dot must not defeat the private-range checks either.
    expect(isSafeAiEndpoint('https://192.168.1.5./api')).toBe(false);
    // And a public host is still allowed.
    expect(isSafeAiEndpoint('https://api.openai.com/v1')).toBe(true);
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
    // Without this, a redactor that returned an empty string would pass every
    // assertion above. Ordinary text must survive (audit finding F-23).
    expect(result.text).toContain('card');
    expect(result.text.length).toBeGreaterThan(20);
  });
});

describe('local data', () => {
  it('creates one isolated home tab per workspace', () => {
    const state = createDefaultState();
    expect(state.tabs).toHaveLength(5);
    expect(new Set(state.tabs.map((tab) => tab.workspaceId)).size).toBe(5);
    expect(state.trackerBlocking).toBe(true);
    expect(state.bookmarkBarVisible).toBe(true);
  });

  it('upgrades legacy flat bookmarks into bookmark-bar entries', () => {
    const state = createDefaultState();
    state.bookmarks = [{ id: 'legacy', title: 'Legacy', url: 'https://example.com', workspaceId: 'personal', createdAt: '2026-01-01T00:00:00.000Z' } as typeof state.bookmarks[number]];
    const repaired = sanitizeState(state);
    expect(repaired.bookmarks[0]).toEqual(expect.objectContaining({ location: 'bar', folderPath: [], orderPath: [0] }));
  });

  it('repairs missing and unsafe persisted tabs', () => {
    const state = createDefaultState();
    state.tabs = [{ id: 'bad', workspaceId: 'digitronics', title: 'Unsafe', url: 'file:///etc/passwd', isHome: false }];
    state.activeTabByWorkspace = { digitronics: 'missing' };
    const repaired = sanitizeState(state);
    expect(repaired.tabs).toHaveLength(5);
    expect(repaired.tabs.every((tab) => tab.url === 'private://home')).toBe(true);
    // toBeTruthy() passed for any string, including an id absent from the repaired
    // tabs — which is the exact bug this test is named for (audit finding F-23).
    const repairedIds = repaired.tabs.map((tab) => tab.id);
    expect(repairedIds).toContain(repaired.activeTabByWorkspace.digitronics);
    for (const workspace of ['digitronics', 'tenten', 'development', 'personal', 'banking'] as const) {
      const active = repaired.activeTabByWorkspace[workspace];
      expect(repairedIds).toContain(active);
      expect(repaired.tabs.find((tab) => tab.id === active)?.workspaceId).toBe(workspace);
    }
  });

  it('generates RFC 6238-compatible TOTP values', () => {
    expect(generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59)).toBe('287082');
  });
});

describe('same-site login picker candidates', () => {
  it('groups addresses of one site by registrable domain, as Chrome does', () => {
    expect(registrableSite('admin.digitronics.ma')).toBe('digitronics.ma');
    expect(isSameSiteFillCandidate('https://digitronics.ma/', 'https://admin.digitronics.ma/en/sign-in')).toBe(true);
    expect(isSameSiteFillCandidate('https://www.digitronics.ma/', 'https://digitronics.ma/')).toBe(true);
    expect(isSameSiteFillCandidate('https://digitronics.ma/', 'https://digitronics.ma:443/')).toBe(true);
  });

  it('keeps sites under a shared public suffix apart', () => {
    expect(isSameSiteFillCandidate('https://shop.co.ma/', 'https://evil.co.ma/')).toBe(false);
    expect(isSameSiteFillCandidate('https://a.co.uk/', 'https://b.co.uk/')).toBe(false);
    expect(isSameSiteFillCandidate('https://alice.github.io/', 'https://mallory.github.io/')).toBe(false);
    expect(isSameSiteFillCandidate('https://digitronics.ma/', 'https://digitronics.ma.evil.example/')).toBe(false);
  });

  it('requires the same effective port and never downgrades https to http', () => {
    expect(isSameSiteFillCandidate('https://digitronics.ma/', 'https://admin.digitronics.ma:8443/')).toBe(false);
    expect(isSameSiteFillCandidate('https://digitronics.ma/', 'http://admin.digitronics.ma/')).toBe(false);
    expect(isSameSiteFillCandidate('http://digitronics.ma/', 'https://admin.digitronics.ma/')).toBe(false);
  });

  it('matches IP addresses, localhost and punycode only exactly', () => {
    expect(registrableSite('127.0.0.1')).toBeUndefined();
    expect(registrableSite('localhost')).toBeUndefined();
    expect(registrableSite('xn--digitrnics-p7a.ma')).toBeUndefined();
    expect(isSameSiteFillCandidate('https://127.0.0.1/', 'https://127.0.0.1/')).toBe(true);
    expect(isSameSiteFillCandidate('https://a.localhost/', 'https://b.localhost/')).toBe(false);
    expect(isSameSiteFillCandidate('https://xn--digitrnics-p7a.ma/', 'https://www.xn--digitrnics-p7a.ma/')).toBe(false);
  });

  it('refuses non-web and credential-bearing addresses', () => {
    expect(isSameSiteFillCandidate('file:///C:/x', 'https://digitronics.ma/')).toBe(false);
    expect(isSameSiteFillCandidate('https://digitronics.ma/', 'https://user:pass@admin.digitronics.ma/')).toBe(false); // secret-guard:allow — inert URL, asserts refusal
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
