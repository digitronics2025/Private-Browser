import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { requireHttpsEndpoint } from './require-https-endpoint.mjs';

const [installerPath] = process.argv.slice(2);
const endpoint = requireHttpsEndpoint(process.env.PRIVATE_BROWSER_DOWNLOAD_URL);
const accessToken = process.env.PRIVATE_BROWSER_DOWNLOAD_TOKEN;
if (!installerPath || !endpoint || !accessToken) throw new Error('Live release verification is not configured');

const expectedSize = statSync(installerPath).size;
const expectedHash = await hashFile(installerPath);
const expectedFilename = basename(installerPath);

await expectStatus(`${endpoint}/update.json`, 404);
await expectStatus(`${endpoint}/update.json`, 404, { authorization: 'Bearer invalid-test-token' });
const manifestResponse = await fetch(`${endpoint}/update.json`, {
  headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  redirect: 'error',
  signal: AbortSignal.timeout(30_000),
});
assert(manifestResponse.status === 200, `Authenticated manifest returned ${manifestResponse.status}`);
const manifest = await manifestResponse.json();
assert(manifest.filename === expectedFilename, 'Manifest filename does not match the installer');
assert(manifest.sizeBytes === expectedSize, 'Manifest size does not match the installer');
assert(manifest.sha256 === expectedHash, 'Manifest checksum does not match the installer');

const pageResponse = await fetch(manifest.downloadPageUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
assert(pageResponse.status === 200, `Signed download page returned ${pageResponse.status}`);
const page = await pageResponse.text();
assert(page.includes(manifest.version) && page.includes(expectedHash), 'Download page metadata is incomplete');

const stablePageResponse = await fetch(`${endpoint}/download/${encodeURIComponent(accessToken)}`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
assert(stablePageResponse.status === 200, `Stable install page returned ${stablePageResponse.status}`);
const stablePage = await stablePageResponse.text();
assert(stablePage.includes('Download and install') && stablePage.includes(expectedHash), 'Stable install page metadata is incomplete');
assert(!stablePage.includes(accessToken), 'Stable install page exposed its access token');
await expectStatus(`${endpoint}/download/invalid-private-browser-token-000000`, 404);

const head = await fetch(manifest.downloadUrl, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(30_000) });
assert(head.status === 200, `Installer HEAD returned ${head.status}`);
assert(Number(head.headers.get('content-length')) === expectedSize, 'Installer HEAD size is incorrect');
assert(head.headers.get('accept-ranges') === 'bytes', 'Installer does not advertise byte ranges');
assert(head.headers.get('content-type') === 'application/vnd.microsoft.portable-executable', 'Installer content type is incorrect');
assert(head.headers.get('x-checksum-sha256') === expectedHash, 'Installer checksum header is incorrect');

await expectRange(manifest.downloadUrl, 'bytes=0-99', 0, 99, expectedSize);
await expectRange(manifest.downloadUrl, `bytes=${expectedSize - 128}-`, expectedSize - 128, expectedSize - 1, expectedSize);
await expectRange(manifest.downloadUrl, 'bytes=-128', expectedSize - 128, expectedSize - 1, expectedSize);
const unsatisfied = await fetch(manifest.downloadUrl, { headers: { range: `bytes=${expectedSize}-` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
assert(unsatisfied.status === 416 && unsatisfied.headers.get('content-range') === `bytes */${expectedSize}`, 'Unsatisfied range response is incorrect');

const fullResponse = await fetch(manifest.downloadUrl, { redirect: 'error', signal: AbortSignal.timeout(180_000) });
assert(fullResponse.status === 200, `Full installer download returned ${fullResponse.status}`);
const full = await hashBody(fullResponse);
assert(full.size === expectedSize && full.sha256 === expectedHash, 'Full installer download checksum failed');

const midpoint = Math.floor(expectedSize / 2);
const resumedHash = createHash('sha256');
let resumedSize = 0;
for (const [start, end] of [[0, midpoint - 1], [midpoint, expectedSize - 1]]) {
  const response = await fetch(manifest.downloadUrl, { headers: { range: `bytes=${start}-${end}` }, redirect: 'error', signal: AbortSignal.timeout(180_000) });
  assert(response.status === 206, `Resumed download range returned ${response.status}`);
  assert(response.body, 'Resumed download response has no body');
  for await (const chunk of response.body) {
    resumedHash.update(chunk);
    resumedSize += chunk.byteLength;
  }
}
assert(resumedSize === expectedSize && resumedHash.digest('hex') === expectedHash, 'Resumed installer download checksum failed');

const tampered = new URL(manifest.downloadUrl);
const signature = tampered.searchParams.get('signature') ?? '';
tampered.searchParams.set('signature', `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`);
await expectStatus(tampered, 404);
const expired = new URL(manifest.downloadUrl);
expired.searchParams.set('expires', '1000000000');
await expectStatus(expired, 404);

process.stdout.write(`${JSON.stringify({ ok: true, version: manifest.version, buildNumber: manifest.buildNumber, filename: expectedFilename, sizeBytes: expectedSize, sha256: expectedHash })}\n`);

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function hashBody(response) {
  assert(response.body, 'Download response has no body');
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { size, sha256: hash.digest('hex') };
}

async function expectRange(url, range, start, end, size) {
  const response = await fetch(url, { headers: { range }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert(response.status === 206, `${range} returned ${response.status}`);
  assert(response.headers.get('content-range') === `bytes ${start}-${end}/${size}`, `${range} returned the wrong content range`);
  const body = await response.arrayBuffer();
  assert(body.byteLength === end - start + 1, `${range} returned the wrong number of bytes`);
}

async function expectStatus(url, status, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  assert(response.status === status, `${new URL(url).pathname} returned ${response.status}, expected ${status}`);
}

/**
 * @param {unknown} condition
 * @param {string} message
 * @returns {asserts condition}
 */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
