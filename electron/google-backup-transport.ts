import { randomUUID } from 'node:crypto';
import type { AccountSpaceId } from './types.js';
import type { EncryptedBackupTransport, RemoteEncryptedBackup } from './account-backup.js';
import { GoogleTokenBroker, readBoundedJson } from './google-token-broker.js';

const BACKUP_FILENAME = 'private-browser-account-space-v1.backup';
const MAX_REMOTE_BACKUP_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

export class GoogleDriveAppDataTransport implements EncryptedBackupTransport {
  private readonly fileIds = new Map<AccountSpaceId, string>();

  constructor(private readonly tokens: GoogleTokenBroker, private readonly request: typeof fetch = fetch) {}

  async read(accountSpaceId: AccountSpaceId, signal?: AbortSignal): Promise<RemoteEncryptedBackup | undefined> {
    const token = await this.tokens.getAccessToken(accountSpaceId, 'encrypted-backup', signal);
    const listUrl = new URL('https://www.googleapis.com/drive/v3/files');
    listUrl.search = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '2', fields: 'files(id,name)', orderBy: 'modifiedTime desc',
      q: `name = '${BACKUP_FILENAME}' and trashed = false` }).toString();
    const listedResponse = await this.authorizedFetch(listUrl, token, {}, signal);
    if (!listedResponse.ok) throw new Error('Encrypted backup lookup failed');
    const listed = await readBoundedJson(listedResponse, 64 * 1024) as { files?: Array<{ id?: unknown; name?: unknown }> };
    const file = listed.files?.find((item) => item.name === BACKUP_FILENAME && typeof item.id === 'string');
    if (!file || typeof file.id !== 'string') {
      this.fileIds.delete(accountSpaceId);
      return undefined;
    }
    this.fileIds.set(accountSpaceId, file.id);
    const download = await this.authorizedFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`, token, {}, signal);
    if (!download.ok) throw new Error('Encrypted backup download failed');
    const bytes = await readBoundedBytes(download, MAX_REMOTE_BACKUP_BYTES);
    const etag = download.headers.get('etag');
    if (!etag || etag.length > 512) throw new Error('Encrypted backup is missing its conflict identifier');
    return { bytes, etag, fileId: file.id };
  }

  async write(accountSpaceId: AccountSpaceId, bytes: Uint8Array, expectedEtag?: string, signal?: AbortSignal): Promise<{ etag: string; fileId: string }> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_REMOTE_BACKUP_BYTES) throw new Error('Encrypted backup exceeds its size limit');
    const token = await this.tokens.getAccessToken(accountSpaceId, 'encrypted-backup', signal);
    const existingId = this.fileIds.get(accountSpaceId);
    let response: Response;
    if (existingId) {
      response = await this.authorizedFetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=media&fields=id`, token, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/octet-stream', ...(expectedEtag ? { 'If-Match': expectedEtag } : {}) },
        body: Buffer.from(bytes),
      }, signal);
    } else {
      const boundary = `private-browser-${randomUUID()}`;
      const prefix = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: BACKUP_FILENAME, parents: ['appDataFolder'] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
      const suffix = Buffer.from(`\r\n--${boundary}--`);
      response = await this.authorizedFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', token, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body: Buffer.concat([prefix, Buffer.from(bytes), suffix]),
      }, signal);
    }
    if (response.status === 412) throw new Error('Encrypted backup changed on another device');
    if (!response.ok) throw new Error('Encrypted backup upload failed');
    const body = await readBoundedJson(response, 64 * 1024) as { id?: unknown };
    const fileId = typeof body.id === 'string' ? body.id : existingId;
    const etag = response.headers.get('etag');
    if (!fileId || !etag || fileId.length > 512 || etag.length > 512) throw new Error('Encrypted backup upload returned invalid metadata');
    this.fileIds.set(accountSpaceId, fileId);
    return { fileId, etag };
  }

  private async authorizedFetch(url: string | URL, token: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    return authorizeDriveAppData(this.request, url, token, init, signal);
  }
}

export interface BookmarkReplicaTransport {
  reserve(account: AccountSpaceId, signal?: AbortSignal): Promise<string>;
  read(account: AccountSpaceId, fileId: string, signal?: AbortSignal): Promise<RemoteEncryptedBackup | undefined>;
  create(account: AccountSpaceId, fileId: string, bytes: Buffer, signal?: AbortSignal): Promise<void>;
  save(account: AccountSpaceId, fileId: string, etag: string, bytes: Buffer, signal?: AbortSignal): Promise<void>;
}

export function isDriveFileId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,256}$/.test(value);
}

/** Uses the paired object directly. No filename search can silently switch a device to another library. */
export class GoogleDriveBookmarkTransport implements BookmarkReplicaTransport {
  constructor(private readonly tokens: GoogleTokenBroker, private readonly request: typeof fetch = fetch) {}

  async reserve(account: AccountSpaceId, signal?: AbortSignal): Promise<string> {
    const response = await this.fetch(account, 'https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=appDataFolder&type=files', {}, signal);
    if (!response.ok) throw new Error('Drive could not reserve a bookmark library.');
    const result = await readBoundedJson(response, 16 * 1024) as { ids?: unknown[] };
    if (!Array.isArray(result.ids) || result.ids.length !== 1 || !isDriveFileId(result.ids[0])) throw new Error('Drive returned an invalid bookmark location.');
    return result.ids[0];
  }

  async read(account: AccountSpaceId, fileId: string, signal?: AbortSignal): Promise<RemoteEncryptedBackup | undefined> {
    const response = await this.fetch(account, this.fileUrl(fileId) + '?alt=media', {}, signal);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error('Drive could not read the paired bookmark library.');
    const etag = response.headers.get('etag');
    if (!etag || etag.startsWith('W/') || etag.length > 512) throw new Error('Drive could not provide a safe bookmark revision.');
    return { bytes: await readBoundedBytes(response, 5_000_000), etag, fileId };
  }

  async create(account: AccountSpaceId, fileId: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    if (!isDriveFileId(fileId) || bytes.byteLength > 4_800_000) throw new Error('Invalid bookmark sync upload.');
    const boundary = 'private-browser-bookmarks-' + randomUUID();
    const metadata = { id: fileId, name: 'private-browser-bookmarks.encrypted', parents: ['appDataFolder'], mimeType: 'application/octet-stream' };
    const header = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const response = await this.fetch(account, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: Buffer.concat([header, bytes, footer]) }, signal);
    if (!response.ok && response.status !== 409) throw new Error('Drive could not create the bookmark library.');
    await response.body?.cancel().catch(() => undefined);
  }

  async save(account: AccountSpaceId, fileId: string, etag: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
    if (!etag || etag.startsWith('W/') || bytes.byteLength > 4_800_000) throw new Error('Invalid bookmark sync update.');
    const destination = this.fileUrl(fileId).replace('/drive/v3/', '/upload/drive/v3/') + '?uploadType=media&fields=id';
    const response = await this.fetch(account, destination, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream', 'If-Match': etag }, body: Buffer.from(bytes) }, signal);
    if (response.status === 412) throw new Error('Bookmarks changed on another device. Review sync again.');
    if (!response.ok) throw new Error('Drive could not save the paired bookmark library.');
    await response.body?.cancel().catch(() => undefined);
  }

  private async fetch(account: AccountSpaceId, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    return authorizeDriveAppData(this.request, url, await this.tokens.getAccessToken(account, 'encrypted-backup', signal), init, signal);
  }

  private fileUrl(id: string): string {
    if (!isDriveFileId(id)) throw new Error('Invalid paired bookmark location.');
    return 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id);
  }
}

async function authorizeDriveAppData(request: typeof fetch, url: string | URL, token: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.googleapis.com') throw new Error('Unexpected backup endpoint');
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    combined.throwIfAborted();
    return await request(parsed, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: combined,
      redirect: 'error',
    });
}

async function readBoundedBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maximum || !response.body) throw new Error('Encrypted backup exceeds its size limit');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maximum) { await reader.cancel(); throw new Error('Encrypted backup exceeds its size limit'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
