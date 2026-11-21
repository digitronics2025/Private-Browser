import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probePublicRelease } from './release-status.mjs';

const origin = 'https://downloads.example.test';
const publishedAt = '2026-11-20T06:00:00.000Z';
const manifest = {
  version: '0.6.34', buildNumber: 221, commitSha: 'a'.repeat(40), publishedAt, sizeBytes: 200,
  downloadUrl: origin + '/download/latest.exe?signature=fixture',
};

function fixture(overrides = {}, range = { status: 206, headers: { 'content-range': 'bytes 0-1/200', 'content-length': '2' } }) {
  return async (value, options) => {
    const url = new URL(value);
    if (url.pathname === '/health') return Response.json({ status: 'ok', releaseReady: true });
    if (url.pathname === '/api/v1/releases/public/latest') return Response.json({ ...manifest, ...overrides });
    assert.equal(url.href, manifest.downloadUrl);
    assert.equal(options.headers.range, 'bytes=0-1');
    return new Response('MZ', range);
  };
}

test('reports the healthy installer without publishing its signed URL', async () => {
  const now = Date.parse('2026-11-20T07:30:00.000Z');
  const status = await probePublicRelease(origin, fixture(), now);
  assert.deepEqual(status, {
    version: '0.6.34', build: 221, commit: 'a'.repeat(40), manifestAgeHours: 1.5, publishedAt,
    releaseReady: true, rangeAvailable: true,
  });
});

test('reports a broken range or wrong active object size', async () => {
  const wrongSize = { status: 206, headers: { 'content-range': 'bytes 0-1/100', 'content-length': '2' } };
  assert.equal((await probePublicRelease(origin, fixture({}, wrongSize))).rangeAvailable, false);
  assert.equal((await probePublicRelease(origin, fixture({}, { status: 200 }))).rangeAvailable, false);
});

test('refuses an installer URL outside the configured public origin', async () => {
  await assert.rejects(probePublicRelease(origin, fixture({ downloadUrl: 'https://other.example.test/download/latest.exe' })), /does not match/);
});
