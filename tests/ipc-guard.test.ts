import { describe, expect, it } from 'vitest';
import { IpcGuard } from '../electron/ipc-guard';

describe('IPC abuse guard', () => {
  it('accepts ordinary command payloads', () => {
    expect(() => new IpcGuard().check(1, ['https://example.com'], 1)).not.toThrow();
  });

  it('rejects oversized payloads', () => {
    expect(() => new IpcGuard().check(1, ['x'.repeat(300_000)], 1)).toThrow(/too large/);
  });

  it('rate limits a compromised trusted renderer and resets the window', () => {
    const guard = new IpcGuard();
    for (let count = 0; count < 300; count += 1) guard.check(7, [], 1);
    expect(() => guard.check(7, [], 1)).toThrow(/Too many/);
    expect(() => guard.check(7, [], 10_001)).not.toThrow();
  });
});
