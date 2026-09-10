import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';
import type { ReleaseRecord } from '../src/protocol';

const accessToken = 'download-token-abcdefghijklmnopqrstuvwxyz012345';
const signingSecret = 'signing-secret-abcdefghijklmnopqrstuvwxyz012345';
const adminKey = 'admin-secret-abcdefghijklmnopqrstuvwxyz012345';
const bytes = new TextEncoder().encode('0123456789abcdef');

const release: ReleaseRecord = {
  id: 'stable-0.3.0-3', app_id: 'private-browser', version: '0.3.0', build_number: 3, channel: 'stable',
  object_key: 'releases/0.3.0/setup.exe', filename: 'Private-Browser-0.3.0-Setup.exe',
  content_type: 'application/vnd.microsoft.portable-executable', size_bytes: bytes.byteLength,
  sha256: 'a'.repeat(64), commit_sha: 'abcdef1234567890', release_notes: 'Stable release',
  published_at: '2026-09-10T00:00:00.000Z', is_active: 1,
};

class Statement {
  values: unknown[] = [];
  constructor(private readonly database: FakeDatabase, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>() {
    if (this.sql.includes('SELECT object_key')) return (this.database.release ? { object_key: this.database.release.object_key } : null) as T | null;
    return this.database.release as T | null;
  }
}

class FakeDatabase {
  release: ReleaseRecord | null = { ...release };
  batches = 0;
  prepare(sql: string) { return new Statement(this, sql); }
  async batch(statements: Statement[]) { this.batches += 1; return statements.map(() => ({ success: true })); }
}

class FakeBucket {
  object = bytes;
  async head(key: string) {
    if (key !== release.object_key) return null;
    return { size: this.object.byteLength, httpEtag: '"test-etag"' };
  }
  async get(key: string, options?: { range?: { offset: number; length: number } }) {
    if (key !== release.object_key) return null;
    const range = options?.range;
    const body = range ? this.object.slice(range.offset, range.offset + range.length) : this.object;
    return { size: this.object.byteLength, httpEtag: '"test-etag"', body: new Blob([body]).stream() };
  }
}

let database: FakeDatabase;
let bucket: FakeBucket;
let env: Env;

beforeEach(() => {
  database = new FakeDatabase();
  bucket = new FakeBucket();
  env = { DB: database as unknown as D1Database, RELEASES: bucket as unknown as R2Bucket, DOWNLOAD_ACCESS_TOKEN: accessToken, SIGNING_SECRET: signingSecret, ADMIN_API_KEY: adminKey, LINK_TTL_SECONDS: '900' };
});

async function request(path: string, init?: RequestInit) {
  return worker.fetch(new Request(`https://downloads.example.com${path}`, init), env);
}

async function manifest() {
  const response = await request('/update.json', { headers: { authorization: `Bearer ${accessToken}` } });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ downloadUrl: string; downloadPageUrl: string; sha256: string }>;
}

describe('download Worker', () => {
  it('makes rejected credentials indistinguishable from missing routes', async () => {
    const wrong = await request('/update.json', { headers: { authorization: 'Bearer wrong' } });
    const missing = await request('/not-here');
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).toBe(await missing.text());
  });

  it('fails closed when deployment secrets are weak or missing', async () => {
    env.SIGNING_SECRET = 'weak';
    expect((await request('/update.json', { headers: { authorization: `Bearer ${accessToken}` } })).status).toBe(404);
    expect((await request('/health')).status).toBe(503);
  });

  it('returns a private signed manifest and branded download page', async () => {
    const item = await manifest();
    expect(item.sha256).toBe('a'.repeat(64));
    const page = await fetchSigned(item.downloadPageUrl);
    expect(page.status).toBe(200);
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
    expect(await page.text()).toContain('Download and install');
  });

  it('serves a stable tokenized install page without exposing the token', async () => {
    const page = await request(`/download/${accessToken}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toContain('no-store');
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
    const html = await page.text();
    expect(html).toContain('Download and install');
    expect(html).toContain('Build number');
    expect(html).toContain('Stable release');
    expect(html).toMatch(/\/download\/latest\.exe\?expires=\d+&amp;signature=/);
    expect(html).not.toContain(accessToken);

    const head = await request(`/download/${accessToken}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('hides stable install pages with missing or incorrect tokens', async () => {
    expect((await request('/download/wrong-token-that-is-long-enough-000000')).status).toBe(404);
    expect((await request('/download/')).status).toBe(404);
  });

  it('serves full, HEAD, open, closed and suffix byte ranges', async () => {
    const item = await manifest();
    const url = new URL(item.downloadUrl);
    const full = await request(`${url.pathname}${url.search}`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(await full.text()).toBe('0123456789abcdef');

    const head = await request(`${url.pathname}${url.search}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('16');
    expect(await head.text()).toBe('');

    for (const [range, expected, contentRange] of [
      ['bytes=0-3', '0123', 'bytes 0-3/16'],
      ['bytes=12-', 'cdef', 'bytes 12-15/16'],
      ['bytes=-4', 'cdef', 'bytes 12-15/16'],
    ]) {
      const response = await request(`${url.pathname}${url.search}`, { headers: { range } });
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(contentRange);
      expect(await response.text()).toBe(expected);
    }

    const pastEnd = await request(`${url.pathname}${url.search}`, { headers: { range: 'bytes=16-' } });
    expect(pastEnd.status).toBe(416);
    expect(pastEnd.headers.get('content-range')).toBe('bytes */16');
  });

  it('rejects tampered and expired signed URLs', async () => {
    const item = await manifest();
    const url = new URL(item.downloadUrl);
    url.searchParams.set('signature', `${url.searchParams.get('signature')}x`);
    expect((await request(`${url.pathname}${url.search}`)).status).toBe(404);
    url.searchParams.set('expires', '1000000000');
    expect((await request(`${url.pathname}${url.search}`)).status).toBe(404);
  });

  it('publishes metadata only after the R2 object is present and sized correctly', async () => {
    const input = {
      version: '0.3.0', buildNumber: 3, channel: 'stable', objectKey: release.object_key,
      filename: release.filename, sizeBytes: bytes.byteLength, sha256: release.sha256, commitSha: release.commit_sha,
    };
    const response = await request('/api/v1/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': adminKey }, body: JSON.stringify(input) });
    expect(response.status).toBe(201);
    expect(database.batches).toBe(1);

    bucket.object = new Uint8Array(2);
    const mismatch = await request('/api/v1/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': adminKey }, body: JSON.stringify(input) });
    expect(mismatch.status).toBe(409);
    expect(database.batches).toBe(1);
  });

  it('rejects a release build-number downgrade', async () => {
    const input = {
      version: '0.2.9', buildNumber: 2, channel: 'stable', objectKey: release.object_key,
      filename: release.filename, sizeBytes: bytes.byteLength, sha256: release.sha256, commitSha: release.commit_sha,
    };
    const response = await request('/api/v1/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': adminKey }, body: JSON.stringify(input) });
    expect(response.status).toBe(409);
    expect(database.batches).toBe(0);
  });
});

function fetchSigned(value: string): Promise<Response> {
  const url = new URL(value);
  return request(`${url.pathname}${url.search}`);
}
