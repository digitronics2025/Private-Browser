import { lstatSync, readFileSync, rmSync } from 'node:fs';
import { atomicWrite } from './myvault/vault-store.js';

export type SessionLockReason = 'windows' | 'idle';

export class BrowserSessionLock {
  private activeReason?: SessionLockReason;
  private observedWindowsLock = false;
  private lastUnlockedAt = 0;

  constructor(private readonly marker: string, private readonly now = Date.now) {
    try {
      const info = lstatSync(marker);
      if (!info.isFile() || info.size > 16) return;
      const reason = readFileSync(marker, 'utf8').trim();
      if (reason === 'windows' || reason === 'idle') this.activeReason = reason;
    } catch { /* A fresh profile has no lock. */ }
  }

  get reason(): SessionLockReason | undefined { return this.activeReason; }

  onWindowsLock(enabled: boolean): boolean {
    this.observedWindowsLock = true;
    return enabled ? this.lock('windows') : false;
  }

  onWindowsUnlock(): boolean {
    if (!this.observedWindowsLock) return false;
    this.observedWindowsLock = false;
    this.lastUnlockedAt = this.now();
    if (!this.activeReason) return false;
    try { rmSync(this.marker, { force: true }); } catch { return false; }
    this.activeReason = undefined;
    return true;
  }

  checkIdle(idleSeconds: number, thresholdMinutes: number): boolean {
    return thresholdMinutes > 0 && idleSeconds >= thresholdMinutes * 60
      && this.now() - this.lastUnlockedAt >= 15_000 && this.lock('idle');
  }

  private lock(reason: SessionLockReason): boolean {
    if (this.activeReason) return false;
    this.activeReason = reason;
    try { atomicWrite(this.marker, reason + '\n'); } catch {
      // A storage failure must not stop the in-memory session from locking.
    }
    return true;
  }
}
