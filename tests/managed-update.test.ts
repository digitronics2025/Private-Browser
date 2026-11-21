import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ManagedUpdate, streamUpdateInstaller } from '../electron/managed-update.js';
import type { ReleaseManifest, UpdateCheckResult } from '../electron/types.js';

const testBytes = 'managed update fixture';
const checksum = createHash('sha256').update(testBytes).digest('hex');
const url = 'https://updates.example.test/download/latest.exe?expires=100&signature=fixture';
const manifest: ReleaseManifest = {
  schemaVersion: 1, appId: 'private-browser', version: '0.6.99', channel: 'stable', buildNumber: 1,
  publishedAt: '2026-11-21T16:00:00Z', filename: 'Private-Browser-Setup.exe',
  sizeBytes: Buffer.byteLength(testBytes), sha256: checksum, commitSha: 'a'.repeat(40), releaseNotes: '',
  downloadUrl: url, downloadPageUrl: 'https://updates.example.test/download?expires=100&signature=fixture',
  expiresAt: '2026-11-22T16:00:00Z',
};

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'private-browser-managed-update-')); });
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

function response(bytes = testBytes) {
  return new Response(bytes, { headers: { 'content-length': String(Buffer.byteLength(bytes)) } });
}

it('downloads into an app-owned directory, refuses redirects and checks the exact bytes', async () => {
  const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
  const report = vi.fn();
  const path = await streamUpdateInstaller(manifest, root, { request, report, signal: new AbortController().signal });
  expect(request).toHaveBeenCalledWith(new URL(url), expect.objectContaining({ redirect: 'error', headers: { 'Accept-Encoding': 'identity' } }));
  expect(report).toHaveBeenLastCalledWith(Buffer.byteLength(testBytes));
  expect(await readFile(path, 'utf8')).toBe(testBytes);
  if (process.platform === 'win32') expect(await readFile(path + ':Zone.Identifier', 'utf8')).toContain('ZoneId=3');
  expect(await readdir(root)).toEqual(['PrivateBrowserUpdate.exe']);
});

it('rejects a mismatched payload and refuses a modified file at install time', async () => {
  const stages = vi.fn();
  const check = vi.fn(async (): Promise<UpdateCheckResult> => ({ state: 'available', currentVersion: '0.6.0', latest: manifest, checkedAt: manifest.publishedAt }));
  const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
  vi.stubGlobal('fetch', request);
  const installer = vi.fn(async () => '');
  const update = new ManagedUpdate({ directory: root, currentVersion: '0.6.0', check, canUse: () => true, openInstaller: installer, notify: stages });
  await update.download(manifest.version, 'f'.repeat(64));
  expect(update.snapshot()).toMatchObject({ phase: 'failed', message: expect.stringContaining('available release changed') });
  expect(request).not.toHaveBeenCalled();
  request.mockImplementationOnce(async () => response('x'.repeat(manifest.sizeBytes)));
  await update.download(manifest.version, checksum);
  expect(update.snapshot()).toMatchObject({ phase: 'failed', message: expect.stringContaining('published checksum') });
  expect(await readdir(root)).toEqual([]);

  await update.download(manifest.version, checksum);
  expect(update.snapshot()).toMatchObject({ phase: 'ready', version: manifest.version });
  const [staged] = await readdir(root);
  await writeFile(join(root, staged, 'PrivateBrowserUpdate.exe'), 'x'.repeat(manifest.sizeBytes));
  await update.install();
  expect(update.snapshot()).toMatchObject({ phase: 'failed', message: expect.stringContaining('installer changed') });
  expect(installer).not.toHaveBeenCalled();
});

it('rechecks the release, requires user install and only reports an installed version on the matching restart', async () => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => response()));
  let scope = true;
  let active = manifest;
  const options = { directory: root, currentVersion: '0.6.0', canUse: () => scope, notify: () => undefined,
    check: async (): Promise<UpdateCheckResult> => ({ state: 'available', currentVersion: '0.6.0', latest: active, checkedAt: manifest.publishedAt }),
    openInstaller: vi.fn(async () => ''),
  };
  const update = new ManagedUpdate(options);
  await update.download(manifest.version, checksum);
  scope = false;
  await expect(update.install()).rejects.toThrow(/regular Account Space/);
  scope = true;
  active = { ...manifest, buildNumber: 2 };
  await update.install();
  expect(update.snapshot()).toMatchObject({ phase: 'failed', message: expect.stringContaining('release changed') });
  expect(options.openInstaller).not.toHaveBeenCalled();
  active = manifest;
  await update.download(manifest.version, checksum);
  expect(options.openInstaller).not.toHaveBeenCalled();
  await update.install();
  expect(update.snapshot()).toEqual({ phase: 'launched', version: manifest.version });
  expect(options.openInstaller).toHaveBeenCalledTimes(1);
  expect(new ManagedUpdate(options).snapshot()).toEqual({ phase: 'idle' });
  expect(new ManagedUpdate({ ...options, currentVersion: manifest.version }).snapshot()).toEqual({ phase: 'installed', version: manifest.version });
});
