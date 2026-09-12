import { randomUUID } from 'node:crypto';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Credentials, GenerateAuthUrlOpts } from 'google-auth-library';
import type {
  AccountSpaceId,
  AccountSpaceSummary,
  ExternalBrowserId,
  GoogleModule,
  GoogleOperationResult,
} from './types.js';
import { AccountStore, type GoogleIdentityRecord, type StoredAvatar } from './account-store.js';
import { ExternalBrowserLauncher } from './external-browser.js';
import { GoogleConfigurationStore } from './google-config.js';
import { hasAllScopes, scopesForModules } from './google-scopes.js';
import { createPkceMaterial, OAuthLoopbackReceiver } from './oauth-loopback.js';

interface VerifiedPayload {
  iss?: string;
  aud?: string;
  exp?: number;
  nonce?: string;
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

export interface GoogleOAuthClient {
  generateAuthUrl(options: GenerateAuthUrlOpts): string;
  getToken(options: { code: string; codeVerifier: string; redirect_uri: string }): Promise<{ tokens: Credentials }>;
  verifyIdToken(options: { idToken: string; audience: string }): Promise<{ getPayload(): VerifiedPayload | undefined }>;
}

export type GoogleOAuthClientFactory = (clientId: string, redirectUri: string) => GoogleOAuthClient;
export type OAuthLoopbackFactory = () => OAuthLoopbackReceiver;

const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_AVATAR_BYTES = 512 * 1024;
type GoogleErrorCode = NonNullable<GoogleOperationResult['error']>['code'];

export class GoogleOAuthManager {
  private readonly operations = new Map<AccountSpaceId, OAuthLoopbackReceiver>();
  private readonly accessTokens = new Map<AccountSpaceId, { value: string; expiresAt: number }>();

  constructor(
    private readonly configuration: GoogleConfigurationStore,
    private readonly accounts: AccountStore,
    private readonly externalBrowsers = new ExternalBrowserLauncher(),
    private readonly createClient: GoogleOAuthClientFactory = defaultClientFactory,
    private readonly createReceiver: OAuthLoopbackFactory = () => new OAuthLoopbackReceiver(),
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async connect(
    accountSpaceId: AccountSpaceId,
    modules: GoogleModule[],
    browserId: ExternalBrowserId,
    allAccountIds: AccountSpaceId[],
  ): Promise<GoogleOperationResult<AccountSpaceSummary>> {
    const requestId = randomUUID();
    if (this.operations.has(accountSpaceId)) return failure('GOOGLE_INTERNAL', 'A Google connection is already in progress for this account', requestId);
    let receiver: OAuthLoopbackReceiver | undefined;
    try {
      const clientId = this.configuration.getClientId();
      const account = this.accounts.require(accountSpaceId);
      if (account.locked) return failure('GOOGLE_POLICY_DENIED', 'Unlock this Account Space before connecting Google', requestId);
      const selectedModules = [...new Set<GoogleModule>(['identity', ...modules])];
      const requiredScopes = scopesForModules(selectedModules);
      const pkce = createPkceMaterial();
      receiver = this.createReceiver();
      this.operations.set(accountSpaceId, receiver);
      const redirectUri = await receiver.start(pkce.state);
      const client = this.createClient(clientId, redirectUri);
      const authorizationUrl = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent select_account',
        include_granted_scopes: false,
        scope: requiredScopes,
        state: pkce.state,
        nonce: pkce.nonce,
        code_challenge: pkce.challenge,
        code_challenge_method: CodeChallengeMethod.S256,
        redirect_uri: redirectUri,
      });
      this.externalBrowsers.launch(browserId, authorizationUrl);
      const { code } = await receiver.wait();
      this.operations.delete(accountSpaceId);
      const { tokens } = await withTimeout(client.getToken({ code, codeVerifier: pkce.verifier, redirect_uri: redirectUri }), TOKEN_TIMEOUT_MS);
      if (!tokens.id_token) throw new OAuthFailure('GOOGLE_INVALID_RESPONSE', 'Google did not return an identity token');
      const ticket = await withTimeout(client.verifyIdToken({ idToken: tokens.id_token, audience: clientId }), TOKEN_TIMEOUT_MS);
      const payload = validateVerifiedPayload(ticket.getPayload(), clientId, pkce.nonce, this.now());
      const grantedScopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : [];
      if (!hasAllScopes(grantedScopes, requiredScopes)) {
        throw new OAuthFailure('GOOGLE_SCOPE_MISSING', 'Google did not grant every selected module scope');
      }
      const refreshToken = tokens.refresh_token ?? account.refreshToken;
      if (!refreshToken) throw new OAuthFailure('GOOGLE_RECONNECT_REQUIRED', 'Google did not return a refresh token; reconnect and approve access');
      const identity: GoogleIdentityRecord = {
        sub: payload.sub!,
        email: payload.email!,
        displayName: payload.name,
        emailVerified: true,
        avatar: await fetchValidatedGoogleAvatar(payload.picture, this.request),
      };
      const saved = this.accounts.saveGoogleGrant(accountSpaceId, identity, refreshToken, selectedModules, grantedScopes, allAccountIds);
      if (tokens.access_token) {
        this.accessTokens.set(accountSpaceId, { value: tokens.access_token, expiresAt: tokens.expiry_date ?? this.now().getTime() + 55 * 60_000 });
      }
      return { ok: true, data: this.accounts.toSummary(saved) };
    } catch (error) {
      receiver?.cancel();
      this.operations.delete(accountSpaceId);
      if (error instanceof OAuthFailure) return failure(error.code, error.message, requestId);
      if (error instanceof Error && error.message === 'Google integration needs configuration') {
        return failure('GOOGLE_CONFIGURATION_REQUIRED', error.message, requestId);
      }
      const message = error instanceof Error && /cancel|denied/i.test(error.message)
        ? 'Google authorization was cancelled'
        : 'Google authorization could not be completed';
      return failure(message.includes('cancelled') ? 'GOOGLE_CANCELLED' : 'GOOGLE_INTERNAL', message, requestId);
    }
  }

  cancel(accountSpaceId: AccountSpaceId): boolean {
    const receiver = this.operations.get(accountSpaceId);
    if (!receiver) return false;
    this.operations.delete(accountSpaceId);
    receiver.cancel();
    return true;
  }

  clearMemory(accountSpaceId: AccountSpaceId): void {
    this.cancel(accountSpaceId);
    this.accessTokens.delete(accountSpaceId);
  }

  readAccessToken(accountSpaceId: AccountSpaceId): { value: string; expiresAt: number } | undefined {
    const token = this.accessTokens.get(accountSpaceId);
    if (!token || token.expiresAt <= this.now().getTime()) {
      this.accessTokens.delete(accountSpaceId);
      return undefined;
    }
    return { ...token };
  }

  async disconnect(accountSpaceId: AccountSpaceId, revoke: boolean): Promise<GoogleOperationResult<AccountSpaceSummary>> {
    const requestId = randomUUID();
    this.clearMemory(accountSpaceId);
    const account = this.accounts.require(accountSpaceId);
    if (revoke && account.refreshToken) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
      try {
        const response = await this.request('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `token=${encodeURIComponent(account.refreshToken)}`,
          signal: controller.signal,
          redirect: 'error',
        });
        if (!response.ok) throw new Error('Google revocation failed');
      } catch {
        const pending = this.accounts.update(accountSpaceId, (record) => { record.googleConnection = 'revocation-pending'; });
        return failure('GOOGLE_OFFLINE', 'Revocation is pending; reconnect to the network and retry', requestId, this.accounts.toSummary(pending));
      } finally {
        clearTimeout(timeout);
      }
    }
    const disconnected = this.accounts.disconnectGoogle(accountSpaceId);
    return { ok: true, data: this.accounts.toSummary(disconnected) };
  }
}

export async function fetchValidatedGoogleAvatar(
  pictureUrl: string | undefined,
  request: typeof fetch = fetch,
): Promise<StoredAvatar | undefined> {
  if (!pictureUrl) return undefined;
  let url: URL;
  try { url = new URL(pictureUrl); } catch { return undefined; }
  if (url.protocol !== 'https:' || !(url.hostname === 'googleusercontent.com' || url.hostname.endsWith('.googleusercontent.com'))) return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  try {
    const response = await request(url, { method: 'GET', redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) return undefined;
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) return undefined;
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_AVATAR_BYTES) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const mimeType = detectAvatarMimeType(bytes);
    if (!mimeType) return undefined;
    return { mimeType, bytesBase64: bytes.toString('base64') };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function detectAvatarMimeType(bytes: Buffer): StoredAvatar['mimeType'] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}

export function validateVerifiedPayload(payload: VerifiedPayload | undefined, clientId: string, nonce: string, now: Date): VerifiedPayload {
  if (!payload
    || !GOOGLE_ISSUERS.has(payload.iss ?? '')
    || payload.aud !== clientId
    || typeof payload.exp !== 'number'
    || payload.exp * 1000 <= now.getTime()
    || payload.nonce !== nonce
    || typeof payload.sub !== 'string'
    || payload.sub.length === 0
    || payload.sub.length > 255
    || typeof payload.email !== 'string'
    || payload.email.length > 320
    || payload.email_verified !== true) {
    throw new OAuthFailure('GOOGLE_INVALID_RESPONSE', 'Google identity validation failed');
  }
  return payload;
}

function defaultClientFactory(clientId: string, redirectUri: string): GoogleOAuthClient {
  const client = new OAuth2Client({ clientId, redirectUri });
  return {
    generateAuthUrl: (options) => client.generateAuthUrl(options),
    getToken: (options) => client.getToken(options),
    verifyIdToken: (options) => client.verifyIdToken(options),
  };
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new OAuthFailure('GOOGLE_OFFLINE', 'Google did not respond before the secure timeout')), timeoutMs);
    timer.unref();
  });
  try { return await Promise.race([operation, timeout]); } finally { if (timer) clearTimeout(timer); }
}

class OAuthFailure extends Error {
  constructor(readonly code: GoogleErrorCode, message: string) {
    super(message);
  }
}

function failure<T>(
  code: NonNullable<GoogleOperationResult['error']>['code'],
  message: string,
  requestId: string,
  data?: T,
): GoogleOperationResult<T> {
  return { ok: false, data, error: { code, message, requestId } };
}
