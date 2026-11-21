import { readFileSync, rmSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { requireAccountSpaceId } from './account-space-validation.js';
import { downloadExtension } from './download-safety.js';
import { downloadRisk, isAllowedRemoteUrl } from './security.js';
import { atomicWrite, type SafeStorageAdapter } from './myvault/vault-store.js';
import type { AccountSpaceId, DownloadEntry, DownloadHistoryStatus } from './types.js';

export const MAX_RETAINED_DOWNLOADS = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface RetainedDownload {
  entry: DownloadEntry;
  file?: { path: string; stamp: string };
}

interface History {
  version: 1;
  enabled: boolean;
  records: RetainedDownload[];
}

function validateRecord(value: unknown, accountId: AccountSpaceId): RetainedDownload {
  if (!value || typeof value !== 'object') throw new Error('Invalid download record');
  const { entry, file } = value as Partial<RetainedDownload>;
  if (!entry || entry.accountSpaceId !== accountId || typeof entry.id !== 'string' || !entry.id || entry.id.length > 128
    || typeof entry.filename !== 'string' || !entry.filename || entry.filename.length > 512
    || !entry.finishedAt || !Number.isFinite(Date.parse(entry.finishedAt))
    || !['completed', 'cancelled', 'interrupted'].includes(entry.state)
    || !Number.isSafeInteger(entry.totalBytes) || entry.totalBytes < 0
    || !Number.isSafeInteger(entry.receivedBytes) || entry.receivedBytes < 0) throw new Error('Invalid download record');
  const origin = entry.origin && isAllowedRemoteUrl(entry.origin) ? new URL(entry.origin).origin : undefined;
  if (file && (entry.state !== 'completed' || typeof file.path !== 'string' || !isAbsolute(file.path)
    || file.path.includes('\0') || file.path.length > 4096 || !/^-?\d+(?::-?\d+){4}$/.test(file.stamp))) {
    throw new Error('Invalid downloaded file metadata');
  }
  const filename = file ? basename(file.path) : entry.filename;
  return {
    entry: {
      accountSpaceId: accountId, id: entry.id, filename, state: entry.state,
      totalBytes: entry.totalBytes, receivedBytes: entry.receivedBytes,
      origin, finishedAt: entry.finishedAt, retained: true,
      risk: downloadRisk(filename), extension: downloadExtension(filename),
    },
    file,
  };
}

export class DownloadHistoryStore {
  private readonly histories = new Map<AccountSpaceId, History | null>();

  constructor(private readonly directory: string, private readonly storage: SafeStorageAdapter) {}

  status(id: AccountSpaceId): DownloadHistoryStatus {
    const history = this.read(id);
    return history ? history.enabled ? 'on' : 'off' : 'unavailable';
  }

  entries(id: AccountSpaceId): readonly RetainedDownload[] {
    return this.read(id)?.records ?? [];
  }

  setEnabled(id: AccountSpaceId, enabled: boolean): void {
    const current = this.read(id);
    if (!current) throw new Error('Download history needs Windows protected storage.');
    if (current.enabled !== enabled) this.write(id, { ...current, enabled });
  }

  record(id: AccountSpaceId, value: RetainedDownload): boolean {
    const current = this.read(id);
    if (!current?.enabled) return false;
    const record = validateRecord(value, id);
    this.write(id, { ...current, records: [record, ...current.records.filter(({ entry }) => entry.id !== record.entry.id)].slice(0, MAX_RETAINED_DOWNLOADS) });
    return true;
  }

  remove(id: AccountSpaceId, downloadId: string): void {
    const current = this.read(id);
    if (!current) throw new Error('Download history is unavailable.');
    const records = current.records.filter(({ entry }) => entry.id !== downloadId);
    if (records.length < current.records.length) this.write(id, { ...current, records });
  }

  forgetAccount(id: AccountSpaceId): void {
    rmSync(this.pathFor(id), { force: true });
    this.histories.delete(id);
  }

  private pathFor(id: AccountSpaceId): string {
    return join(this.directory, requireAccountSpaceId(id) + '.enc');
  }

  private read(id: AccountSpaceId): History | null {
    const cached = this.histories.get(id);
    if (cached !== undefined) return cached;
    if (!this.storage.isEncryptionAvailable()) return null;
    let history: History | null = null;
    try {
      const path = this.pathFor(id);
      if (statSync(path).size > MAX_FILE_BYTES) throw new Error('Download history is too large');
      const contents = readFileSync(path, 'utf8');
      const parsed = JSON.parse(this.storage.decryptString(Buffer.from(contents, 'base64'))) as Partial<History>;
      if (parsed.version !== 1 || typeof parsed.enabled !== 'boolean' || !Array.isArray(parsed.records)
        || parsed.records.length > MAX_RETAINED_DOWNLOADS) throw new Error('Invalid download history');
      history = { version: 1, enabled: parsed.enabled, records: parsed.records.map((record) => validateRecord(record, id)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') history = { version: 1, enabled: false, records: [] };
    }
    this.histories.set(id, history);
    return history;
  }

  private write(id: AccountSpaceId, history: History): void {
    const contents = this.storage.encryptString(JSON.stringify(history)).toString('base64');
    if (contents.length > MAX_FILE_BYTES) throw new Error('Download history is too large');
    atomicWrite(this.pathFor(id), contents);
    this.histories.set(id, history);
  }
}
