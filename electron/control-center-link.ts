import { randomBytes, webcrypto } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ControlCenterRepository, ControlCenterStatus, ControlCenterTask } from './types.js';

export type { ControlCenterRepository, ControlCenterStatus, ControlCenterTask } from './types.js';

/**
 * The link to the AI Development Control Center on this computer
 * (docs/systems/control-center-link.md). Private Browser is always the
 * client: it sends page evidence the operator approved as a task, reads the
 * tasks it created, and attaches re-check evidence. The Control Center never
 * sends the browser a request, and nothing here gives it any power over the
 * browser, its Account Spaces or the vault.
 *
 * - The app token lives only in this main-process object and the sealed file;
 *   `status()` never returns it.
 * - Only loopback addresses are ever called, with `redirect: 'error'`, a
 *   timeout and a response-size bound.
 * - The Control Center's identity key is pinned at pairing; a fresh signed
 *   `hello` is checked before anything is sent, so a program squatting the
 *   port is refused.
 */

export const CONTROL_CENTER_PROTOCOL = 'acc-connected-app-v1';
const DEFAULT_URL = 'http://127.0.0.1:4317';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const FIELD = /^[A-Za-z0-9_-]{16,64}$/;

export interface SealedStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredLink {
  version: 1;
  appId: string;
  token: string;
  identityKey: string;
  /** Page origin → the repository the operator chose for it last time. */
  originRepos: Record<string, string>;
}

export class ControlCenterError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_PAIRED' | 'UNREACHABLE' | 'IDENTITY_CHANGED' | 'REJECTED' | 'UNAVAILABLE',
    readonly status?: number,
  ) {
    super(message);
  }
}

// ---- Identity statements (byte-compatible with the Control Center's protocol.ts) ----

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();

function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url');
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

/** False for anything that is not a valid signature by `identityKey` over this statement — never throws. */
export async function verifyStatement(input: { purpose: 'pair' | 'hello'; appId: string; nonce: string; identityKey: string; signature: string }): Promise<boolean> {
  try {
    if (!FIELD.test(input.appId) || !FIELD.test(input.nonce)) return false;
    const raw = fromBase64Url(input.identityKey);
    const signature = fromBase64Url(input.signature);
    if (raw.length !== 65 || raw[0] !== 4 || signature.length !== 64) return false;
    const key = await subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, encoder.encode(`${CONTROL_CENTER_PROTOCOL} ${input.purpose}\n${input.appId}\n${input.nonce}`));
  } catch {
    return false;
  }
}

/** 128 bits of SHA-256 over the raw key, as eight groups of four hex characters — what the Control Center shows. */
export async function identityFingerprint(identityKey: string): Promise<string> {
  const digest = new Uint8Array(await subtle.digest('SHA-256', fromBase64Url(identityKey)));
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{4}/g)!.join(' ');
}

/** Only an http address on this computer. */
export function isLoopbackControlCenterUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 200) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && LOOPBACK.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const nonce = () => randomBytes(18).toString('base64url');

// ---- Response checks ----

const isText = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.length <= max;
const isNullableText = (v: unknown, max = 2000): v is string | null => v === null || isText(v, max);

function parseTask(value: unknown, base: string): ControlCenterTask {
  const t = value as Record<string, unknown> | null;
  if (!t || typeof t !== 'object') throw new ControlCenterError('The Control Center sent an unexpected answer', 'REJECTED');
  if (!isText(t.id, 40) || !/^TASK-\d{1,8}$/.test(t.id) || !isText(t.title, 200) || !isText(t.repositoryName, 200) || !isText(t.status, 40) || !isNullableText(t.currentStageName, 200) || !isNullableText(t.blocker, 400) || !isNullableText(t.finalStatus, 40) || !isText(t.createdAt, 40) || !isText(t.updatedAt, 40)) {
    throw new ControlCenterError('The Control Center sent an unexpected task', 'REJECTED');
  }
  return {
    id: t.id,
    title: t.title,
    repositoryName: t.repositoryName,
    status: t.status,
    currentStageName: t.currentStageName,
    blocker: t.blocker,
    finalStatus: t.finalStatus,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    dashboardUrl: `${base}/tasks/${encodeURIComponent(t.id)}`,
  };
}

function parseRepositories(value: unknown): ControlCenterRepository[] {
  if (!Array.isArray(value) || value.length > 500) throw new ControlCenterError('The Control Center sent an unexpected answer', 'REJECTED');
  return value.map((r) => {
    const x = r as Record<string, unknown>;
    if (!x || !isText(x.id, 100) || !isText(x.name, 200) || !isNullableText(x.devOrigin, 300)) throw new ControlCenterError('The Control Center sent an unexpected repository', 'REJECTED');
    return { id: x.id, name: x.name, devOrigin: x.devOrigin };
  });
}

export interface ControlCenterLinkOptions {
  /** Where the sealed link is kept (userData). */
  filePath: string;
  storage: SealedStorage;
  /** The Control Center's runtime.json; default `%LOCALAPPDATA%\AIDevControlCenter\runtime.json`. */
  runtimeFile?: string | null;
  fetch?: typeof fetch;
}

export class ControlCenterLink {
  private link?: StoredLink;
  private corrupt = false;
  /** The pinned key answered a fresh hello at this base URL during this run. */
  private verifiedBase: string | null = null;
  private readonly fetcher: typeof fetch;
  private readonly runtimeFile: string | null;

  constructor(private readonly options: ControlCenterLinkOptions) {
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    const localAppData = process.env.LOCALAPPDATA;
    this.runtimeFile = options.runtimeFile !== undefined ? options.runtimeFile : localAppData ? join(localAppData, 'AIDevControlCenter', 'runtime.json') : null;
    this.link = this.load();
  }

  /** The Control Center's address: runtime.json when it names a loopback URL, else the default port. */
  baseUrl(): string {
    try {
      if (this.runtimeFile && existsSync(this.runtimeFile)) {
        const runtime = JSON.parse(readFileSync(this.runtimeFile, 'utf8')) as { url?: unknown };
        if (isLoopbackControlCenterUrl(runtime.url)) return new URL(runtime.url).origin;
      }
    } catch {
      /* unreadable runtime file: use the default */
    }
    return DEFAULT_URL;
  }

  async status(): Promise<ControlCenterStatus> {
    const url = this.baseUrl();
    if (!this.options.storage.isEncryptionAvailable()) return { state: 'unavailable', url, detail: 'Windows encryption is unavailable, so the link cannot be kept safely.' };
    if (this.corrupt) return { state: 'unavailable', url, detail: 'The saved link could not be read. Disconnect and pair again.' };
    if (!this.link) return { state: 'not-paired', url };
    const fingerprint = await identityFingerprint(this.link.identityKey);
    try {
      await this.verify();
      return { state: 'connected', url, fingerprint };
    } catch (error) {
      if (error instanceof ControlCenterError && error.code === 'IDENTITY_CHANGED') return { state: 'identity-changed', url, fingerprint, detail: error.message };
      if (error instanceof ControlCenterError && error.code === 'NOT_PAIRED') return { state: 'not-paired', url, detail: error.message };
      return { state: 'unreachable', url, fingerprint, detail: 'The Control Center is not running on this computer.' };
    }
  }

  /** Redeem a pairing code made in the Control Center (Tools → Connected apps). */
  async pair(code: string, name = 'Private Browser'): Promise<ControlCenterStatus> {
    if (!/^\d{8}$/.test(code)) throw new ControlCenterError('The code has eight digits', 'REJECTED');
    if (!this.options.storage.isEncryptionAvailable()) throw new ControlCenterError('Windows encryption is unavailable', 'UNAVAILABLE');
    const base = this.baseUrl();
    const n = nonce();
    const body = (await this.request(base, 'POST', '/api/connected-app/pair', { code, name, nonce: n }, null)) as Record<string, unknown>;
    const appId = body?.appId;
    const token = body?.token;
    const identityKey = body?.identityKey;
    const signature = body?.signature;
    if (!isText(appId, 64) || !isText(token, 200) || !isText(identityKey, 200) || !isText(signature, 200) || !(await verifyStatement({ purpose: 'pair', appId, nonce: n, identityKey, signature }))) {
      throw new ControlCenterError('The Control Center did not prove its identity. Nothing was saved.', 'IDENTITY_CHANGED');
    }
    this.link = { version: 1, appId, token, identityKey, originRepos: {} };
    this.corrupt = false;
    this.save();
    this.verifiedBase = base;
    return this.status();
  }

  /** Forget the link here. The Control Center keeps its record until it is disconnected there. */
  disconnect(): void {
    this.link = undefined;
    this.corrupt = false;
    this.verifiedBase = null;
    if (existsSync(this.options.filePath)) unlinkSync(this.options.filePath);
  }

  /** Repositories, with the one to suggest for this page first. */
  async repositories(pageOrigin: string | null): Promise<{ repositories: ControlCenterRepository[]; suggestedId: string | null }> {
    const base = await this.verify();
    const repositories = parseRepositories(await this.request(base, 'GET', '/api/connected-app/repositories', undefined, this.link!.token));
    const remembered = pageOrigin ? this.link!.originRepos[pageOrigin] : undefined;
    const suggested = (remembered && repositories.find((r) => r.id === remembered)) || (pageOrigin ? repositories.find((r) => r.devOrigin === pageOrigin) : undefined);
    return { repositories, suggestedId: suggested?.id ?? null };
  }

  /**
   * Send approved evidence as a task. One request id for this call and its
   * retries, so a lost answer never creates a second task.
   */
  async createTask(input: { repositoryId: string; note: string; sourceUrl: string; pageOrigin: string | null; evidence: string; screenshotJpegBase64?: string }): Promise<ControlCenterTask> {
    const base = await this.verify();
    const requestId = nonce();
    const body = {
      requestId,
      repositoryId: input.repositoryId,
      note: input.note,
      sourceUrl: input.sourceUrl,
      evidence: input.evidence,
      ...(input.screenshotJpegBase64 ? { screenshotJpegBase64: input.screenshotJpegBase64 } : {}),
    };
    const task = parseTask(await this.withRetry(() => this.request(base, 'POST', '/api/connected-app/tasks', body, this.link!.token)), base);
    if (input.pageOrigin && this.link!.originRepos[input.pageOrigin] !== input.repositoryId) {
      const originRepos = { ...this.link!.originRepos, [input.pageOrigin]: input.repositoryId };
      // Keep the memory small: the 50 most recent origins.
      const entries = Object.entries(originRepos).slice(-50);
      this.link = { ...this.link!, originRepos: Object.fromEntries(entries) };
      this.save();
    }
    return task;
  }

  async tasks(): Promise<ControlCenterTask[]> {
    const base = await this.verify();
    const list = await this.request(base, 'GET', '/api/connected-app/tasks', undefined, this.link!.token);
    if (!Array.isArray(list) || list.length > 50) throw new ControlCenterError('The Control Center sent an unexpected answer', 'REJECTED');
    return list.map((t) => parseTask(t, base));
  }

  async addEvidence(taskId: string, evidence: string): Promise<{ name: string }> {
    if (!/^TASK-\d{1,8}$/.test(taskId)) throw new ControlCenterError('Invalid task', 'REJECTED');
    const base = await this.verify();
    const body = { requestId: nonce(), evidence };
    const result = (await this.withRetry(() => this.request(base, 'POST', `/api/connected-app/tasks/${taskId}/evidence`, body, this.link!.token))) as Record<string, unknown>;
    if (!isText(result?.name, 200)) throw new ControlCenterError('The Control Center sent an unexpected answer', 'REJECTED');
    return { name: result.name };
  }

  // ---- internals ----

  /** The base URL, once the pinned key has signed a fresh hello there during this run. */
  private async verify(): Promise<string> {
    if (!this.link) throw new ControlCenterError('Pair with the Control Center first', 'NOT_PAIRED');
    const base = this.baseUrl();
    if (this.verifiedBase === base) return base;
    const n = nonce();
    const body = (await this.request(base, 'POST', '/api/connected-app/hello', { nonce: n }, this.link.token)) as Record<string, unknown>;
    const signed =
      body?.identityKey === this.link.identityKey &&
      isText(body?.signature, 200) &&
      (await verifyStatement({ purpose: 'hello', appId: this.link.appId, nonce: n, identityKey: this.link.identityKey, signature: body.signature as string }));
    if (!signed) throw new ControlCenterError('The program answering as the Control Center does not have the key this browser paired with. Nothing was sent.', 'IDENTITY_CHANGED');
    this.verifiedBase = base;
    return base;
  }

  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call();
      } catch (error) {
        if (attempt >= 2 || !(error instanceof ControlCenterError) || error.code !== 'UNREACHABLE') throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }

  private async request(base: string, method: 'GET' | 'POST', path: string, body: unknown, token: string | null): Promise<unknown> {
    if (!isLoopbackControlCenterUrl(base)) throw new ControlCenterError('The Control Center must run on this computer', 'UNREACHABLE');
    let response: Response;
    try {
      response = await this.fetcher(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ControlCenterError('The Control Center is not running on this computer', 'UNREACHABLE');
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_RESPONSE_BYTES) throw new ControlCenterError('The Control Center answer was too large', 'REJECTED');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new ControlCenterError('The Control Center answer was too large', 'REJECTED');
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      throw new ControlCenterError('The Control Center sent an unexpected answer', 'REJECTED', response.status);
    }
    if (response.ok) return parsed;
    const message = (parsed as { error?: { message?: unknown } } | null)?.error?.message;
    if (response.status === 401 && token) {
      // Forget the token only when the pinned key already answered at this
      // address: a program squatting the port must not be able to unpair us.
      if (this.verifiedBase === base) this.disconnect();
      throw new ControlCenterError('The Control Center no longer accepts this browser. Disconnect here and pair again.', 'NOT_PAIRED', 401);
    }
    throw new ControlCenterError(isText(message, 500) ? message : `The Control Center refused the request (${response.status})`, 'REJECTED', response.status);
  }

  private load(): StoredLink | undefined {
    try {
      if (!this.options.storage.isEncryptionAvailable() || !existsSync(this.options.filePath)) return undefined;
      const parsed = JSON.parse(this.options.storage.decryptString(Buffer.from(readFileSync(this.options.filePath, 'utf8'), 'base64'))) as StoredLink;
      if (parsed.version !== 1 || !FIELD.test(parsed.appId) || !isText(parsed.token, 200) || !isText(parsed.identityKey, 200) || typeof parsed.originRepos !== 'object' || parsed.originRepos === null) throw new Error('Invalid link');
      return parsed;
    } catch {
      this.corrupt = true;
      this.quarantine();
      return undefined;
    }
  }

  /** A file that cannot be read is moved aside, never silently reused or overwritten. */
  private quarantine(): void {
    try {
      if (existsSync(this.options.filePath)) renameSync(this.options.filePath, `${this.options.filePath}.corrupt-${Date.now()}`);
    } catch {
      /* leave it; status reports the link unavailable */
    }
  }

  private save(): void {
    if (!this.link) return;
    mkdirSync(dirname(this.options.filePath), { recursive: true });
    const temporaryPath = `${this.options.filePath}.tmp`;
    writeFileSync(temporaryPath, this.options.storage.encryptString(JSON.stringify(this.link)).toString('base64'), { mode: 0o600 });
    renameSync(temporaryPath, this.options.filePath);
  }
}

/** What a Developer-panel preview sends: exactly the approved text and, if chosen, the structural DOM — nothing re-read. */
export function developerEvidence(preview: { text: string; dom?: string }): string {
  return `${preview.text}${preview.dom ? `\n\nStructural DOM:\n${preview.dom}` : ''}`.slice(0, 30_000);
}
