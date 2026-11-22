import { describe, expect, it } from 'vitest';
import { signValue, verifySignedValue, isLiveExpiry } from '../cloudflare/src/auth';
import { parseSingleRange, validateReleaseInput } from '../cloudflare/src/protocol';
import { DEVELOPER_PROFILE, renderDownloadPage } from '../cloudflare/src/page';
import { parsePublisherReceipt } from '../cloudflare/src/publisher-receipt.mjs';

const release = {
  id: 'stable-0.3.0-3', app_id: 'private-browser', version: '0.3.0', build_number: 3, channel: 'stable' as const,
  object_key: 'releases/0.3.0/setup.exe', filename: 'Private-Browser-0.3.0-Setup.exe',
  content_type: 'application/vnd.microsoft.portable-executable', size_bytes: 17_000_000,
  sha256: 'a'.repeat(64), commit_sha: 'abcdef1234567890', release_notes: '<safe & private>',
  published_at: '2026-09-10T00:00:00.000Z', is_active: 1,
};

describe('Cloudflare release protocol', () => {
  it('parses start, open-ended, and suffix ranges', () => {
    expect(parseSingleRange('bytes=0-99', 1000)).toEqual({ offset: 0, length: 100, start: 0, end: 99 });
    expect(parseSingleRange('bytes=900-', 1000)).toEqual({ offset: 900, length: 100, start: 900, end: 999 });
    expect(parseSingleRange('bytes=-50', 1000)).toEqual({ offset: 950, length: 50, start: 950, end: 999 });
    expect(parseSingleRange('bytes=1000-', 1000)).toBeNull();
    expect(parseSingleRange('bytes=0-1,4-5', 1000)).toBeNull();
  });

  it('creates and verifies HMAC signatures without accepting mutations', async () => {
    const signature = await signValue('a-secret-long-enough-for-testing', 'binary\nrelease\n2000000000');
    expect(await verifySignedValue('a-secret-long-enough-for-testing', 'binary\nrelease\n2000000000', signature)).toBe(true);
    expect(await verifySignedValue('a-secret-long-enough-for-testing', 'binary\nother\n2000000000', signature)).toBe(false);
  });

  it('enforces live, bounded expiries', () => {
    expect(isLiveExpiry('2000000100', 2_000_000_000)).toBe(true);
    expect(isLiveExpiry('1999999999', 2_000_000_000)).toBe(false);
    expect(isLiveExpiry('2000100000', 2_000_000_000)).toBe(false);
  });

  it('rejects unsafe metadata and validates release records', () => {
    expect(validateReleaseInput({ version: '0.3.0', buildNumber: 3, objectKey: 'releases/0.3.0/setup.exe', filename: 'setup.exe', sizeBytes: 10, sha256: 'b'.repeat(64), commitSha: 'abcdef1' }).channel).toBe('stable');
    expect(() => validateReleaseInput({ version: '0.3.0', buildNumber: 3, objectKey: '../secret', filename: 'setup.exe', sizeBytes: 10, sha256: 'b'.repeat(64), commitSha: 'abcdef1' })).toThrow(/objectKey/);
    expect(() => validateReleaseInput({ version: '0.3.0', buildNumber: 3, objectKey: 'releases/setup.exe', filename: 'setup.exe', contentType: 'text/html', sizeBytes: 10, sha256: 'b'.repeat(64), commitSha: 'abcdef1' })).toThrow(/contentType/);
  });

  it('escapes D1-controlled content in the download page', () => {
    const html = renderDownloadPage({
      release,
      history: [],
      downloadUrl: '/download?x=1&y=2',
      canonicalUrl: 'https://downloads.example.com/',
      renderedAt: '2026-09-12T00:00:00.000Z',
      developer: DEVELOPER_PROFILE,
    });
    expect(html).toContain('&lt;safe &amp; private&gt;');
    expect(html).toContain('/download?x=1&amp;y=2');
    expect(html).not.toContain('<safe & private>');
    expect(html).toContain('Publisher verification is unavailable for this release.');
  });

  it('shows only publisher evidence tied to the active installer on both download pages', async () => {
    const workerPath = '../cloudflare/src/index.ts';
    const { default: worker } = await import(workerPath) as { default: { fetch: (request: Request, env: unknown) => Promise<Response> } };
    const access = 'temporary-download-fixture-'.repeat(2);
    const prepared = { bind: () => prepared, first: async () => release, all: async () => ({ results: [] }) };
    let receipt = { schemaVersion: 1, sha256: release.sha256, status: 'verified', publisher: 'Publisher <Fixture>' };
    const requested: string[] = [];
    const env = {
      DB: { prepare: (sql: string) => sql.includes('FROM release_distribution')
        ? { first: async () => ({ mode: 'public' }) } : prepared },
      RELEASES: { get: async (key: string) => {
        requested.push(key);
        return { size: 300, json: async () => receipt };
      } },
      DOWNLOAD_ACCESS_TOKEN: access, SIGNING_SECRET: 'fixture-signing-'.repeat(3), ADMIN_API_KEY: 'fixture-admin-'.repeat(3),
    };
    const get = (path: string) => worker.fetch(new Request('https://downloads.example.test' + path), env);
    for (const path of ['/', '/download/' + access]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-publisher-status="verified"');
      expect(html).toContain('Publisher &lt;Fixture&gt;');
      expect(html).toContain('SHA-256 checksum');
      expect(html).toContain('The server checks the expiring link signature');
      expect(html).not.toContain(access);
    }
    expect(requested).toEqual(Array(2).fill(release.object_key + '.publisher.json'));
    expect((await get('/download/incorrect-private-token')).status).toBe(404);
    expect(requested).toHaveLength(2);
    receipt = { ...receipt, status: 'unsigned' };
    expect(await (await get('/')).text()).toContain('data-publisher-status="unsigned"');
    receipt = { ...receipt, sha256: 'b'.repeat(64) };
    expect(await (await get('/')).text()).toContain('data-publisher-status="unavailable"');
    expect(parsePublisherReceipt({ ...receipt, sha256: release.sha256, status: 'verified', publisher: 'invisible\u202efixture' }, release.sha256)).toBeUndefined();
  });
});
