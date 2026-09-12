import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SafeStorageAdapter } from './account-store.js';
import type { GoogleConfigurationStatus } from './types.js';

interface StoredGoogleConfiguration {
  version: 1;
  clientId: string;
}

export class GoogleConfigurationStore {
  private clientId?: string;
  private corrupt = false;
  private readonly source?: GoogleConfigurationStatus['source'];

  constructor(
    private readonly filePath: string,
    private readonly encryption: SafeStorageAdapter,
    environmentClientId = process.env.PRIVATE_BROWSER_GOOGLE_CLIENT_ID,
  ) {
    if (environmentClientId) {
      try {
        this.clientId = validateGoogleClientId(environmentClientId);
        this.source = 'environment';
      } catch {
        this.corrupt = true;
      }
    } else {
      this.clientId = this.load();
      this.source = this.clientId ? 'encrypted-settings' : undefined;
    }
  }

  status(): GoogleConfigurationStatus {
    if (this.corrupt) return { configured: false, error: 'configuration-corrupt' };
    if (!this.encryption.isEncryptionAvailable()) return { configured: false, error: 'os-encryption-unavailable' };
    if (!this.clientId) return { configured: false };
    return { configured: true, source: this.source ?? 'encrypted-settings' };
  }

  getClientId(): string {
    if (!this.clientId) throw new Error('Google integration needs configuration');
    return this.clientId;
  }

  configure(clientId: string): GoogleConfigurationStatus {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
    if (this.corrupt) throw new Error('Google configuration is corrupt; recover or reset it first');
    this.clientId = validateGoogleClientId(clientId);
    this.save();
    return this.status();
  }

  clear(): GoogleConfigurationStatus {
    this.clientId = undefined;
    this.corrupt = false;
    if (existsSync(this.filePath)) renameSync(this.filePath, `${this.filePath}.disabled-${Date.now()}`);
    return this.status();
  }

  private load(): string | undefined {
    try {
      if (!this.encryption.isEncryptionAvailable() || !existsSync(this.filePath)) return undefined;
      const plaintext = this.encryption.decryptString(Buffer.from(readFileSync(this.filePath, 'utf8'), 'base64'));
      const parsed = JSON.parse(plaintext) as StoredGoogleConfiguration;
      if (parsed.version !== 1) throw new Error('Unsupported Google configuration');
      return validateGoogleClientId(parsed.clientId);
    } catch {
      this.corrupt = true;
      return undefined;
    }
  }

  private save(): void {
    if (!this.clientId) throw new Error('Google integration needs configuration');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const encrypted = this.encryption.encryptString(JSON.stringify({ version: 1, clientId: this.clientId } satisfies StoredGoogleConfiguration));
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, encrypted.toString('base64'), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}

export function validateGoogleClientId(value: string): string {
  const clientId = value.trim();
  if (clientId.length < 30 || clientId.length > 300 || !/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new Error('Enter a Google Desktop OAuth client ID');
  }
  return clientId;
}
