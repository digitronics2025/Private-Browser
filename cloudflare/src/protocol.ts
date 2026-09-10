export const APP_ID = 'private-browser';
export const DEFAULT_LINK_TTL_SECONDS = 15 * 60;
export const MAX_LINK_TTL_SECONDS = 24 * 60 * 60;

export interface ReleaseRecord {
  id: string;
  app_id: string;
  version: string;
  build_number: number;
  channel: 'stable' | 'beta';
  object_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  commit_sha: string;
  release_notes: string;
  published_at: string;
  is_active: number;
}

export interface ReleaseManifest {
  schemaVersion: 1;
  appId: typeof APP_ID;
  version: string;
  buildNumber: number;
  channel: 'stable' | 'beta';
  publishedAt: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  commitSha: string;
  releaseNotes: string;
  downloadUrl: string;
  downloadPageUrl: string;
  expiresAt: string;
}

export interface ReleaseInput {
  id?: string;
  version: string;
  buildNumber: number;
  channel?: 'stable' | 'beta';
  objectKey: string;
  filename: string;
  contentType?: string;
  sizeBytes: number;
  sha256: string;
  commitSha: string;
  releaseNotes?: string;
  publishedAt?: string;
}

export type ByteRange = { offset: number; length: number; start: number; end: number };

export function parseSingleRange(value: string | null, size: number): ByteRange | undefined | null {
  if (!value) return undefined;
  if (!Number.isSafeInteger(size) || size < 0 || !value.startsWith('bytes=') || value.includes(',')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (!startText && !endText) return null;

  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, length, start: size - length, end: size - 1 };
  }

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  const end = Math.min(requestedEnd, size - 1);
  return { offset: start, length: end - start + 1, start, end };
}

export function normalizeTtl(value: string | undefined): number {
  const parsed = Number(value ?? DEFAULT_LINK_TTL_SECONDS);
  if (!Number.isSafeInteger(parsed)) return DEFAULT_LINK_TTL_SECONDS;
  return Math.min(Math.max(parsed, 60), MAX_LINK_TTL_SECONDS);
}

export function validateReleaseInput(value: unknown): ReleaseInput {
  if (!value || typeof value !== 'object') throw new Error('Expected a JSON release object');
  const input = value as Record<string, unknown>;
  const version = requiredString(input.version, 'version', 40);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('version must be semantic');
  const buildNumber = input.buildNumber;
  if (!Number.isSafeInteger(buildNumber) || Number(buildNumber) < 1) throw new Error('buildNumber must be a positive integer');
  const channel = input.channel ?? 'stable';
  if (channel !== 'stable' && channel !== 'beta') throw new Error('channel must be stable or beta');
  const objectKey = requiredString(input.objectKey, 'objectKey', 500);
  if (!/^releases\/[A-Za-z0-9._/-]+$/.test(objectKey) || objectKey.includes('..')) throw new Error('objectKey must be under releases/');
  const filename = requiredString(input.filename, 'filename', 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*\.exe$/i.test(filename) || filename.includes('..')) throw new Error('filename must be a safe .exe name');
  const contentType = input.contentType === undefined ? 'application/vnd.microsoft.portable-executable' : requiredString(input.contentType, 'contentType', 100);
  if (contentType !== 'application/vnd.microsoft.portable-executable' && contentType !== 'application/octet-stream') throw new Error('contentType must describe a Windows executable');
  const sizeBytes = input.sizeBytes;
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 1) throw new Error('sizeBytes must be a positive integer');
  const sha256 = requiredString(input.sha256, 'sha256', 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('sha256 must be 64 hexadecimal characters');
  const commitSha = requiredString(input.commitSha, 'commitSha', 64);
  if (!/^[a-f0-9]{7,64}$/i.test(commitSha)) throw new Error('commitSha is invalid');
  const id = input.id === undefined ? undefined : requiredString(input.id, 'id', 100);
  if (id && !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('id is invalid');
  const releaseNotes = input.releaseNotes === undefined ? '' : requiredString(input.releaseNotes, 'releaseNotes', 10_000, true);
  const publishedAt = input.publishedAt === undefined ? undefined : requiredString(input.publishedAt, 'publishedAt', 50);
  if (publishedAt && !Number.isFinite(Date.parse(publishedAt))) throw new Error('publishedAt is invalid');
  return { id, version, buildNumber: Number(buildNumber), channel, objectKey, filename, contentType, sizeBytes: Number(sizeBytes), sha256, commitSha, releaseNotes, publishedAt };
}

function requiredString(value: unknown, field: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const result = value.trim();
  if ((!allowEmpty && !result) || result.length > max) throw new Error(`${field} is invalid`);
  return result;
}
