import { expect, it } from 'vitest';
import { healthFromGoogleConnection, observeGoogleHealth } from '../electron/google-connection-health';

it('uses stable health states and keeps remote error text out of the card', () => {
  const previous = '2026-11-21T12:00:00.000Z';
  const now = Date.parse('2026-11-21T13:00:00Z');
  const failure = (code: string) => ({ ok: false, error: { code, message: 'private provider response', requestId: 'test-only', retryAfterSeconds: 90 } });
  expect(observeGoogleHealth({ ok: true, data: 'not health metadata' }, previous, now))
    .toEqual({ state: 'ready', lastSuccessAt: '2026-11-21T13:00:00.000Z' });
  expect(observeGoogleHealth(failure('GOOGLE_SCOPE_MISSING'), previous, now)).toEqual({ state: 'permission', lastSuccessAt: previous });
  expect(observeGoogleHealth(failure('GOOGLE_REVOKED'), previous, now)).toEqual({ state: 'reconnect', lastSuccessAt: previous });
  expect(observeGoogleHealth(failure('GOOGLE_OFFLINE'), previous, now)).toEqual({ state: 'offline', lastSuccessAt: previous });
  expect(observeGoogleHealth(failure('GOOGLE_QUOTA'), previous, now)).toEqual({
    state: 'quota', lastSuccessAt: previous, retryAt: '2026-11-21T13:01:30.000Z',
  });
  expect(observeGoogleHealth(failure('GOOGLE_CANCELLED'), previous, now)).toBeUndefined();
  expect(healthFromGoogleConnection('account-corrupt')).toBe('unavailable');
});
