import { beforeEach, describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';
import { signValue } from '../src/auth';
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

/**
 * A fake that actually stores rows. The previous version discarded every bound
 * parameter and returned one hard-coded row for any query, so the publish write
 * path and all channel scoping were untested — audit finding F-09.
 */
class Statement {
  values: unknown[] = [];
  constructor(private readonly database: FakeDatabase, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }

  async first<T>() {
    if (this.sql.includes('SELECT object_key')) {
      const [appId] = this.values as [string];
      const row = this.database.active(appId);
      return (row ? { object_key: row.object_key } : null) as T | null;
    }
    // Both the latest-release read and the downgrade lookup bind (app_id, channel).
    const [appId, channel] = this.values as [string, string];
    return (this.database.active(appId, channel) ?? null) as T | null;
  }

  /** Interpret the two statements handlePublish batches, honouring bound values. */
  apply(): void {
    if (this.sql.includes('INSERT INTO releases')) {
      const [id, appId, version, buildNumber, channel, objectKey, filename, contentType, sizeBytes, sha256, commitSha, releaseNotes, publishedAt] =
        this.values as [string, string, string, number, 'stable' | 'beta', string, string, string, number, string, string, string, string];
      const row: ReleaseRecord = {
        id, app_id: appId, version, build_number: buildNumber, channel, object_key: objectKey,
        filename, content_type: contentType, size_bytes: sizeBytes, sha256, commit_sha: commitSha,
        release_notes: releaseNotes, published_at: publishedAt, is_active: 1,
      };
      const existing = this.database.rows.findIndex((candidate) => candidate.id === id);
      if (existing >= 0) this.database.rows[existing] = row;
      else this.database.rows.push(row);
      return;
    }
    if (this.sql.includes('UPDATE releases SET is_active')) {
      const [id, appId, channel] = this.values as [string, string, string];
      for (const row of this.database.rows) {
        if (row.app_id !== appId || row.channel !== channel) continue;
        row.is_active = row.id === id ? 1 : 0;
      }
    }
  }
}

class FakeDatabase {
  rows: ReleaseRecord[] = [{ ...release }];
  batches = 0;

  prepare(sql: string) { return new Statement(this, sql); }

  active(appId?: string, channel?: string): ReleaseRecord | null {
    return this.rows
      .filter((row) => row.is_active === 1
        && (appId === undefined || row.app_id === appId)
        && (channel === undefined || row.channel === channel))
      .sort((left, right) => right.build_number - left.build_number || right.published_at.localeCompare(left.published_at))[0] ?? null;
  }

  async batch(statements: Statement[]) {
    this.batches += 1;
    for (const statement of statements) statement.apply();
    return statements.map(() => ({ success: true }));
  }
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
    const html = await page.text();
    expect(html).toContain('Download and install');
    // This release's own details, not a hard-coded template string: the assertion
    // these replaced was `'X'.replace('X','Y')` and could not fail (F-09).
    expect(html).toContain(release.version);
    expect(html).toContain(release.sha256);
    expect(html).toContain(release.commit_sha.slice(0, 12));
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

  it('rejects tampered signed URLs', async () => {
    const item = await manifest();
    const url = new URL(item.downloadUrl);
    url.searchParams.set('signature', `${url.searchParams.get('signature')}x`);
    expect((await request(`${url.pathname}${url.search}`)).status).toBe(404);
  });

  it('rejects an expired link even when its signature is perfectly valid', async () => {
    const item = await manifest();
    const url = new URL(item.downloadUrl);
    // Re-sign for the stale expiry, so ONLY the expiry check can reject this.
    // Reusing the tampered signature from the test above would have passed even
    // with the expiry check deleted entirely — audit finding F-09.
    const expires = '1000000000';
    url.searchParams.set('expires', expires);
    url.searchParams.set('signature', await signValue(signingSecret, `binary
${release.id}
${expires}`));
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
    // Inspect the row that was actually written, not merely that a batch ran.
    const written = database.active('private-browser', 'stable');
    expect(written).toMatchObject({
      id: 'stable-0.3.0-3', version: '0.3.0', build_number: 3, channel: 'stable',
      object_key: release.object_key, filename: release.filename, sha256: release.sha256,
      commit_sha: release.commit_sha, size_bytes: bytes.byteLength, is_active: 1,
    });
    // Exactly one active release per channel.
    expect(database.rows.filter((row) => row.channel === 'stable' && row.is_active === 1)).toHaveLength(1);

    bucket.object = new Uint8Array(2);
    const mismatch = await request('/api/v1/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': adminKey }, body: JSON.stringify(input) });
    expect(mismatch.status).toBe(409);
    expect(database.batches).toBe(1);
  });

  it('refuses to publish for any credential that is not the administrator key', async () => {
    const input = {
      version: '9.9.9', buildNumber: 999, channel: 'stable', objectKey: release.object_key,
      filename: release.filename, sizeBytes: bytes.byteLength, sha256: release.sha256, commitSha: release.commit_sha,
    };
    const rejected: Record<string, string>[] = [
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', 'x-api-key': '' },
      { 'content-type': 'application/json', 'x-api-key': `${adminKey}x` },
      { 'content-type': 'application/json', 'x-api-key': adminKey.slice(0, -1) },
      // The client download token must not be accepted for publishing.
      { 'content-type': 'application/json', 'x-api-key': accessToken },
      // Nor an administrator key presented as a bearer token.
      { 'content-type': 'application/json', authorization: `Bearer ${adminKey}` },
    ];
    const unknownRoute = await request('/no-such-route');
    for (const headers of rejected) {
      const response = await request('/api/v1/admin/releases', { method: 'POST', headers, body: JSON.stringify(input) });
      expect(response.status).toBe(404);
      // Indistinguishable from an unknown route: no oracle for a guessing caller.
      expect(await response.text()).toBe(await unknownRoute.clone().text());
      // Nothing was written.
      expect(database.batches).toBe(0);
    }
  });

  it('refuses to publish when the administrator key is too weak to be real', async () => {
    env.ADMIN_API_KEY = 'short';
    const input = {
      version: '9.9.9', buildNumber: 999, channel: 'stable', objectKey: release.object_key,
      filename: release.filename, sizeBytes: bytes.byteLength, sha256: release.sha256, commitSha: release.commit_sha,
    };
    const response = await request('/api/v1/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'short' }, body: JSON.stringify(input) });
    expect(response.status).toBe(404);
    expect(database.batches).toBe(0);
  });

  it('refuses a new build at a version the client would never be offered', async () => {
    // The active release is 0.3.0. A fresh build at the same version gets a new
    // id but no client would ever see it, because the desktop check compares
    // versions only. Publishing it would put bytes in R2 that reach nobody.
    const input = {
      version: '0.3.0', buildNumber: 8, channel: 'stable', objectKey: release.object_key,
      filename: release.filename, sizeBytes: bytes.byteLength, sha256: release.sha256, commitSha: release.commit_sha,
    };
    const response = await request('/api/v1/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': adminKey }, body: JSON.stringify(input) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'release_version_not_bumped' });
    expect(database.batches).toBe(0);
  });

  it('refuses a lower version even when the build number climbs', async () => {
    // build_number is a CI run counter, so it always rises. Version must be
    // checked separately or a revert would publish an older app as latest.
    const input = {
      version: '0.2.0', buildNumber: 99, channel: 'stable', objectKey: release.object_key,
      filename: release.filename, sizeBytes: bytes.byteLength, sha256: release.sha256, commitSha: release.commit_sha,
    };
    const response = await request('/api/v1/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': adminKey }, body: JSON.stringify(input) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'release_version_not_bumped' });
    expect(database.batches).toBe(0);
  });

  it('accepts a genuine version bump', async () => {
    const input = {
      version: '0.3.1', buildNumber: 8, channel: 'stable', objectKey: release.object_key,
      filename: release.filename, sizeBytes: bytes.byteLength, sha256: release.sha256, commitSha: release.commit_sha,
    };
    const response = await request('/api/v1/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': adminKey }, body: JSON.stringify(input) });
    expect(response.status).toBe(201);
    expect(database.batches).toBe(1);
  });

  it('keeps channels separate', async () => {
    // The stable row must not satisfy a beta lookup, and publishing beta must not
    // disturb stable. Nothing exercised the channel dimension before.
    const input = {
      version: '0.4.0-beta.1', buildNumber: 10, channel: 'beta', objectKey: release.object_key,
      filename: release.filename, sizeBytes: bytes.byteLength, sha256: release.sha256, commitSha: release.commit_sha,
    };
    const response = await request('/api/v1/admin/releases', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': adminKey }, body: JSON.stringify(input) });
    expect(response.status).toBe(201);
    expect(database.active('private-browser', 'beta')).toMatchObject({ version: '0.4.0-beta.1', channel: 'beta' });
    // Stable is untouched, and /update.json still serves it.
    expect(database.active('private-browser', 'stable')).toMatchObject({ version: '0.3.0', is_active: 1 });
    const item = await manifest();
    expect(item.sha256).toBe('a'.repeat(64));
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
