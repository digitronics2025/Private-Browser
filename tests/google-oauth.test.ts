import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountStore, type SafeStorageAdapter } from '../electron/account-store';
import { ExternalBrowserLauncher } from '../electron/external-browser';
import { GoogleConfigurationStore } from '../electron/google-config';
import { fetchValidatedGoogleAvatar, GoogleOAuthManager, type GoogleOAuthClient } from '../electron/google-oauth';
import { GOOGLE_SCOPE_BY_MODULE, scopesForModules } from '../electron/google-scopes';
import { createPkceMaterial, OAuthLoopbackReceiver } from '../electron/oauth-loopback';
import type { AccountSpaceId } from '../electron/types';

class TestEncryption implements SafeStorageAdapter {
  isEncryptionAvailable(): boolean { return true; }
  encryptString(value: string): Buffer { return Buffer.from(value).reverse(); }
  decryptString(value: Buffer): string { return Buffer.from(value).reverse().toString(); }
}

class FakeReceiver extends OAuthLoopbackReceiver {
  cancelled = false;
  override async start(): Promise<string> { return 'http://127.0.0.1:49152/oauth/callback/fixed'; }
  override async wait(): Promise<{ code: string }> { return { code: 'authorization-code-memory-only' }; }
  override cancel(): void { this.cancelled = true; }
}

class FakeLauncher extends ExternalBrowserLauncher {
  launched?: string;
  override launch(_browserId: 'edge' | 'chrome' | 'firefox', authorizationUrl: string): void { this.launched = authorizationUrl; }
}

const ACCOUNT_ID = '122b503d-a1b3-497a-a610-e193af8d0702' as AccountSpaceId;
const CLIENT_ID = `${'1'.repeat(40)}.apps.googleusercontent.com`;

function oauthFixture(payloadPatch: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'google-oauth-'));
  const encryption = new TestEncryption();
  const accounts = new AccountStore(join(root, 'accounts'), encryption, () => new Date('2026-09-12T10:00:00Z'));
  accounts.createLocal({ id: ACCOUNT_ID, workspaceId: 'personal', label: 'Personal', color: 'emerald', order: 0 });
  const configuration = new GoogleConfigurationStore(join(root, 'google.enc'), encryption, CLIENT_ID);
  const launcher = new FakeLauncher();
  let authorizationOptions: Record<string, unknown> = {};
  const client: GoogleOAuthClient = {
    generateAuthUrl: (options) => {
      authorizationOptions = options;
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(String(options.state))}`;
    },
    getToken: vi.fn(async () => ({ tokens: {
      access_token: 'access-memory-only',
      refresh_token: 'refresh-encrypted-only',
      id_token: 'signed-id-token-memory-only',
      expiry_date: Date.parse('2026-09-12T11:00:00Z'),
      scope: scopesForModules(['identity', 'gmail-metadata']).join(' '),
    } })),
    verifyIdToken: vi.fn(async () => ({ getPayload: () => ({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      exp: Math.floor(Date.parse('2026-09-12T11:00:00Z') / 1000),
      nonce: String(authorizationOptions.nonce),
      sub: 'stable-google-subject',
      email: 'person@example.test',
      email_verified: true,
      name: 'Private Person',
      ...payloadPatch,
    }) })),
  };
  const receiver = new FakeReceiver();
  const manager = new GoogleOAuthManager(
    configuration,
    accounts,
    launcher,
    () => client,
    () => receiver,
    fetch,
    () => new Date('2026-09-12T10:00:00Z'),
  );
  return { root, accounts, launcher, client, receiver, manager, getAuthorizationOptions: () => authorizationOptions };
}

describe('secure Google desktop OAuth', () => {
  it('generates RFC 7636 S256 material with independent state and nonce', () => {
    const first = createPkceMaterial();
    const second = createPkceMaterial();
    expect(first.verifier.length).toBeGreaterThanOrEqual(43);
    expect(first.verifier.length).toBeLessThanOrEqual(128);
    expect(first.challenge).toBe(createHash('sha256').update(first.verifier, 'ascii').digest('base64url'));
    expect(first.state).not.toBe(first.nonce);
    expect(first).not.toEqual(second);
  });

  it('binds the callback to exact loopback host, port, path and one-time state', async () => {
    const receiver = new OAuthLoopbackReceiver();
    const redirect = await receiver.start('expected-state', 2_000);
    const response = await fetch(`${redirect}?state=expected-state&code=short-lived-code`);
    expect(response.status).toBe(200);
    await expect(receiver.wait()).resolves.toEqual({ code: 'short-lived-code' });
    await expect(fetch(`${redirect}?state=expected-state&code=replay`)).rejects.toThrow();
  });

  it('rejects a callback with the wrong state and closes the listener', async () => {
    const receiver = new OAuthLoopbackReceiver();
    const redirect = await receiver.start('expected-state', 2_000);
    const waiting = receiver.wait();
    expect((await fetch(`${redirect}?state=wrong&code=code`)).status).toBe(400);
    await expect(waiting).rejects.toThrow(/state/);
    await expect(fetch(`${redirect}?state=expected-state&code=late`)).rejects.toThrow();
  });

  it('cancels and times out loopback authorization without leaving a listener open', async () => {
    const cancelled = new OAuthLoopbackReceiver();
    const cancelledRedirect = await cancelled.start('state', 2_000);
    const cancelledWait = cancelled.wait();
    cancelled.cancel();
    await expect(cancelledWait).rejects.toThrow(/cancelled/);
    await expect(fetch(`${cancelledRedirect}?state=state&code=late`)).rejects.toThrow();

    const timedOut = new OAuthLoopbackReceiver();
    const timeoutRedirect = await timedOut.start('state', 20);
    await expect(timedOut.wait()).rejects.toThrow(/timed out/);
    await expect(fetch(`${timeoutRedirect}?state=state&code=late`)).rejects.toThrow();
  });

  it('requests the complete selected scope set and persists only a verified encrypted grant', async () => {
    const fixture = oauthFixture();
    const result = await fixture.manager.connect(ACCOUNT_ID, ['gmail-metadata'], 'edge', [ACCOUNT_ID]);
    expect(result.ok).toBe(true);
    expect(fixture.launcher.launched).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/);
    expect(fixture.getAuthorizationOptions()).toMatchObject({
      access_type: 'offline',
      include_granted_scopes: false,
      code_challenge_method: 'S256',
      scope: scopesForModules(['identity', 'gmail-metadata']),
    });
    expect(fixture.getAuthorizationOptions()).not.toHaveProperty('client_secret');
    expect(fixture.accounts.require(ACCOUNT_ID)).toMatchObject({
      googleIdentity: { sub: 'stable-google-subject', email: 'person@example.test' },
      enabledModules: ['identity', 'gmail-metadata'],
      refreshToken: 'refresh-encrypted-only',
    });
    expect(readFileSync(join(fixture.root, 'accounts', `${ACCOUNT_ID}.account.enc`), 'utf8')).not.toContain('refresh-encrypted-only');
    expect(fixture.manager.readAccessToken(ACCOUNT_ID)?.value).toBe('access-memory-only');
    expect(result.data).not.toHaveProperty('refreshToken');
  });

  it('rejects nonce, issuer, audience, expiry, unverified email and partial scope grants', async () => {
    for (const patch of [
      { nonce: 'wrong' },
      { iss: 'https://issuer.example' },
      { aud: 'another-client' },
      { exp: 1 },
      { email_verified: false },
    ]) {
      const fixture = oauthFixture(patch);
      const result = await fixture.manager.connect(ACCOUNT_ID, ['gmail-metadata'], 'edge', [ACCOUNT_ID]);
      expect(result).toMatchObject({ ok: false, error: { code: 'GOOGLE_INVALID_RESPONSE' } });
    }
    const fixture = oauthFixture();
    const client = fixture.client.getToken as ReturnType<typeof vi.fn>;
    client.mockResolvedValueOnce({ tokens: { refresh_token: 'refresh-token', id_token: 'id-token', scope: 'openid email profile' } });
    const result = await fixture.manager.connect(ACCOUNT_ID, ['gmail-metadata'], 'edge', [ACCOUNT_ID]);
    expect(result).toMatchObject({ ok: false, error: { code: 'GOOGLE_SCOPE_MISSING' } });
  });

  it('never uses the OS default-handler route and launches only a discovered executable with shell false', () => {
    const root = mkdtempSync(join(tmpdir(), 'external-browser-'));
    const executable = join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    mkdirSync(join(root, 'Microsoft', 'Edge', 'Application'), { recursive: true });
    writeFileSync(executable, '', { flag: 'w' });
    const calls: unknown[][] = [];
    const unref = vi.fn();
    const launcher = new ExternalBrowserLauncher(
      { ProgramFiles: root },
      'win32',
      ((path, args, options) => { calls.push([path, args, options]); return { unref }; }),
    );
    launcher.launch('edge', 'https://accounts.google.com/o/oauth2/v2/auth?client_id=public');
    expect(calls).toEqual([[executable, ['https://accounts.google.com/o/oauth2/v2/auth?client_id=public'], { shell: false, detached: true, stdio: 'ignore' }]]);
    expect(unref).toHaveBeenCalledOnce();
    expect(() => launcher.launch('edge', 'https://attacker.example/')).toThrow(/non-Google/);
  });

  it('encrypts a configured client ID and never accepts a client secret field', () => {
    const root = mkdtempSync(join(tmpdir(), 'google-configuration-'));
    const path = join(root, 'google.enc');
    const store = new GoogleConfigurationStore(path, new TestEncryption(), undefined);
    expect(store.status()).toEqual({ configured: false });
    expect(store.configure(CLIENT_ID)).toMatchObject({ configured: true, source: 'encrypted-settings' });
    expect(readFileSync(path, 'utf8')).not.toContain(CLIENT_ID);
    expect(() => store.configure('client-secret-value')).toThrow(/Desktop OAuth client ID/);
  });

  it('uses the least-privilege module scope matrix', () => {
    expect(GOOGLE_SCOPE_BY_MODULE['gmail-metadata']).toEqual(['https://www.googleapis.com/auth/gmail.metadata']);
    expect(GOOGLE_SCOPE_BY_MODULE['gmail-read']).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(GOOGLE_SCOPE_BY_MODULE['drive-files']).toEqual(['https://www.googleapis.com/auth/drive.file']);
    expect(GOOGLE_SCOPE_BY_MODULE['drive-read']).toEqual(['https://www.googleapis.com/auth/drive.readonly']);
    expect(GOOGLE_SCOPE_BY_MODULE['calendar-write']).toEqual(['https://www.googleapis.com/auth/calendar.events.owned']);
    expect(GOOGLE_SCOPE_BY_MODULE['encrypted-backup']).toEqual(['https://www.googleapis.com/auth/drive.appdata']);
  });

  it('accepts only bounded image bytes from Google-hosted avatar URLs', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const request = vi.fn(async () => new Response(png, { status: 200, headers: { 'Content-Type': 'text/html' } }));
    await expect(fetchValidatedGoogleAvatar('https://lh3.googleusercontent.com/a/photo', request as typeof fetch)).resolves.toEqual({
      mimeType: 'image/png',
      bytesBase64: Buffer.from(png).toString('base64'),
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ hostname: 'lh3.googleusercontent.com' }), expect.objectContaining({ redirect: 'error' }));
    await expect(fetchValidatedGoogleAvatar('https://attacker.example/avatar.png', request as typeof fetch)).resolves.toBeUndefined();
    await expect(fetchValidatedGoogleAvatar('https://fakegoogleusercontent.com/avatar.png', request as typeof fetch)).resolves.toBeUndefined();
    await expect(fetchValidatedGoogleAvatar('https://lh3.googleusercontent.com/a/not-image', async () => new Response('not an image') as never)).resolves.toBeUndefined();
  });
});
