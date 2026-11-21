import { readFileSync, rmSync } from 'node:fs';
import { atomicWriteJson } from './account-space-state.js';
import type { TabProblem } from './types.js';

const MAX_AUTOMATIC_ATTEMPTS = 2;

/** The journal contains a tab ID and counter. Page addresses never enter it. */
export class StartupRestoreJournal {
  constructor(private readonly path: string) {}

  begin(tabId: string): boolean {
    let attempts = 0;
    try {
      const previous = JSON.parse(readFileSync(this.path, 'utf8')) as { tabId?: unknown; attempts?: unknown };
      if (previous.tabId === tabId && Number.isSafeInteger(previous.attempts)) attempts = Number(previous.attempts);
    } catch {
      // A missing or unreadable journal starts a fresh attempt.
    }
    if (attempts >= MAX_AUTOMATIC_ATTEMPTS) return false;
    try {
      atomicWriteJson(this.path, { tabId, attempts: attempts + 1 });
    } catch {
      // A journal write failure must not prevent the browser from opening.
    }
    return true;
  }

  clear(): void {
    try { rmSync(this.path, { force: true }); } catch { /* Recovery stays usable when storage is unavailable. */ }
  }
}

export function problemForFailedLoad(code: number, certificateRejected: boolean): TabProblem | undefined {
  if (code === -3) return undefined; // Chromium ERR_ABORTED, including Stop and replaced navigations.
  if (certificateRejected || (code <= -200 && code >= -299)) return 'certificate';
  if (code === -106) return 'offline';
  return 'network';
}
