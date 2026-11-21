import { existsSync, readFileSync } from 'node:fs';
import { isAccountSpaceId } from '../account-space-validation.js';
import type { AccountSpaceId } from '../types.js';
import { registrableSite } from './site-match.js';
import { atomicWrite, type SafeStorageAdapter } from './vault-store.js';

/** Sites remembered at most; the oldest pick is forgotten first. */
export const FILL_PREFERENCE_MAX_SITES = 500;

interface Preference { entryId: string; usedAt: number }

/**
 * Which saved login the user last chose on each site, so the picker lists it
 * first and automatic fill prefers it — across addresses of that site in the
 * same Account Space and after a restart. Kept per device and only as
 * `safeStorage` ciphertext: when OS encryption is unavailable the choices live
 * in memory for the session and nothing is written in plaintext.
 */
export class FillPreferenceStore {
  private readonly preferences = new Map<string, Preference>();

  constructor(
    private readonly filePath: string,
    private readonly safeStorage: SafeStorageAdapter,
    private readonly now: () => number = Date.now,
  ) {
    this.load();
  }

  /** The key a page origin is remembered under: its site, or the exact origin when it has none. */
  static siteKey(origin: string): string {
    const url = new URL(origin);
    return registrableSite(url.hostname) ?? url.origin;
  }

  get(accountId: AccountSpaceId, origin: string): string | undefined {
    try {
      return this.preferences.get(this.key(accountId, origin))?.entryId;
    } catch {
      return undefined;
    }
  }

  remember(accountId: AccountSpaceId, origin: string, entryId: string): void {
    const key = this.key(accountId, origin);
    this.preferences.delete(key);
    this.preferences.set(key, { entryId, usedAt: this.now() });
    while (this.preferences.size > FILL_PREFERENCE_MAX_SITES) {
      let oldest: string | undefined;
      for (const [site, value] of this.preferences) {
        if (oldest === undefined || value.usedAt < this.preferences.get(oldest)!.usedAt) oldest = site;
      }
      this.preferences.delete(oldest!);
    }
    this.persist();
  }

  reset(accountId: AccountSpaceId): boolean {
    const prefix = accountId + '\0';
    const removed = [...this.preferences].filter(([key]) => key.startsWith(prefix));
    if (!removed.length) return false;
    for (const [key] of removed) this.preferences.delete(key);
    try {
      this.persist(true);
    } catch (error) {
      for (const [key, preference] of removed) this.preferences.set(key, preference);
      throw error;
    }
    return true;
  }

  private key(accountId: AccountSpaceId, origin: string): string {
    if (!isAccountSpaceId(accountId)) throw new Error('Invalid Account Space identifier');
    return accountId + '\0' + FillPreferenceStore.siteKey(origin);
  }

  private load(): void {
    if (!existsSync(this.filePath) || !this.safeStorage.isEncryptionAvailable()) return;
    try {
      const parsed: unknown = JSON.parse(this.safeStorage.decryptString(Buffer.from(readFileSync(this.filePath, 'utf8'), 'base64')));
      if (!parsed || typeof parsed !== 'object') return;
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>).slice(0, FILL_PREFERENCE_MAX_SITES)) {
        const [accountId, site, extra] = key.split('\0');
        if (!isAccountSpaceId(accountId) || !site || site.length > 2048 || extra !== undefined) continue;
        const candidate = value as Partial<Preference> | null;
        if (typeof candidate?.entryId === 'string' && candidate.entryId.length <= 200
          && typeof candidate.usedAt === 'number' && Number.isFinite(candidate.usedAt)) {
          this.preferences.set(key, { entryId: candidate.entryId, usedAt: candidate.usedAt });
        }
      }
    } catch {
      // Unreadable (another OS user, a restored profile, corruption): start empty.
      this.preferences.clear();
    }
  }

  private persist(required = false): void {
    if (!this.safeStorage.isEncryptionAvailable()) return;
    try {
      const encrypted = this.safeStorage.encryptString(JSON.stringify(Object.fromEntries(this.preferences)));
      atomicWrite(this.filePath, encrypted.toString('base64'));
    } catch {
      if (required) throw new Error('Could not save the reset. Remembered picks are still active.');
      // A failed write only costs the remembered order after a restart.
    }
  }
}
