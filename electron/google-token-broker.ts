import type { AccountSpaceId, GoogleModule } from './types.js';
import { AccountStore } from './account-store.js';
import { GoogleConfigurationStore } from './google-config.js';
import { hasAllScopes, scopesForModules } from './google-scopes.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'; // secret-guard:allow — public Google OAuth endpoint, not a token value
const TOKEN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export type GoogleTokenErrorCode = 'offline' | 'quota' | 'revoked' | 'invalid-response' | 'scope-missing';

export class GoogleTokenError extends Error {
  constructor(readonly code: GoogleTokenErrorCode, message: string, readonly retryAfterSeconds?: number) {
    super(message);
  }
}

export class GoogleTokenBroker {
  private readonly accessTokens = new Map<AccountSpaceId, { value: string; expiresAt: number }>();
  private readonly refreshes = new Map<AccountSpaceId, Promise<string>>();

  constructor(
    private readonly configuration: GoogleConfigurationStore,
    private readonly accounts: AccountStore,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getAccessToken(accountSpaceId: AccountSpaceId, module: GoogleModule, callerSignal?: AbortSignal): Promise<string> {
    const account = this.accounts.require(accountSpaceId);
    if (account.locked) throw new GoogleTokenError('revoked', 'Account Space is locked');
    if (!account.enabledModules.includes(module) || !hasAllScopes(account.grantedScopes, scopesForModules([module]))) {
      throw new GoogleTokenError('scope-missing', 'Enable and reconnect the required Google module');
    }
    const cached = this.accessTokens.get(accountSpaceId);
    if (cached && cached.expiresAt > this.now().getTime() + 60_000) return cached.value;
    let refresh = this.refreshes.get(accountSpaceId);
    if (!refresh) {
      refresh = this.refresh(accountSpaceId);
      this.refreshes.set(accountSpaceId, refresh);
      void refresh.finally(() => this.refreshes.delete(accountSpaceId)).catch(() => undefined);
    }
    return waitWithCancellation(refresh, callerSignal);
  }

  seedAccessToken(accountSpaceId: AccountSpaceId, value: string, expiresAt: number): void {
    if (!value || value.length > 8192) throw new Error('Invalid access token');
    this.accessTokens.set(accountSpaceId, { value, expiresAt });
  }

  invalidate(accountSpaceId: AccountSpaceId): void {
    this.accessTokens.delete(accountSpaceId);
  }

  clear(accountSpaceId: AccountSpaceId): void {
    this.invalidate(accountSpaceId);
  }

  private async refresh(accountSpaceId: AccountSpaceId): Promise<string> {
    const account = this.accounts.require(accountSpaceId);
    if (!account.refreshToken) throw new GoogleTokenError('revoked', 'Google access must be reconnected');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    try {
      const body = new URLSearchParams({
        client_id: this.configuration.getClientId(),
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token',
      });
      const response = await this.request(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status === 400 || response.status === 401) {
        this.accounts.update(accountSpaceId, (record) => { record.googleConnection = 'reconnect-required'; });
        throw new GoogleTokenError('revoked', 'Google access was revoked or expired');
      }
      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
        this.accounts.update(accountSpaceId, (record) => { record.googleConnection = 'quota-limited'; });
        throw new GoogleTokenError('quota', 'Google token quota is temporarily limited', retryAfter);
      }
      if (!response.ok) throw new GoogleTokenError('offline', 'Google token service is unavailable');
      const parsed = await readBoundedJson(response, MAX_TOKEN_RESPONSE_BYTES);
      if (!parsed || typeof parsed !== 'object') throw new GoogleTokenError('invalid-response', 'Google returned an invalid token response');
      const token = (parsed as Record<string, unknown>).access_token;
      const expiresIn = (parsed as Record<string, unknown>).expires_in;
      if (typeof token !== 'string' || token.length === 0 || token.length > 8192 || typeof expiresIn !== 'number' || expiresIn < 60 || expiresIn > 86_400) {
        throw new GoogleTokenError('invalid-response', 'Google returned an invalid token response');
      }
      this.accessTokens.set(accountSpaceId, { value: token, expiresAt: this.now().getTime() + expiresIn * 1000 });
      this.accounts.update(accountSpaceId, (record) => { record.googleConnection = 'connected'; });
      return token;
    } catch (error) {
      if (error instanceof GoogleTokenError) throw error;
      this.accounts.update(accountSpaceId, (record) => { record.googleConnection = 'offline'; });
      throw new GoogleTokenError('offline', 'Google token service is unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maximumBytes) throw new GoogleTokenError('invalid-response', 'Google response exceeded its size limit');
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximumBytes) {
      await reader.cancel();
      throw new GoogleTokenError('invalid-response', 'Google response exceeded its size limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new GoogleTokenError('invalid-response', 'Google returned malformed JSON'); }
}

export function parseRetryAfter(value: string | null, now = new Date()): number {
  if (!value) return 1;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1, Math.min(300, Math.ceil(seconds)));
  const date = Date.parse(value);
  return Number.isNaN(date) ? 1 : Math.max(1, Math.min(300, Math.ceil((date - now.getTime()) / 1000)));
}

function waitWithCancellation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(new GoogleTokenError('offline', 'Google operation was cancelled'));
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new GoogleTokenError('offline', 'Google operation was cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel)).catch(() => undefined);
  });
}
