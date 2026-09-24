import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes, webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlCenterLink, identityFingerprint, isLoopbackControlCenterUrl, verifyStatement, type SealedStorage } from '../electron/control-center-link';

/**
 * The Control Center link (docs/systems/control-center-link.md). The vectors
 * file is byte-identical to the Control Center's
 * apps/orchestrator/test/fixtures/acc-connected-app-v1.vectors.json; a fake
 * Control Center signs with that test key.
 */

const vectors = JSON.parse(readFileSync(new URL('./fixtures/acc-connected-app-v1.vectors.json', import.meta.url), 'utf8'));
const IDENTITY = vectors.identity.publicKey as string;
const subtle = webcrypto.subtle;
const enc = new TextEncoder();

/** Stands in for Electron safeStorage; reversible on purpose. */
const storage = (available = true): SealedStorage => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`sealed:${Buffer.from(text).toString('base64')}`),
  decryptString: (buffer) => {
    const text = buffer.toString();
    if (!text.startsWith('sealed:')) throw new Error('not sealed');
    return Buffer.from(text.slice(7), 'base64').toString();
  },
});

interface FakeOptions {
  signingJwk?: webcrypto.JsonWebKey;
  identityKey?: string;
  onTask?: (body: any) => { status: number; body: unknown };
  redirect?: boolean;
  hugeBody?: boolean;
  revoked?: boolean;
}

/** A Control Center that signs statements with the vectors key, or a program pretending to be one. */
function fakeControlCenter(options: FakeOptions = {}) {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string>; redirect?: RequestRedirect }> = [];
  const appId = 'fake-app-000000000001';
  const token = randomBytes(32).toString('base64url');
  const sign = async (purpose: string, nonce: string) => {
    const key = await subtle.importKey('jwk', options.signingJwk ?? vectors.identity.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return Buffer.from(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`acc-connected-app-v1 ${purpose}\n${appId}\n${nonce}`))).toString('base64url');
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: String(init.method), body, headers: (init.headers ?? {}) as Record<string, string>, redirect: init.redirect });
    if (options.redirect) {
      if (init.redirect === 'error') throw new TypeError('redirect refused');
      return json(200, {});
    }
    if (options.hugeBody) return new Response('x'.repeat(300 * 1024), { status: 200 });
    const path = new URL(url).pathname;
    const authed = (init.headers as Record<string, string> | undefined)?.authorization === `Bearer ${token}`;
    if (path === '/api/connected-app/pair') return json(201, { appId, token, identityKey: options.identityKey ?? IDENTITY, signature: await sign('pair', body.nonce), kind: 'private-browser' });
    if (path === '/api/connected-app/hello') return json(200, { appId: body.appId, identityKey: options.identityKey ?? IDENTITY, signature: await sign('hello', body.nonce) });
    if (options.revoked || !authed) return json(401, { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid app token.' } });
    if (path === '/api/connected-app/repositories') return json(200, [{ id: 'r1', name: 'shop', devOrigin: 'http://127.0.0.1:5173' }, { id: 'r2', name: 'site', devOrigin: null }]);
    if (path === '/api/connected-app/tasks' && init.method === 'POST') {
      const custom = options.onTask?.(body);
      if (custom) return json(custom.status, custom.body);
      return json(201, task('TASK-0007'));
    }
    if (path === '/api/connected-app/tasks') return json(200, [task('TASK-0007')]);
    if (/\/evidence$/.test(path)) return json(201, { artifactId: 'a1', name: 'browser-recheck-1.md', created: true });
    return json(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
  }) as typeof fetch;
  return { fetcher, calls, token };
}

const task = (id: string) => ({ id, title: 'Cart crashes', repositoryName: 'shop', status: 'RUNNING', currentStageName: 'Plan', blocker: null, finalStatus: null, createdAt: '2026-09-24T10:00:00.000Z', updatedAt: '2026-09-24T10:00:01.000Z', dashboardPath: `/tasks/${id}` });

function harness(options: FakeOptions = {}, runtime?: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-cc-link-'));
  const runtimeFile = join(dir, 'runtime.json');
  if (runtime !== undefined) writeFileSync(runtimeFile, JSON.stringify(runtime));
  const fake = fakeControlCenter(options);
  const filePath = join(dir, 'control-center-link.enc');
  const make = () => new ControlCenterLink({ filePath, storage: storage(), runtimeFile, fetch: fake.fetcher });
  return { dir, filePath, fake, make, link: make() };
}

describe('Control Center statements', () => {
  it('verifies the committed vectors and refuses a changed field', async () => {
    for (const s of vectors.statements) expect(await verifyStatement({ ...s, identityKey: IDENTITY })).toBe(true);
    const [pair] = vectors.statements;
    expect(await verifyStatement({ ...pair, purpose: 'hello', identityKey: IDENTITY })).toBe(false);
    expect(await verifyStatement({ ...pair, nonce: 'vector-nonce-00000000009', identityKey: IDENTITY })).toBe(false);
    expect(await verifyStatement({ ...pair, identityKey: IDENTITY, signature: 'garbage!' })).toBe(false);
    expect(await identityFingerprint(IDENTITY)).toMatch(/^([0-9A-F]{4} ){7}[0-9A-F]{4}$/);
  });

  it('accepts only an http loopback address', () => {
    expect(isLoopbackControlCenterUrl('http://127.0.0.1:4317')).toBe(true);
    expect(isLoopbackControlCenterUrl('http://localhost:4317/')).toBe(true);
    for (const bad of ['https://127.0.0.1:4317', 'http://192.168.1.5:4317', 'http://evil.example', 'http://user:pw@127.0.0.1:4317', 'file:///C:/x', 42, null]) {
      expect(isLoopbackControlCenterUrl(bad), String(bad)).toBe(false);
    }
  });
});

describe('Control Center link', () => {
  it('pairs, pins the key, keeps the token sealed and out of status', async () => {
    const h = harness({}, { url: 'http://127.0.0.1:4999', port: 4999, pid: 1 });
    expect((await h.link.status()).state).toBe('not-paired');
    const status = await h.link.pair('12345678');
    expect(status).toMatchObject({ state: 'connected', url: 'http://127.0.0.1:4999', fingerprint: await identityFingerprint(IDENTITY) });
    expect(JSON.stringify(status)).not.toContain(h.fake.token);
    const onDisk = readFileSync(h.filePath, 'utf8');
    expect(onDisk).not.toContain(h.fake.token);
    // A fresh process reads the sealed file back and proves the key again.
    const again = h.make();
    expect((await again.status()).state).toBe('connected');
    // Every hello goes out without the token.
    expect(h.fake.calls.filter((c) => c.url.endsWith('/hello')).every((c) => !('authorization' in c.headers))).toBe(true);
    expect(h.fake.calls.every((c) => c.redirect === 'error' && c.url.startsWith('http://127.0.0.1:4999/'))).toBe(true);
    expect(h.fake.calls.some((c) => 'origin' in c.headers)).toBe(false);
  });

  it('falls back to the default port when runtime.json names anything but loopback', async () => {
    const h = harness({}, { url: 'http://attacker.example:4317' });
    expect(h.link.baseUrl()).toBe('http://127.0.0.1:4317');
    await h.link.pair('12345678');
    expect(h.fake.calls[0]!.url.startsWith('http://127.0.0.1:4317/')).toBe(true);
  });

  it('refuses a pairing the key did not sign, and saves nothing', async () => {
    const other = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const h = harness({ signingJwk: await subtle.exportKey('jwk', other.privateKey) });
    await expect(h.link.pair('12345678')).rejects.toMatchObject({ code: 'IDENTITY_CHANGED' });
    expect(existsSync(h.filePath)).toBe(false);
    await expect(h.link.pair('1234')).rejects.toMatchObject({ code: 'REJECTED' });
  });

  it('sends nothing when the program on the port does not hold the pinned key', async () => {
    const h = harness();
    await h.link.pair('12345678');
    const squatterKey = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
    const squatter = fakeControlCenter({ signingJwk: await subtle.exportKey('jwk', squatterKey.privateKey), identityKey: Buffer.from(await subtle.exportKey('raw', squatterKey.publicKey)).toString('base64url') });
    const link = new ControlCenterLink({ filePath: h.filePath, storage: storage(), runtimeFile: null, fetch: squatter.fetcher });
    const status = await link.status();
    expect(status.state).toBe('identity-changed');
    await expect(link.createTask({ repositoryId: 'r1', note: 'x', sourceUrl: 'http://127.0.0.1:5173/', pageOrigin: null, evidence: '{}' })).rejects.toBeTruthy();
    expect(squatter.calls.some((c) => c.url.endsWith('/api/connected-app/tasks'))).toBe(false);
    // The squatter never saw the token, in any request.
    const pairedToken = h.fake.token;
    expect(JSON.stringify(squatter.calls)).not.toContain(pairedToken);
    expect(existsSync(h.filePath)).toBe(true);
  });

  it('suggests a repository by the page origin, then by the last choice for that origin', async () => {
    const h = harness();
    await h.link.pair('12345678');
    expect((await h.link.repositories('http://127.0.0.1:5173')).suggestedId).toBe('r1');
    expect((await h.link.repositories('https://example.com')).suggestedId).toBeNull();
    await h.link.createTask({ repositoryId: 'r2', note: 'Fix', sourceUrl: 'https://example.com/a', pageOrigin: 'https://example.com', evidence: '{}' });
    expect((await h.link.repositories('https://example.com')).suggestedId).toBe('r2');
    expect((await h.make().repositories('https://example.com')).suggestedId).toBe('r2');
  });

  it('retries a lost answer with the same request id, never a new one', async () => {
    let attempts = 0;
    const h = harness({
      onTask: () => {
        attempts += 1;
        return attempts === 1 ? { status: 201, body: task('TASK-0008') } : { status: 200, body: task('TASK-0008') };
      },
    });
    await h.link.pair('12345678');
    const original = h.fake.fetcher;
    let dropped = false;
    // First POST reaches the server but its answer is lost.
    (h.link as any).fetcher = (async (url: string, init: RequestInit) => {
      const response = await original(url, init);
      if (!dropped && String(url).endsWith('/api/connected-app/tasks') && init.method === 'POST') {
        dropped = true;
        throw new TypeError('socket hang up');
      }
      return response;
    }) as typeof fetch;
    const created = await h.link.createTask({ repositoryId: 'r1', note: 'Fix', sourceUrl: 'http://127.0.0.1:5173/', pageOrigin: null, evidence: '{}' });
    expect(created).toMatchObject({ id: 'TASK-0008', dashboardUrl: 'http://127.0.0.1:4317/tasks/TASK-0008' });
    const posts = h.fake.calls.filter((c) => c.url.endsWith('/api/connected-app/tasks') && c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body.requestId).toBe(posts[1]!.body.requestId);
  });

  it('refuses redirects and oversized answers', async () => {
    const redirected = harness({ redirect: true });
    await expect(redirected.link.pair('12345678')).rejects.toMatchObject({ code: 'UNREACHABLE' });
    const huge = harness({ hugeBody: true });
    await expect(huge.link.pair('12345678')).rejects.toMatchObject({ code: 'REJECTED' });
  });

  it('shows its tasks and attaches re-check evidence', async () => {
    const h = harness();
    await h.link.pair('12345678');
    expect((await h.link.tasks()).map((t) => t.id)).toEqual(['TASK-0007']);
    expect(await h.link.addEvidence('TASK-0007', '{"console":[]}')).toEqual({ name: 'browser-recheck-1.md' });
    await expect(h.link.addEvidence('../x', '{}')).rejects.toMatchObject({ code: 'REJECTED' });
  });

  it('forgets the token when the proven Control Center disconnects this browser', async () => {
    const h = harness();
    await h.link.pair('12345678');
    (h.link as any).fetcher = fakeControlCenter({ revoked: true }).fetcher;
    await expect(h.link.tasks()).rejects.toMatchObject({ code: 'NOT_PAIRED' });
    expect(existsSync(h.filePath)).toBe(false);
    expect((await h.link.status()).state).toBe('not-paired');
  });

  it('moves an unreadable link file aside and reports it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-cc-link-bad-'));
    const filePath = join(dir, 'control-center-link.enc');
    writeFileSync(filePath, 'not sealed at all');
    const link = new ControlCenterLink({ filePath, storage: storage(), runtimeFile: null, fetch: fakeControlCenter().fetcher });
    expect((await link.status()).state).toBe('unavailable');
    expect(existsSync(filePath)).toBe(false);
    expect(readdirSync(dir).some((f) => f.startsWith('control-center-link.enc.corrupt-'))).toBe(true);
    const unavailable = new ControlCenterLink({ filePath: join(dir, 'other.enc'), storage: storage(false), runtimeFile: null });
    expect((await unavailable.status()).state).toBe('unavailable');
  });
});
