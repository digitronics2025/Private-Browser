import { describe, expect, it } from 'vitest';
import { authenticatorData, base64UrlDecode, createCredential, signAssertion } from '../electron/myvault/security/passkeys/authenticator';
import { validatePasskeyOrigin } from '../electron/myvault/security/passkeys/origin-rules';
import { canInstallPasskeyProvider, passkeyShimSource, PASSKEY_RELEASE_GATE } from '../electron/myvault/passkey-controller';

describe('portable MyVault passkey ceremony', () => {
  it('creates an immutable-compatible ES256 record and a verifiable assertion without mutating it', async () => {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const created = await createCredential({ rpId: 'login.example.test', rpName: 'Example', origin: 'https://login.example.test', challenge, userHandle: Uint8Array.of(1, 2, 3), userName: 'alice', userDisplayName: 'Alice' });
    expect(created.record).toMatchObject({ rpId: 'login.example.test', algorithm: -7, createdAtOrigin: 'https://login.example.test' });
    const before = JSON.stringify(created.record);
    const assertion = await signAssertion(created.record, challenge, 'https://login.example.test');
    expect(assertion.signature.byteLength).toBeGreaterThan(0);
    expect(JSON.stringify(created.record)).toBe(before);
    expect(base64UrlDecode(created.record.id)).toHaveLength(32);
  });

  it('binds authenticator data to the exact RP id', async () => {
    expect(Buffer.from(await authenticatorData('one.example', true)).subarray(0, 32)).not.toEqual(Buffer.from(await authenticatorData('two.example', true)).subarray(0, 32));
  });
});

describe('Electron passkey release gate and origin policy', () => {
  it('refuses iframe, opaque, insecure, and non-exact RP contexts', () => {
    expect(validatePasskeyOrigin({ origin: 'null', topOrigin: 'null', frameId: 'main', isMainFrame: true })).toMatchObject({ allowed: false, reason: 'opaque-origin' });
    expect(validatePasskeyOrigin({ origin: 'https://example.test', topOrigin: 'https://example.test', frameId: 'child', isMainFrame: false })).toMatchObject({ allowed: false, reason: 'cross-origin-frame' });
    expect(validatePasskeyOrigin({ origin: 'http://example.test', topOrigin: 'http://example.test', frameId: 'main', isMainFrame: true })).toMatchObject({ allowed: false, reason: 'insecure-origin' });
    expect(validatePasskeyOrigin({ origin: 'https://login.example.test', topOrigin: 'https://login.example.test', frameId: 'main', isMainFrame: true, rpId: 'example.test' })).toMatchObject({ allowed: false, reason: 'rp-id-needs-psl' });
    expect(validatePasskeyOrigin({ origin: 'https://login.example.test', topOrigin: 'https://login.example.test', frameId: 'main', isMainFrame: true })).toMatchObject({ allowed: true, rpId: 'login.example.test' });
  });

  it('keeps the provider disabled under all opt-ins until the real Electron gate exists', () => {
    expect(PASSKEY_RELEASE_GATE.enabled).toBe(false);
    expect(canInstallPasskeyProvider('personal', 'https://example.test', { global: true, workspaces: { personal: true }, sites: { 'https://example.test': true } }, false)).toBe(false);
  });

  it('preserves original OS WebAuthn calls for fallthrough, errors, and unsupported requests', () => {
    const shim = passkeyShimSource('__binding');
    expect(shim).toContain('originalCreate(options)');
    expect(shim).toContain('originalGet(options)');
    expect(shim).toContain("event.source !== window");
    expect(shim).not.toContain('window.privateBrowser');
  });
});
