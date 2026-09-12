import { describe, expect, it } from 'vitest';
import { signValue, verifySignedValue, isLiveExpiry } from '../cloudflare/src/auth';
import { parseSingleRange, validateReleaseInput } from '../cloudflare/src/protocol';
import { DEVELOPER_PROFILE, renderDownloadPage } from '../cloudflare/src/page';

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
  });
});
