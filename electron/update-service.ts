import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import { isSafeUpdateEndpoint } from './security.js';
import type { ReleaseManifest, UpdateCheckResult, UpdateServiceInput, UpdateServiceStatus } from './types.js';

interface StoredUpdateService extends UpdateServiceInput {
  version: 1;
}

export class UpdateServiceStore {
  private config?: StoredUpdateService;
  private corrupt = false;
  private readonly disabledPath: string;

  constructor(private readonly filePath: string) {
    this.disabledPath = `${filePath}.disabled`;
    this.config = this.load();
  }

  status(currentVersion: string): UpdateServiceStatus {
    if (this.corrupt) return { configured: false, currentVersion, error: 'configuration-corrupt' };
    if (!safeStorage.isEncryptionAvailable()) return { configured: false, currentVersion, error: 'os-encryption-unavailable' };
    return this.config
      ? { configured: true, currentVersion, endpoint: this.config.endpoint }
      : { configured: false, currentVersion };
  }

  configure(input: UpdateServiceInput, currentVersion: string): UpdateServiceStatus {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
    const endpoint = normalizeEndpoint(input.endpoint);
    const accessToken = input.accessToken.trim();
    if (!isSafeUpdateEndpoint(endpoint)) throw new Error('Use a public HTTPS Cloudflare Worker URL');
    if (accessToken.length < 32 || accessToken.length > 1000) throw new Error('The download access token must be at least 32 characters');
    this.config = { version: 1, endpoint, accessToken };
    this.corrupt = false;
    if (existsSync(this.disabledPath)) unlinkSync(this.disabledPath);
    this.save();
    return this.status(currentVersion);
  }

  bootstrap(input: UpdateServiceInput, currentVersion: string): boolean {
    if (this.config || this.corrupt || existsSync(this.disabledPath)) return true;
    if (!safeStorage.isEncryptionAvailable()) return false;
    this.configure(input, currentVersion);
    return true;
  }

  clear(currentVersion: string): UpdateServiceStatus {
    this.config = undefined;
    this.corrupt = false;
    if (existsSync(this.filePath)) unlinkSync(this.filePath);
    mkdirSync(dirname(this.disabledPath), { recursive: true });
    writeFileSync(this.disabledPath, 'disabled\n', { mode: 0o600 });
    return this.status(currentVersion);
  }

  async check(currentVersion: string): Promise<UpdateCheckResult> {
    if (!this.config) throw new Error('Connect the private download service first');
    const response = await fetch(`${this.config.endpoint}/update.json`, {
      headers: { authorization: `Bearer ${this.config.accessToken}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) throw new Error('The download service rejected the access token or has no release');
    if (!response.ok) throw new Error(`The download service returned ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(length) && length > 100_000) throw new Error('The update response is too large');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 100_000) throw new Error('The update response is too large');
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error('The download service returned invalid JSON'); }
    const manifest = validateManifest(value, this.config.endpoint);
    const state = compareVersions(manifest.version, currentVersion) > 0 ? 'available' : 'up-to-date';
    return { state, currentVersion, latest: manifest, checkedAt: new Date().toISOString() };
  }

  private load(): StoredUpdateService | undefined {
    try {
      if (!safeStorage.isEncryptionAvailable() || !existsSync(this.filePath)) return undefined;
      const encrypted = Buffer.from(readFileSync(this.filePath, 'utf8'), 'base64');
      const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as StoredUpdateService;
      if (parsed.version !== 1 || !isSafeUpdateEndpoint(parsed.endpoint) || parsed.accessToken.length < 32) throw new Error('Invalid update service');
      return { ...parsed, endpoint: normalizeEndpoint(parsed.endpoint) };
    } catch {
      this.corrupt = true;
      return undefined;
    }
  }

  private save(): void {
    if (!this.config) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(this.config));
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, encrypted.toString('base64'), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}

function normalizeEndpoint(value: string): string {
  const url = new URL(value.trim());
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split('-', 1)[0].split('.').map((part) => Number(part));
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.includes('-') === right.includes('-')) return 0;
  return left.includes('-') ? -1 : 1;
}

export function validateManifest(value: unknown, endpoint: string): ReleaseManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid update manifest');
  const item = value as Record<string, unknown>;
  const requiredStrings = ['version', 'channel', 'publishedAt', 'filename', 'sha256', 'commitSha', 'releaseNotes', 'downloadUrl', 'downloadPageUrl', 'expiresAt'] as const;
  for (const field of requiredStrings) if (typeof item[field] !== 'string') throw new Error(`Invalid update manifest: ${field}`);
  if (item.schemaVersion !== 1 || item.appId !== 'private-browser') throw new Error('The update manifest belongs to another application');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(item.version as string)) throw new Error('Invalid update version');
  if (item.channel !== 'stable' && item.channel !== 'beta') throw new Error('Invalid update channel');
  if (!Number.isSafeInteger(item.buildNumber) || !Number.isSafeInteger(item.sizeBytes) || Number(item.sizeBytes) < 1) throw new Error('Invalid update metadata');
  if (!/^[a-f0-9]{64}$/.test(item.sha256 as string)) throw new Error('Invalid update checksum');
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*\.exe$/i.test(item.filename as string) || (item.filename as string).includes('..')) throw new Error('Invalid update filename');
  if (!/^[a-f0-9]{7,64}$/i.test(item.commitSha as string) || (item.releaseNotes as string).length > 10_000) throw new Error('Invalid release details');
  if (!Number.isFinite(Date.parse(item.publishedAt as string))) throw new Error('Invalid publication date');
  const serviceOrigin = new URL(endpoint).origin;
  for (const field of ['downloadUrl', 'downloadPageUrl'] as const) {
    const url = new URL(item[field] as string);
    if (url.protocol !== 'https:' || url.origin !== serviceOrigin || !url.searchParams.has('expires') || !url.searchParams.has('signature')) throw new Error('Invalid signed update URL');
    const expectedPath = field === 'downloadUrl' ? '/download/latest.exe' : '/download';
    if (url.pathname !== expectedPath) throw new Error('Invalid signed update URL');
  }
  const expiresAt = Date.parse(item.expiresAt as string);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('The update links are already expired');
  return item as unknown as ReleaseManifest;
}
