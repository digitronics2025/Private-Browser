import { isVaultEnvelope } from './security/vault-crypto.js';
import type { VaultEnvelope } from './types.js';

export interface RemoteVault { envelope: VaultEnvelope; version: number; updatedAt: string }
export interface RedeemedDevice { token: string; device: { id: string; label: string; scope: 'read' | 'read-write' } }

export class VaultSyncConflictError extends Error {
  constructor(readonly remote: RemoteVault) { super('The cloud vault changed on another device.'); this.name = 'VaultSyncConflictError'; }
}
export class VaultSyncUnauthorizedError extends Error {
  constructor() { super('The MyVault device credential is invalid, expired, revoked, or insufficient.'); this.name = 'VaultSyncUnauthorizedError'; }
}

type Fetcher = typeof fetch;

/** A vault envelope is a few hundred KB at most; anything far larger is not a MyVault answer. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEVICE_TOKEN = /^mvd_[0-9a-f-]{36}_[A-Za-z0-9_-]{43}$/;

/** 401 is a bad credential; 403 is a valid one without the right scope (for example read-only). */
function isUnauthorized(status: number): boolean {
  return status === 401 || status === 403;
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('MyVault response is too large');
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('MyVault response is too large');
  return JSON.parse(text) as unknown;
}

function parseRemote(value: unknown): RemoteVault {
  if (!value || typeof value !== 'object') throw new Error('Invalid MyVault sync response');
  const remote = value as Partial<RemoteVault>;
  if (!Number.isSafeInteger(remote.version) || Number(remote.version) < 1 || typeof remote.updatedAt !== 'string' || !isVaultEnvelope(remote.envelope)) throw new Error('Invalid MyVault sync response');
  return remote as RemoteVault;
}

export class MyVaultSyncClient {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async redeem(endpoint: string, enrollmentCode: string): Promise<RedeemedDevice> {
    const response = await this.request(new URL('/api/v1/devices/redeem', endpoint), undefined, { method: 'POST', body: JSON.stringify({ code: enrollmentCode }) });
    if (isUnauthorized(response.status)) throw new VaultSyncUnauthorizedError();
    if (!response.ok) throw new Error(`MyVault enrollment failed (${response.status})`);
    const value = await readJson(response) as Partial<RedeemedDevice>;
    // The same shape the store will insist on, checked before anything is written.
    if (typeof value.token !== 'string' || !DEVICE_TOKEN.test(value.token) || !value.device || value.device.scope !== 'read-write') throw new Error('Invalid MyVault enrollment response');
    return value as RedeemedDevice;
  }

  async fetchVault(endpoint: string, token: string): Promise<RemoteVault | null> {
    const response = await this.request(new URL('/api/v1/vault', endpoint), token, { method: 'GET' });
    if (response.status === 404) return null;
    if (isUnauthorized(response.status)) throw new VaultSyncUnauthorizedError();
    if (!response.ok) throw new Error(`MyVault synchronization failed (${response.status})`);
    return parseRemote(await readJson(response));
  }

  async pushVault(endpoint: string, token: string, envelope: VaultEnvelope, expectedVersion: number): Promise<RemoteVault> {
    const response = await this.request(new URL('/api/v1/vault', endpoint), token, { method: 'PUT', body: JSON.stringify({ expectedVersion, envelope }) });
    if (isUnauthorized(response.status)) throw new VaultSyncUnauthorizedError();
    if (response.status === 409) throw new VaultSyncConflictError(parseRemote(await readJson(response)));
    if (!response.ok) throw new Error(`MyVault synchronization failed (${response.status})`);
    return parseRemote(await readJson(response));
  }

  private async request(url: URL, token: string | undefined, init: RequestInit): Promise<Response> {
    if (url.protocol !== 'https:') throw new Error('MyVault endpoint must use HTTPS');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    timeout.unref();
    try {
      return await this.fetcher(url, { ...init, cache: 'no-store', redirect: 'error', signal: controller.signal, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    } finally {
      clearTimeout(timeout);
    }
  }
}
