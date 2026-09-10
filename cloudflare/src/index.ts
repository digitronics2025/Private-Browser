/// <reference types="@cloudflare/workers-types" />

import { constantTimeEqual, futureExpiry, isLiveExpiry, signValue, verifySignedValue } from './auth';
import { APP_ID, compareSemver, normalizeTtl, parseSingleRange, validateReleaseInput, type ReleaseManifest, type ReleaseRecord } from './protocol';
import { renderDownloadPage } from './page';

export interface Env {
  DB: D1Database;
  RELEASES: R2Bucket;
  DOWNLOAD_ACCESS_TOKEN: string;
  SIGNING_SECRET: string;
  ADMIN_API_KEY: string;
  LINK_TTL_SECONDS?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const PRIVATE_CACHE = 'private, no-store, max-age=0';

function responseHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-frame-options', 'DENY');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  return headers;
}

function json(value: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: responseHeaders({ ...JSON_HEADERS, ...extra }) });
}

function notFound(): Response {
  return json({ error: 'not_found' }, 404, { 'cache-control': PRIVATE_CACHE });
}

function methodNotAllowed(allow: string): Response {
  return json({ error: 'method_not_allowed' }, 405, { allow, 'cache-control': PRIVATE_CACHE });
}

function bearer(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}

async function isClientAuthorized(request: Request, env: Env): Promise<boolean> {
  return secretsReady(env) && constantTimeEqual(bearer(request), env.DOWNLOAD_ACCESS_TOKEN);
}

async function isAdminAuthorized(request: Request, env: Env): Promise<boolean> {
  return secretsReady(env) && constantTimeEqual(request.headers.get('x-api-key') ?? '', env.ADMIN_API_KEY);
}

function secretsReady(env: Env): boolean {
  return env.DOWNLOAD_ACCESS_TOKEN?.length >= 32 && env.SIGNING_SECRET?.length >= 32 && env.ADMIN_API_KEY?.length >= 32;
}

async function latestRelease(env: Env, channel = 'stable'): Promise<ReleaseRecord | null> {
  return env.DB.prepare(`SELECT id, app_id, version, build_number, channel, object_key, filename, content_type, size_bytes, sha256, commit_sha, release_notes, published_at, is_active
    FROM releases WHERE app_id = ?1 AND channel = ?2 AND is_active = 1
    ORDER BY build_number DESC, published_at DESC LIMIT 1`).bind(APP_ID, channel).first<ReleaseRecord>();
}

async function signedManifest(request: Request, env: Env, release: ReleaseRecord): Promise<ReleaseManifest> {
  const expires = futureExpiry(Date.now() / 1000, normalizeTtl(env.LINK_TTL_SECONDS));
  const origin = new URL(request.url).origin;
  const pageSignature = await signValue(env.SIGNING_SECRET, `page\n${expires}`);
  const binarySignature = await signValue(env.SIGNING_SECRET, `binary\n${release.id}\n${expires}`);
  return {
    schemaVersion: 1,
    appId: APP_ID,
    version: release.version,
    buildNumber: release.build_number,
    channel: release.channel,
    publishedAt: release.published_at,
    filename: release.filename,
    sizeBytes: release.size_bytes,
    sha256: release.sha256,
    commitSha: release.commit_sha,
    releaseNotes: release.release_notes,
    downloadUrl: `${origin}/download/latest.exe?expires=${expires}&signature=${binarySignature}`,
    downloadPageUrl: `${origin}/download?expires=${expires}&signature=${pageSignature}`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

async function handleLatest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
  if (!(await isClientAuthorized(request, env))) return notFound();
  const release = await latestRelease(env);
  if (!release) return notFound();
  const manifest = await signedManifest(request, env, release);
  const headers = { ...JSON_HEADERS, 'cache-control': PRIVATE_CACHE };
  return request.method === 'HEAD'
    ? new Response(null, { status: 200, headers: responseHeaders(headers) })
    : json(manifest, 200, { 'cache-control': PRIVATE_CACHE });
}

async function handleDownloadPage(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
  if (!secretsReady(env)) return notFound();
  const expires = url.searchParams.get('expires');
  const signature = url.searchParams.get('signature') ?? '';
  if (!isLiveExpiry(expires, Date.now() / 1000) || !(await verifySignedValue(env.SIGNING_SECRET, `page\n${expires}`, signature))) return notFound();
  const release = await latestRelease(env);
  if (!release) return notFound();
  const downloadSignature = await signValue(env.SIGNING_SECRET, `binary\n${release.id}\n${expires}`);
  const downloadUrl = `/download/latest.exe?expires=${expires}&signature=${downloadSignature}`;
  const html = renderDownloadPage(release, downloadUrl);
  const headers = responseHeaders({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': PRIVATE_CACHE,
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-robots-tag': 'noindex, nofollow, noarchive',
  });
  headers.set('content-length', String(new TextEncoder().encode(html).byteLength));
  return new Response(request.method === 'HEAD' ? null : html, { headers });
}

async function handleBinary(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET, HEAD');
  if (!secretsReady(env)) return notFound();
  const expires = url.searchParams.get('expires');
  const signature = url.searchParams.get('signature') ?? '';
  if (!isLiveExpiry(expires, Date.now() / 1000)) return notFound();
  const release = await latestRelease(env);
  if (!release || !(await verifySignedValue(env.SIGNING_SECRET, `binary\n${release.id}\n${expires}`, signature))) return notFound();

  const objectHead = await env.RELEASES.head(release.object_key);
  if (!objectHead || objectHead.size !== release.size_bytes) return notFound();
  const range = parseSingleRange(request.headers.get('range'), objectHead.size);
  if (range === null) {
    return new Response(null, { status: 416, headers: responseHeaders({
      'accept-ranges': 'bytes',
      'content-range': `bytes */${objectHead.size}`,
      'cache-control': PRIVATE_CACHE,
    }) });
  }

  const headers = responseHeaders({
    'accept-ranges': 'bytes',
    'cache-control': PRIVATE_CACHE,
    'content-type': release.content_type,
    'content-disposition': `attachment; filename="${release.filename.replace(/["\\\r\n]/g, '_')}"`,
    etag: objectHead.httpEtag,
    'x-checksum-sha256': release.sha256,
  });
  if (range) {
    headers.set('content-range', `bytes ${range.start}-${range.end}/${objectHead.size}`);
    headers.set('content-length', String(range.length));
  } else {
    headers.set('content-length', String(objectHead.size));
  }
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });

  const object = await env.RELEASES.get(release.object_key, range ? { range: { offset: range.offset, length: range.length } } : undefined);
  if (!object || !('body' in object)) return notFound();
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

async function handlePublish(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed('POST');
  if (!(await isAdminAuthorized(request, env))) return notFound();
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return json({ error: 'unsupported_media_type' }, 415);
  let input;
  try {
    const body = await request.json();
    input = validateReleaseInput(body);
  } catch (error) {
    return json({ error: 'invalid_release', detail: error instanceof Error ? error.message : 'Invalid JSON' }, 400, { 'cache-control': PRIVATE_CACHE });
  }
  const object = await env.RELEASES.head(input.objectKey);
  if (!object || object.size !== input.sizeBytes) return json({ error: 'r2_object_missing_or_size_mismatch' }, 409, { 'cache-control': PRIVATE_CACHE });
  const id = input.id ?? `${input.channel}-${input.version}-${input.buildNumber}`;
  const publishedAt = input.publishedAt ? new Date(input.publishedAt).toISOString() : new Date().toISOString();
  const current = await env.DB.prepare('SELECT id, version, build_number FROM releases WHERE app_id = ?1 AND channel = ?2 AND is_active = 1 ORDER BY build_number DESC LIMIT 1').bind(APP_ID, input.channel).first<{ id: string; version: string; build_number: number }>();
  if (current && (current.build_number > input.buildNumber || (current.build_number === input.buildNumber && (current.id !== id || current.version !== input.version)))) {
    return json({ error: 'release_downgrade_rejected' }, 409, { 'cache-control': PRIVATE_CACHE });
  }
  // The desktop client decides whether an update exists on the version alone, so
  // a new release at an equal or lower version would sit in R2 and D1 and be
  // offered to nobody. Refuse it here rather than publish something unreachable.
  if (current && current.id !== id && compareSemver(input.version, current.version) <= 0) {
    return json({
      error: 'release_version_not_bumped',
      detail: `active release is ${current.version}; bump the version before publishing`,
    }, 409, { 'cache-control': PRIVATE_CACHE });
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO releases (id, app_id, version, build_number, channel, object_key, filename, content_type, size_bytes, sha256, commit_sha, release_notes, published_at, is_active)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 1)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, build_number = excluded.build_number, channel = excluded.channel,
        object_key = excluded.object_key, filename = excluded.filename, content_type = excluded.content_type, size_bytes = excluded.size_bytes,
        sha256 = excluded.sha256, commit_sha = excluded.commit_sha, release_notes = excluded.release_notes,
        published_at = excluded.published_at, is_active = 1`)
      .bind(id, APP_ID, input.version, input.buildNumber, input.channel, input.objectKey, input.filename, input.contentType, input.sizeBytes, input.sha256, input.commitSha, input.releaseNotes, publishedAt),
    env.DB.prepare('UPDATE releases SET is_active = CASE WHEN id = ?1 THEN 1 ELSE 0 END WHERE app_id = ?2 AND channel = ?3').bind(id, APP_ID, input.channel),
  ]);
  return json({ ok: true, id, version: input.version, buildNumber: input.buildNumber }, 201, { 'cache-control': PRIVATE_CACHE });
}

async function handleHealth(request: Request, env: Env): Promise<Response> {
  if (!secretsReady(env)) return json({ status: 'degraded', service: 'private-browser-downloads' }, 503, { 'cache-control': 'no-store' });
  try {
    const row = await env.DB.prepare('SELECT object_key FROM releases WHERE app_id = ?1 AND is_active = 1 ORDER BY build_number DESC LIMIT 1').bind(APP_ID).first<{ object_key: string }>();
    const objectReady = row ? Boolean(await env.RELEASES.head(row.object_key)) : false;
    const body = { status: 'ok', service: 'private-browser-downloads', database: 'ok', releaseReady: objectReady };
    return request.method === 'HEAD'
      ? new Response(null, { status: 200, headers: responseHeaders({ ...JSON_HEADERS, 'cache-control': 'no-store' }) })
      : json(body, 200, { 'cache-control': 'no-store' });
  } catch {
    return json({ status: 'degraded', service: 'private-browser-downloads' }, 503, { 'cache-control': 'no-store' });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') return request.method === 'GET' || request.method === 'HEAD' ? handleHealth(request, env) : methodNotAllowed('GET, HEAD');
      if (url.pathname === '/api/v1/releases/latest' || url.pathname === '/update.json') return handleLatest(request, env);
      if (url.pathname === '/api/v1/admin/releases') return handlePublish(request, env);
      if (url.pathname === '/download') return handleDownloadPage(request, env, url);
      if (url.pathname === '/download/latest.exe') return handleBinary(request, env, url);
      return notFound();
    } catch (error) {
      console.error('request_failed', { path: url.pathname, message: error instanceof Error ? error.message : 'unknown' });
      return json({ error: 'internal_error' }, 500, { 'cache-control': PRIVATE_CACHE });
    }
  },
} satisfies ExportedHandler<Env>;
