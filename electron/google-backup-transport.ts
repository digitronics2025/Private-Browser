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
    listUrl.search = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '2', fields: 'files(id,name)', q: `name = '${BACKUP_FILENAME}' and trashed = false` }).toString();
    const listedResponse = await this.authorizedFetch(listUrl, token, {}, signal);
    if (!listedResponse.ok) throw new Error('Encrypted backup lookup failed');
    const listed = await readBoundedJson(listedResponse, 64 * 1024) as { files?: Array<{ id?: unknown; name?: unknown }> };
    const file = listed.files?.find((item) => item.name === BACKUP_FILENAME && typeof item.id === 'string');
    if (!file || typeof file.id !== 'string') return undefined;
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
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'www.googleapis.com') throw new Error('Unexpected backup endpoint');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await this.request(parsed, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
    }
  }
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
