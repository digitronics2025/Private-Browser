import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import type { VaultItemInput, VaultItemMeta } from './types.js';

interface StoredVaultItem extends VaultItemInput {
  id: string;
  updatedAt: string;
}

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = value.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of cleaned) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid authenticator secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

export function generateTotp(secret: string, epochSeconds = Math.floor(Date.now() / 1000)): string {
  const counter = Math.floor(epochSeconds / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

export class VaultStore {
  private items: StoredVaultItem[] = [];
  private corrupt = false;

  constructor(private readonly filePath: string) {
    this.items = this.load();
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable() && !this.corrupt;
  }

  reason(): 'os-encryption-unavailable' | 'vault-corrupt' | undefined {
    if (this.corrupt) return 'vault-corrupt';
    if (!safeStorage.isEncryptionAvailable()) return 'os-encryption-unavailable';
    return undefined;
  }

  list(): VaultItemMeta[] {
    return this.items.map(({ id, label, url, username, totpSecret, updatedAt }) => ({
      id,
      label,
      url,
      username,
      hasTotp: Boolean(totpSecret),
      updatedAt,
    }));
  }

  add(input: VaultItemInput): VaultItemMeta {
    if (!this.isAvailable()) throw new Error('OS encryption is not available');
    if (input.totpSecret) generateTotp(input.totpSecret);
    const item: StoredVaultItem = { ...input, id: randomUUID(), updatedAt: new Date().toISOString() };
    this.items.unshift(item);
    this.save();
    return this.list()[0];
  }

  remove(id: string): boolean {
    const originalLength = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length !== originalLength) this.save();
    return this.items.length !== originalLength;
  }

  resetCorrupt(): boolean {
    if (!this.corrupt) return false;
    if (existsSync(this.filePath)) renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
    this.items = [];
    this.corrupt = false;
    return true;
  }

  getPassword(id: string): string {
    const item = this.requireItem(id);
    return item.password;
  }

  getTotp(id: string): { code: string; secondsRemaining: number } {
    const item = this.requireItem(id);
    if (!item.totpSecret) throw new Error('No authenticator secret saved');
    const now = Math.floor(Date.now() / 1000);
    return { code: generateTotp(item.totpSecret, now), secondsRemaining: 30 - (now % 30) };
  }

  getForAutofill(id: string): Pick<StoredVaultItem, 'username' | 'password' | 'url'> {
    const { username, password, url } = this.requireItem(id);
    return { username, password, url };
  }

  private requireItem(id: string): StoredVaultItem {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error('Vault entry not found');
    return item;
  }

  private load(): StoredVaultItem[] {
    try {
      if (!this.isAvailable()) return [];
      if (!existsSync(this.filePath)) return [];
      const encrypted = Buffer.from(readFileSync(this.filePath, 'utf8'), 'base64');
      const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as StoredVaultItem[];
      if (!Array.isArray(parsed)) throw new Error('Invalid vault structure');
      return parsed;
    } catch {
      this.corrupt = true;
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(this.items));
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, encrypted.toString('base64'), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
