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
    if (response.status === 401) throw new VaultSyncUnauthorizedError();
    if (!response.ok) throw new Error(`MyVault enrollment failed (${response.status})`);
    const value = await response.json() as Partial<RedeemedDevice>;
    if (typeof value.token !== 'string' || !value.token.startsWith('mvd_') || !value.device || value.device.scope !== 'read-write') throw new Error('Invalid MyVault enrollment response');
    return value as RedeemedDevice;
  }

  async fetchVault(endpoint: string, token: string): Promise<RemoteVault | null> {
    const response = await this.request(new URL('/api/v1/vault', endpoint), token, { method: 'GET' });
    if (response.status === 404) return null;
    if (response.status === 401) throw new VaultSyncUnauthorizedError();
    if (!response.ok) throw new Error(`MyVault synchronization failed (${response.status})`);
    return parseRemote(await response.json());
  }

  async pushVault(endpoint: string, token: string, envelope: VaultEnvelope, expectedVersion: number): Promise<RemoteVault> {
    const response = await this.request(new URL('/api/v1/vault', endpoint), token, { method: 'PUT', body: JSON.stringify({ expectedVersion, envelope }) });
    if (response.status === 401) throw new VaultSyncUnauthorizedError();
    if (response.status === 409) throw new VaultSyncConflictError(parseRemote(await response.json()));
    if (!response.ok) throw new Error(`MyVault synchronization failed (${response.status})`);
    return parseRemote(await response.json());
  }

  private async request(url: URL, token: string | undefined, init: RequestInit): Promise<Response> {
    if (url.protocol !== 'https:') throw new Error('MyVault endpoint must use HTTPS');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    timeout.unref();
    try {
      return await this.fetcher(url, { ...init, cache: 'no-store', signal: controller.signal, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) } });
    } finally {
      clearTimeout(timeout);
    }
  }
}
