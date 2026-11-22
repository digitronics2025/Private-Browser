import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { SafeStorageAdapter } from './account-store.js';
import type { AccountSpaceId } from './types.js';

export interface ProtectedBrowsingFile {
  format: 'private-browser-device-browsing-v1';
  iv: string;
  tag: string;
  ciphertext: string;
}

export type BrowsingProtectionStatus = 'off' | 'on' | 'unavailable';
export type BrowsingPrivacyAction = 'protect' | 'export' | 'restore' | 'retention' | 'log';

const format: ProtectedBrowsingFile['format'] = 'private-browser-device-browsing-v1';
const keyFormat = 'private-browser-device-key-v1';

/** The OS wraps one device key. Individual browsing writes use distinct AES-GCM nonces. */
export class BrowsingProtection {
  private key?: Buffer;
  private enabled?: boolean;

  constructor(private readonly markerPath: string, private readonly os?: SafeStorageAdapter) {}

  isEnabled(): boolean { return this.enabled ??= existsSync(this.markerPath); }

  status(): BrowsingProtectionStatus {
    if (!this.isEnabled()) return 'off';
    try { this.requireKey(); return 'on'; }
    catch { return 'unavailable'; }
  }

  enable(write: (path: string, value: unknown) => void): void {
    if (this.isEnabled()) { this.requireKey(); return; }
    if (!this.os?.isEncryptionAvailable()) throw new Error('Device encryption is unavailable.');
    const key = randomBytes(32);
    try {
      const wrappedKey = this.os.encryptString(key.toString('base64url')).toString('base64');
      write(this.markerPath, { format: keyFormat, wrappedKey });
      this.key = key;
      this.enabled = true;
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  encode(id: AccountSpaceId, data: object): ProtectedBrowsingFile {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    cipher.setAAD(Buffer.from(`${format}:${id}`, 'utf8'));
    const bytes = Buffer.from(JSON.stringify(data));
    try {
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return { format, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
    } finally { bytes.fill(0); }
  }

  decode(id: AccountSpaceId, data: unknown): { value: unknown; protected: boolean } {
    if (!data || typeof data !== 'object' || !('format' in data)) return { value: data, protected: false };
    const value = data as Partial<ProtectedBrowsingFile>;
    if (value.format !== format || typeof value.iv !== 'string' || typeof value.tag !== 'string' || typeof value.ciphertext !== 'string') {
      throw new Error('Unknown encrypted browsing file format.');
    }
    const iv = Buffer.from(value.iv, 'base64');
    const tag = Buffer.from(value.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted browsing file.');
    const decipher = createDecipheriv('aes-256-gcm', this.requireKey(), iv);
    decipher.setAAD(Buffer.from(`${format}:${id}`, 'utf8'));
    decipher.setAuthTag(tag);
    const pending = decipher.update(Buffer.from(value.ciphertext, 'base64'));
    let remainder: Buffer | undefined;
    try {
      remainder = decipher.final();
      const clear = Buffer.concat([pending, remainder]);
      try { return { value: JSON.parse(clear.toString('utf8')), protected: true }; }
      finally { clear.fill(0); }
    } finally {
      pending.fill(0);
      remainder?.fill(0);
    }
  }

  private requireKey(): Buffer {
    if (this.key) return this.key;
    if (!this.os?.isEncryptionAvailable()) throw new Error('Device encryption is unavailable.');
    const marker = JSON.parse(readFileSync(this.markerPath, 'utf8')) as { format?: unknown; wrappedKey?: unknown };
    if (marker.format !== keyFormat || typeof marker.wrappedKey !== 'string' || marker.wrappedKey.length > 8_192) {
      throw new Error('The local browsing encryption key is unavailable.');
    }
    const bytes = Buffer.from(this.os.decryptString(Buffer.from(marker.wrappedKey, 'base64')), 'base64url');
    if (bytes.length !== 32) {
      bytes.fill(0);
      throw new Error('The local browsing encryption key is unavailable.');
    }
    return this.key = bytes;
  }
}
