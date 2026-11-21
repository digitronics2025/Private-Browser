import type { GoogleConnectionHealth, GoogleConnectionStatus, GoogleHealthState } from './types.js';

export function healthFromGoogleConnection(status: GoogleConnectionStatus): GoogleHealthState {
  switch (status) {
    case 'connected': return 'ready';
    case 'partial-scopes': return 'permission';
    case 'reconnect-required': return 'reconnect';
    case 'offline': return 'offline';
    case 'quota-limited': return 'quota';
    case 'locked': case 'account-corrupt': return 'unavailable';
    default: return 'disconnected';
  }
}

export function observeGoogleHealth(value: unknown, lastSuccessAt: string | undefined, now: number): GoogleConnectionHealth | undefined {
  if (!value || typeof value !== 'object' || !('ok' in value)) return undefined;
  if (value.ok === true) return { state: 'ready', lastSuccessAt: new Date(now).toISOString() };
  if (!('error' in value) || !value.error || typeof value.error !== 'object' || !('code' in value.error)) return undefined;
  switch (value.error.code) {
    case 'GOOGLE_CONFIGURATION_REQUIRED': return { state: 'disconnected', lastSuccessAt };
    case 'GOOGLE_REVOKED': case 'GOOGLE_RECONNECT_REQUIRED': return { state: 'reconnect', lastSuccessAt };
    case 'GOOGLE_SCOPE_MISSING': return { state: 'permission', lastSuccessAt };
    case 'GOOGLE_OFFLINE': return { state: 'offline', lastSuccessAt };
    case 'GOOGLE_QUOTA': {
      const seconds = 'retryAfterSeconds' in value.error ? value.error.retryAfterSeconds : undefined;
      const retryAt = typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 604_800
        ? new Date(now + seconds * 1000).toISOString() : undefined;
      return { state: 'quota', lastSuccessAt, retryAt };
    }
    default: return undefined;
  }
}
