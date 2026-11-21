import { expect, it } from 'vitest';
import { requireAccountSpaceId } from '../electron/account-space-validation.js';
import { canPauseTrackersAt, TRACKER_COMPATIBILITY_MS, TrackerProtection, trackerCategory } from '../electron/tracker-protection.js';

it('matches actual tracker domain labels and rejects protected or insecure pause targets', () => {
  expect(trackerCategory('https://pixel.doubleclick.net./script')).toBe('advertising');
  expect(trackerCategory('https://connect.facebook.net/sdk.js')).toBe('social');
  expect(trackerCategory('https://doubleclick.net.example.test/')).toBeUndefined();
  expect(canPauseTrackersAt('https://example.test/reference')).toBe(true);
  expect(canPauseTrackersAt('http://127.0.0.1:4173/')).toBe(true);
  expect(canPauseTrackersAt('http://127.example.test/')).toBe(false);
  expect(canPauseTrackersAt('https://example.test/checkout/payment')).toBe(false);
});

it('counts by account and exact origin and expires compatibility without relaxing Banking', () => {
  const first = requireAccountSpaceId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  const second = requireAccountSpaceId('ffffffff-aaaa-4bbb-8ccc-dddddddddddd');
  let now = 1;
  const protection = new TrackerProtection(() => now);
  const origin = 'https://example.test';
  const ordinary = { enabled: true, strict: false, origin };
  expect(protection.shouldBlock(first, 'advertising', ordinary)).toBe(true);
  protection.pause(first, origin, true);
  expect(protection.shouldBlock(first, 'advertising', ordinary)).toBe(false);
  expect(protection.shouldBlock(first, 'analytics', { ...ordinary, origin: origin + ':8443' })).toBe(true);
  expect(protection.shouldBlock(second, 'analytics', ordinary)).toBe(true);
  expect(protection.shouldBlock(first, 'social', { ...ordinary, strict: true, enabled: false })).toBe(true);
  expect(protection.status(first, origin, { ...ordinary, canPause: true })).toMatchObject({
    counts: { advertising: 1, social: 1 }, blocking: false, pausedUntil: now + TRACKER_COMPATIBILITY_MS,
  });
  now += TRACKER_COMPATIBILITY_MS;
  expect(protection.shouldBlock(first, 'telemetry', ordinary)).toBe(true);
  expect(protection.status(first, origin, { ...ordinary, canPause: true }).pausedUntil).toBeUndefined();
  protection.clearAccount(first);
  expect(protection.status(first, origin, { ...ordinary, canPause: true }).counts).toEqual({});
  expect(protection.status(second, origin, { ...ordinary, canPause: true }).counts).toEqual({ analytics: 1 });
});
