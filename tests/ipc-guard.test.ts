import { describe, expect, it } from 'vitest';
import { IpcGuard } from '../electron/ipc-guard';

describe('IPC abuse guard', () => {
  it('accepts ordinary command payloads', () => {
    expect(() => new IpcGuard().check(1, 'browser:navigate', ['https://example.com'], 1)).not.toThrow();
  });

  it('rejects oversized payloads', () => {
    expect(() => new IpcGuard().check(1, 'browser:navigate', ['x'.repeat(300_000)], 1)).toThrow(/too large/);
  });

  it('rate limits a compromised trusted renderer and resets the window', () => {
    const guard = new IpcGuard();
    for (let count = 0; count < 100; count += 1) guard.check(7, 'browser:get-state', [], 1);
    expect(() => guard.check(7, 'browser:get-state', [], 1)).toThrow(/Too many requests for this/);
    expect(() => guard.check(7, 'browser:get-state', [], 10_001)).not.toThrow();
  });

  it('applies stricter per-channel limits to Google operations', () => {
    const guard = new IpcGuard();
    for (let count = 0; count < 20; count += 1) guard.check(8, 'google:gmail-overview', [], 1);
    expect(() => guard.check(8, 'google:gmail-overview', [], 1)).toThrow(/Too many requests for this/);
  });
});
