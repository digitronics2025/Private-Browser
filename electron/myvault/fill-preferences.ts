import { existsSync, readFileSync } from 'node:fs';
import { registrableSite } from './site-match.js';
import { atomicWrite, type SafeStorageAdapter } from './vault-store.js';

/** Sites remembered at most; the oldest pick is forgotten first. */
export const FILL_PREFERENCE_MAX_SITES = 500;

interface Preference { entryId: string; usedAt: number }

/**
 * Which saved login the user last chose on each site, so the picker lists it
 * first and automatic fill prefers it — on every address of that site and
 * after a restart. Kept per device (never synced through MyVault) and only as
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

  get(origin: string): string | undefined {
    try {
      return this.preferences.get(FillPreferenceStore.siteKey(origin))?.entryId;
    } catch {
      return undefined;
    }
  }

  remember(origin: string, entryId: string): void {
    const key = FillPreferenceStore.siteKey(origin);
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

  private load(): void {
    if (!existsSync(this.filePath) || !this.safeStorage.isEncryptionAvailable()) return;
    try {
      const parsed: unknown = JSON.parse(this.safeStorage.decryptString(Buffer.from(readFileSync(this.filePath, 'utf8'), 'base64')));
      if (!parsed || typeof parsed !== 'object') return;
      for (const [site, value] of Object.entries(parsed as Record<string, unknown>)) {
        const candidate = value as Partial<Preference> | null;
        if (typeof candidate?.entryId === 'string' && candidate.entryId.length <= 200
          && typeof candidate.usedAt === 'number' && Number.isFinite(candidate.usedAt)) {
          this.preferences.set(site, { entryId: candidate.entryId, usedAt: candidate.usedAt });
        }
      }
    } catch {
      // Unreadable (another OS user, a restored profile, corruption): start empty.
      this.preferences.clear();
    }
  }

  private persist(): void {
    if (!this.safeStorage.isEncryptionAvailable()) return;
    try {
      const encrypted = this.safeStorage.encryptString(JSON.stringify(Object.fromEntries(this.preferences)));
      atomicWrite(this.filePath, encrypted.toString('base64'));
    } catch {
      // A failed write only costs the remembered order after a restart.
    }
  }
}
