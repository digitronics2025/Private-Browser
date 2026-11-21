import { existsSync, mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BrowserSessionLock } from '../electron/browser-session-lock.js';

it('requires an observed Windows unlock to resume, including after a browser restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'private-browser-session-lock-'));
  const path = join(directory, 'session.lock');
  let now = 60_000;
  try {
    const state = new BrowserSessionLock(path, () => now);
    expect(state.checkIdle(299, 5)).toBe(false);
    expect(state.checkIdle(300, 5)).toBe(true);
    expect(state.reason).toBe('idle');
    const restarted = new BrowserSessionLock(path, () => now);
    expect(restarted.reason).toBe('idle');
    expect(restarted.onWindowsUnlock()).toBe(false);
    expect(restarted.onWindowsLock(false)).toBe(false);
    expect(restarted.onWindowsUnlock()).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(restarted.checkIdle(300, 5)).toBe(false);
    now += 15_000;
    expect(restarted.onWindowsLock(true)).toBe(true);
    expect(restarted.reason).toBe('windows');
    expect(restarted.onWindowsUnlock()).toBe(true);
  } finally {
    const cleanup = new BrowserSessionLock(path);
    cleanup.onWindowsLock(false);
    cleanup.onWindowsUnlock();
    rmdirSync(directory);
  }
});
