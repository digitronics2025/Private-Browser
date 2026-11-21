import { constants, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { copyFile, link, rmdir, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { requireAccountSpaceId } from './account-space-validation.js';
import { atomicWrite, type SafeStorageAdapter } from './myvault/vault-store.js';
import type { AccountSpaceId, DownloadFolderStatus } from './types.js';

interface Preference {
  version: 1;
  path: string;
  ask: boolean;
}

const fallbackFilename = 'download';
const maxNameLength = 160;
const maxPreferenceBytes = 32 * 1024;

export function safeDownloadFilename(suggested: string): string {
  const clean = suggested.replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_').trim().replace(/[. ]+$/, '');
  const extension = extname(clean);
  let stem = clean.slice(0, clean.length - extension.length);
  if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)[ .]*$/i.test(stem.split('.')[0])) stem = '_' + stem;
  const boundedExtension = extension.length <= 16 ? extension : '';
  stem = stem.slice(0, maxNameLength - boundedExtension.length).replace(/[\ud800-\udbff]$/, '').replace(/[. ]+$/, '');
  return (stem || fallbackFilename) + boundedExtension;
}

function validPath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0') && isAbsolute(path);
}

export function availableDownloadFolder(path: string): string {
  const resolved = realpathSync.native(path);
  if (!validPath(resolved) || !lstatSync(resolved).isDirectory()) throw new Error('The chosen download folder is unavailable.');
  return resolved;
}

export function stageDownload(folder: string, filename: string): string {
  const staging = mkdtempSync(join(folder, '.private-browser-download-'));
  return join(staging, filename);
}

export async function discardDownloadStage(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
  await rmdir(dirname(path)).catch(() => undefined);
}

export async function finishStagedDownload(staged: string, folder: string, filename: string): Promise<string> {
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  for (let index = 0; index < 10000; index++) {
    const destination = join(folder, index ? stem + ' (' + index + ')' + extension : filename);
    try {
      await link(staged, destination).catch(async (error: NodeJS.ErrnoException) => {
        if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS', 'EXDEV'].includes(error.code ?? '')) throw error;
        await copyFile(staged, destination, constants.COPYFILE_EXCL);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    await discardDownloadStage(staged);
    return destination;
  }
  throw new Error('No available filename in this folder.');
}

export class DownloadFolderStore {
  private readonly cached = new Map<AccountSpaceId, Preference | null>();

  constructor(private readonly directory: string, private readonly storage: SafeStorageAdapter) {}

  status(id: AccountSpaceId): DownloadFolderStatus {
    if (!this.storage.isEncryptionAvailable()) return { ask: true, available: false };
    try {
      const preference = this.get(id);
      return { ask: preference?.ask ?? true, available: true, name: preference ? basename(preference.path) || 'Drive root' : undefined };
    } catch {
      return { ask: true, available: false };
    }
  }

  get(id: AccountSpaceId): Preference | null {
    if (!this.storage.isEncryptionAvailable()) return null;
    if (this.cached.has(id)) return this.cached.get(id) ?? null;
    let preference: Preference | null = null;
    try {
      const file = this.pathFor(id);
      if (lstatSync(file).size > maxPreferenceBytes) throw new Error('Download folder setting is too large.');
      const bytes = Buffer.from(readFileSync(file, 'utf8'), 'base64');
      const parsed = JSON.parse(this.storage.decryptString(bytes)) as Partial<Preference> | null;
      if (!parsed || parsed.version !== 1 || !validPath(parsed.path) || typeof parsed.ask !== 'boolean') {
        throw new Error('Invalid download folder setting.');
      }
      preference = { version: 1, path: parsed.path, ask: parsed.ask };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.cached.set(id, preference);
    return preference;
  }

  choose(id: AccountSpaceId, selectedPath: string): void {
    const path = availableDownloadFolder(selectedPath);
    this.write(id, { version: 1, path, ask: this.get(id)?.ask ?? true });
  }

  setAsk(id: AccountSpaceId, ask: boolean): void {
    const preference = this.get(id);
    if (!preference) throw new Error('Choose a download folder first.');
    if (preference.ask !== ask) this.write(id, { ...preference, ask });
  }

  forgetAccount(id: AccountSpaceId): void {
    rmSync(this.pathFor(id), { force: true });
    this.cached.delete(id);
  }

  private pathFor(id: AccountSpaceId): string {
    return join(this.directory, requireAccountSpaceId(id) + '.enc');
  }

  private write(id: AccountSpaceId, preference: Preference): void {
    if (!this.storage.isEncryptionAvailable()) throw new Error('Download folders need Windows protected storage.');
    atomicWrite(this.pathFor(id), this.storage.encryptString(JSON.stringify(preference)).toString('base64'));
    this.cached.set(id, preference);
  }
}
