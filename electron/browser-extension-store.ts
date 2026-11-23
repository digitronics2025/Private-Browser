import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import type { Session } from 'electron';
import { isAccountSpaceId } from './account-space-validation.js';
import {
  inspectBrowserExtensionManifest,
  manifestForAllowedOrigins,
  parseExactHttpsPattern,
  validateResourcePath,
  type BrowserExtensionManifest,
  type BrowserExtensionReview,
} from './browser-extension-policy.js';

const MAX_EXTENSION_BYTES = 25 * 1024 * 1024;
const MAX_EXTENSION_FILES = 1_500;
const MAX_ORIGINS = 40;
const REVIEW_TTL_MS = 5 * 60_000;

export interface ExtensionStorageEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface BrowserExtensionSummary extends BrowserExtensionReview {
  id: string;
  allowedOrigins: string[];
  installedAt: string;
  enabled: boolean;
}

export interface BrowserExtensionReviewTicket extends BrowserExtensionReview {
  reviewId: string;
}

interface Candidate {
  sourcePath: string;
  packageHash: string;
  manifest: BrowserExtensionManifest;
  review: BrowserExtensionReview;
  expiresAt: number;
}

interface InstalledExtension {
  id: string;
  packageHash: string;
  name: string;
  version: string;
  description: string;
  permissions: string[];
  requestedOrigins: string[];
  allowedOrigins: string[];
  installedAt: string;
  manifest: BrowserExtensionManifest;
  electronId?: string;
}

interface ExtensionIndex { schemaVersion: 1; items: InstalledExtension[] }

/**
 * Stores site grants under Electron safeStorage and keeps extension code in a
 * private per-Account-Space directory. Electron extensions are loaded only into
 * that Account Space's persistent Chromium session.
 */
export class BrowserExtensionStore {
  private readonly reviews = new Map<string, Candidate>();

  constructor(private readonly root: string, private readonly encryption: ExtensionStorageEncryption) {}

  async inspect(sourceDirectory: string): Promise<BrowserExtensionReviewTicket> {
    this.requireEncryption();
    this.expireReviews();
    if (this.reviews.size >= 10) throw new Error('Finish or close an open extension review first.');
    const candidate = await scanExtension(sourceDirectory);
    const { manifest, review } = inspectBrowserExtensionManifest(candidate.manifest);
    validateManifestFiles(manifest, new Set(candidate.files));
    const reviewId = randomUUID();
    this.reviews.set(reviewId, { ...candidate, manifest, review, expiresAt: Date.now() + REVIEW_TTL_MS });
    return { reviewId, ...review };
  }

  reviewPackageId(reviewId: string): string {
    this.expireReviews();
    const candidate = this.reviews.get(reviewId);
    if (!candidate) throw new Error('The extension review expired. Review the folder again.');
    return candidate.packageHash;
  }

  async install(accountId: string, reviewId: string, allowedOrigins: string[]): Promise<BrowserExtensionSummary> {
    this.requireAccountId(accountId);
    this.requireEncryption();
    this.expireReviews();
    const candidate = this.reviews.get(reviewId);
    if (!candidate) throw new Error('The extension review expired. Review the folder again.');
    this.reviews.delete(reviewId);
    const current = await scanExtension(candidate.sourcePath);
    if (current.packageHash !== candidate.packageHash) throw new Error('The extension changed during review. Review the folder again.');
    const allowed = checkedAllowedOrigins(candidate.review.requestedOrigins, allowedOrigins);
    const installedItems = await this.items(accountId);
    if (installedItems.some((item) => item.id === candidate.packageHash)) {
      throw new Error('This extension is already installed in this Account Space. Change its site access or remove it first.');
    }
    if (installedItems.length >= 100) throw new Error('This Account Space already has the maximum of 100 extensions.');
    const activeManifest = manifestForAllowedOrigins(candidate.manifest, allowed);
    const installedAt = new Date().toISOString();
    const item: InstalledExtension = {
      id: candidate.packageHash,
      packageHash: candidate.packageHash,
      name: candidate.review.name,
      version: candidate.review.version,
      description: candidate.review.description,
      permissions: candidate.review.permissions,
      requestedOrigins: candidate.review.requestedOrigins,
      allowedOrigins: allowed,
      installedAt,
      manifest: candidate.manifest,
    };
    const directory = this.accountExtensionDirectory(accountId, item.id);
    const stage = `${directory}.stage-${randomUUID()}`;
    await mkdir(join(directory, '..'), { recursive: true });
    await mkdir(stage, { recursive: true });
    try {
      await copyTree(candidate.sourcePath, join(stage, 'source'), current.files);
      const copied = await scanExtension(join(stage, 'source'));
      if (copied.packageHash !== candidate.packageHash) throw new Error('The extension changed during installation. Review the folder again.');
      await copyTree(join(stage, 'source'), join(stage, 'active'), current.files);
      await writeFile(join(stage, 'active', 'manifest.json'), JSON.stringify(activeManifest, null, 2) + '\n', { flag: 'w' });
      await rm(directory, { recursive: true, force: true });
      await mkdir(join(directory, '..'), { recursive: true });
      await rename(stage, directory);
      const items = await this.items(accountId);
      items.push(item);
      await this.writeItems(accountId, items);
      return toSummary(item);
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async list(accountId: string): Promise<BrowserExtensionSummary[]> {
    this.requireAccountId(accountId);
    return (await this.items(accountId)).map(toSummary);
  }

  async setAllowedOrigins(accountId: string, id: string, origins: string[]): Promise<BrowserExtensionSummary> {
    this.requireAccountId(accountId);
    const items = await this.items(accountId);
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error('The extension is no longer installed in this Account Space.');
    item.allowedOrigins = checkedAllowedOrigins(item.requestedOrigins, origins);
    await this.materialize(accountId, item);
    await this.writeItems(accountId, items);
    return toSummary(item);
  }

  async remove(accountId: string, id: string): Promise<void> {
    this.requireAccountId(accountId);
    const items = await this.items(accountId);
    const next = items.filter((entry) => entry.id !== id);
    if (next.length === items.length) return;
    await this.writeItems(accountId, next);
    await rm(this.accountExtensionDirectory(accountId, id), { recursive: true, force: true });
  }

  async loadForSession(accountId: string, session: Session): Promise<string[]> {
    this.requireAccountId(accountId);
    this.requireEncryption();
    const items = await this.items(accountId);
    const loaded = session.extensions.getAllExtensions();
    const failed: string[] = [];
    for (const item of items) {
      try {
        const path = await this.materialize(accountId, item);
        const existing = loaded.find((extension) => resolve(extension.path) === resolve(path));
        if (existing) {
          if (item.electronId !== existing.id) item.electronId = existing.id;
          continue;
        }
        if (!item.allowedOrigins.length) continue;
        const extension = await session.extensions.loadExtension(path, { allowFileAccess: false });
        item.electronId = extension.id;
      } catch {
        item.electronId = undefined;
        failed.push(item.id);
      }
    }
    await this.writeItems(accountId, items);
    return failed;
  }

  async unloadFromSession(accountId: string, id: string, session: Session): Promise<void> {
    const item = (await this.items(accountId)).find((entry) => entry.id === id);
    const paths = new Set([this.activeDirectory(accountId, id), ...(item?.electronId ? [] : [])].map((path) => resolve(path)));
    for (const extension of session.extensions.getAllExtensions()) {
      if (paths.has(resolve(extension.path)) || item?.electronId === extension.id) session.extensions.removeExtension(extension.id);
    }
  }

  private async materialize(accountId: string, item: InstalledExtension): Promise<string> {
    const directory = this.accountExtensionDirectory(accountId, item.id);
    const source = join(directory, 'source');
    const actual = await scanExtension(source);
    if (actual.packageHash !== item.packageHash) throw new Error('Installed extension files changed. Remove and review the extension before enabling it.');
    const { manifest, review } = inspectBrowserExtensionManifest(actual.manifest);
    if (review.name !== item.name || review.version !== item.version) throw new Error('Installed extension details changed.');
    const active = this.activeDirectory(accountId, item.id);
    const stage = `${active}.stage-${randomUUID()}`;
    await copyTree(source, stage, actual.files);
    try {
      const filtered = manifestForAllowedOrigins(manifest, item.allowedOrigins);
      await writeFile(join(stage, 'manifest.json'), JSON.stringify(filtered, null, 2) + '\n', { flag: 'w' });
      await rm(active, { recursive: true, force: true });
      await rename(stage, active);
    } catch (error) {
      await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return active;
  }

  private async items(accountId: string): Promise<InstalledExtension[]> {
    const path = this.indexPath(accountId);
    let encoded: string;
    try { encoded = await readFile(path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Could not read extension settings.');
    }
    try {
      const parsed: unknown = JSON.parse(this.encryption.decryptString(Buffer.from(encoded, 'base64')));
      if (!isIndex(parsed)) throw new Error('invalid index');
      return parsed.items;
    } catch {
      throw new Error('Extension settings could not be decrypted safely.');
    }
  }

  private async writeItems(accountId: string, items: InstalledExtension[]): Promise<void> {
    this.requireEncryption();
    const directory = join(this.root, 'browser-extensions');
    await mkdir(directory, { recursive: true });
    const target = this.indexPath(accountId);
    const temporary = `${target}.tmp-${randomUUID()}`;
    const encrypted = this.encryption.encryptString(JSON.stringify({ schemaVersion: 1, items } satisfies ExtensionIndex)).toString('base64');
    await writeFile(temporary, encrypted, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  }

  private indexPath(accountId: string): string { return join(this.root, 'browser-extensions', `${accountId}.enc`); }
  private accountExtensionDirectory(accountId: string, id: string): string { return join(this.root, 'browser-extensions', accountId, id); }
  private activeDirectory(accountId: string, id: string): string { return join(this.accountExtensionDirectory(accountId, id), 'active'); }

  private requireAccountId(accountId: string): void {
    if (!isAccountSpaceId(accountId)) throw new Error('Invalid Account Space.');
  }
  private requireEncryption(): void {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows credential protection is unavailable; extension permissions remain disabled.');
  }
  private expireReviews(): void {
    const now = Date.now();
    for (const [id, review] of this.reviews) if (review.expiresAt <= now) this.reviews.delete(id);
  }
}

async function scanExtension(directory: string): Promise<{ sourcePath: string; packageHash: string; manifest: unknown; files: string[] }> {
  const initialStat = await lstat(directory).catch(() => { throw new Error('Choose a readable unpacked extension folder.'); });
  if (!initialStat.isDirectory() || initialStat.isSymbolicLink()) throw new Error('Choose a normal extension folder, not a link.');
  const root = await realpath(directory).catch(() => { throw new Error('Choose a readable unpacked extension folder.'); });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Choose a normal extension folder, not a link.');
  const entries: Array<{ relative: string; absolute: string; bytes: Buffer }> = [];
  let total = 0;
  const walk = async (current: string, prefix = ''): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const rel = prefix ? `${prefix}/${child.name}` : child.name;
      if (rel.split('/').some((part) => part === '.' || part === '..' || part.startsWith('.stage-'))) continue;
      const absolute = join(current, child.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error('Extensions containing symbolic links are not supported.');
      if (info.isDirectory()) { await walk(absolute, rel); continue; }
      if (!info.isFile()) throw new Error('Extension contains an unsupported filesystem entry.');
      if (entries.length >= MAX_EXTENSION_FILES) throw new Error('Extension contains too many files.');
      total += info.size;
      if (total > MAX_EXTENSION_BYTES) throw new Error('Extension exceeds the 25 MB size limit.');
      // Read through one open handle and verify it still identifies the file we
      // inspected. This prevents a concurrently swapped symlink/path from making
      // the reviewed bytes differ from the regular file found during the scan.
      const handle = await open(absolute, 'r');
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
          throw new Error('Extension files changed while being reviewed. Choose the folder again.');
        }
        const bytes = await handle.readFile();
        const afterRead = await handle.stat();
        if (afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs || bytes.length !== opened.size) {
          throw new Error('Extension files changed while being reviewed. Choose the folder again.');
        }
        entries.push({ relative: rel, absolute, bytes });
      } finally {
        await handle.close();
      }
    }
  };
  await walk(root);
  const manifestFile = entries.find((entry) => entry.relative === 'manifest.json');
  if (!manifestFile || manifestFile.bytes.length > 1_000_000) throw new Error('The folder must contain a small root manifest.json file.');
  let manifest: unknown;
  try { manifest = JSON.parse(manifestFile.bytes.toString('utf8')); } catch { throw new Error('The extension manifest is not valid JSON.'); }
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.relative.replaceAll('\\', '/')).update('\0').update(entry.bytes).update('\0');
  }
  return { sourcePath: root, packageHash: hash.digest('hex'), manifest, files: entries.map((entry) => entry.relative) };
}

function validateManifestFiles(manifest: BrowserExtensionManifest, files: Set<string>): void {
  const requireFile = (value: unknown) => {
    if (typeof value !== 'string') throw new Error('The extension references an invalid local file.');
    validateResourcePath(value);
    if (!files.has(value)) throw new Error('The extension references a missing local file.');
  };
  for (const script of manifest.content_scripts) {
    for (const resource of [...(Array.isArray(script.js) ? script.js : []), ...(Array.isArray(script.css) ? script.css : [])]) requireFile(resource);
  }
  if (manifest.background !== undefined) {
    if (!manifest.background || typeof manifest.background !== 'object' || Array.isArray(manifest.background)) throw new Error('Only a local Manifest V3 background service worker is supported.');
    const background = manifest.background as Record<string, unknown>;
    if (Object.keys(background).some((key) => key !== 'service_worker') || typeof background.service_worker !== 'string') {
      throw new Error('Only a local Manifest V3 background service worker is supported.');
    }
    requireFile(background.service_worker);
  }
}

async function copyTree(source: string, destination: string, expectedFiles: string[]): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const file of expectedFiles) {
    validateResourcePath(file);
    const relativePath = file.split('/').join(sep);
    const from = resolve(source, relativePath);
    const to = resolve(destination, relativePath);
    const rel = relative(destination, to);
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Invalid extension resource path.');
    await mkdir(join(to, '..'), { recursive: true });
    const info = await lstat(from);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Extension files changed during installation.');
    await copyFile(from, to);
  }
}

function checkedAllowedOrigins(requested: string[], allowed: string[]): string[] {
  if (!Array.isArray(allowed) || allowed.length > MAX_ORIGINS || allowed.some((origin) => typeof origin !== 'string')) {
    throw new Error('Invalid site access selection.');
  }
  const unique = [...new Set(allowed)];
  if (unique.length !== allowed.length || unique.some((origin) => !requested.includes(origin))) throw new Error('Choose only sites shown in the extension review.');
  return unique.sort();
}

function toSummary(item: InstalledExtension): BrowserExtensionSummary {
  return {
    id: item.id, name: item.name, version: item.version, description: item.description,
    permissions: [...item.permissions], requestedOrigins: [...item.requestedOrigins],
    allowedOrigins: [...item.allowedOrigins], installedAt: item.installedAt, enabled: item.allowedOrigins.length > 0,
  };
}

function isIndex(value: unknown): value is ExtensionIndex {
  if (!value || typeof value !== 'object') return false;
  const index = value as ExtensionIndex;
  return index.schemaVersion === 1 && Array.isArray(index.items) && index.items.length <= 100 && index.items.every((item) =>
    item && /^[a-f\d]{64}$/.test(item.id) && item.packageHash === item.id && typeof item.name === 'string'
      && typeof item.version === 'string' && typeof item.description === 'string' && Array.isArray(item.permissions)
      && item.permissions.every((permission) => typeof permission === 'string') && Array.isArray(item.requestedOrigins)
      && item.requestedOrigins.every((origin) => { try { return parseExactHttpsPattern(`${origin}/*`) === origin; } catch { return false; } })
      && Array.isArray(item.allowedOrigins) && item.allowedOrigins.every((origin) => item.requestedOrigins.includes(origin))
      && typeof item.installedAt === 'string' && item.manifest && typeof item.manifest === 'object' && Array.isArray(item.manifest.content_scripts));
}
