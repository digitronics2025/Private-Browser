import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { downloadFileStamp, inspectDownloadPublisher, verifyDownload } from './download-verify.js';
import { atomicWrite } from './myvault/vault-store.js';
import type { ManagedUpdateStatus, ReleaseManifest, UpdateCheckResult } from './types.js';

const maxInstallerBytes = 512 * 1024 * 1024;
const installerName = 'PrivateBrowserUpdate.exe';
const partName = 'installer.part';
const internetZone = '[ZoneTransfer]\r\nZoneId=3\r\n';
const staleStageAge = 3 * 24 * 60 * 60 * 1000;
class UpdateInstallError extends Error {
  constructor(readonly failure: NonNullable<ManagedUpdateStatus['failure']>, message: string) { super(message); }
}

export async function streamUpdateInstaller(
  manifest: Pick<ReleaseManifest, 'downloadUrl' | 'sizeBytes' | 'sha256'>,
  directory: string,
  options: { signal: AbortSignal; report: (bytes: number) => void; request?: typeof fetch; markInternet?: boolean },
): Promise<string> {
  const url = new URL(manifest.downloadUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || !Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 1 || manifest.sizeBytes > maxInstallerBytes) {
    throw new UpdateInstallError('release', 'The release service returned invalid installer details.');
  }
  const request = options.request ?? fetch;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(15 * 60 * 1000)]);
  const response = await request(url, { redirect: 'error', headers: { 'Accept-Encoding': 'identity' }, signal }).catch(() => {
    signal.throwIfAborted();
    throw new UpdateInstallError('release', 'The release service could not provide the installer.');
  });
  if (response.status !== 200 || !response.body) throw new UpdateInstallError('release', 'The release service could not provide the installer.');
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  const temporaryPath = join(directory, partName);
  const path = join(directory, installerName);
  let received = 0;
  let nextProgressAt = 0;
  try {
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== manifest.sizeBytes) throw new UpdateInstallError('verification', 'The installer size did not match the published release.');
    const file = await open(temporaryPath, 'wx', 0o600);
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += chunk.value.byteLength;
        if (received > manifest.sizeBytes) throw new UpdateInstallError('verification', 'The installer size did not match the published release.');
        await file.writeFile(chunk.value);
        hash.update(chunk.value);
        const now = Date.now();
        if (now >= nextProgressAt) {
          options.report(received);
          nextProgressAt = now + 250;
        }
      }
      signal.throwIfAborted();
      if (received !== manifest.sizeBytes || hash.digest('hex') !== manifest.sha256) {
        throw new UpdateInstallError('verification', 'The installer did not match the published checksum.');
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    if (options.markInternet ?? (process.platform === 'win32')) {
      await writeFile(path + ':Zone.Identifier', internetZone, { flag: 'wx' });
    }
    options.report(received);
    return path;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

interface UpdateEnvironment {
  request?: typeof fetch;
  readonly directory: string;
  readonly currentVersion: string;
  readonly approvedPublishers: readonly string[];
  readonly inspectPublisher?: typeof inspectDownloadPublisher;
  readonly check: () => Promise<UpdateCheckResult>;
  readonly canUse: () => boolean;
  readonly openInstaller: (path: string) => Promise<string>;
  readonly notify: () => void;
}

interface StagedUpdate {
  readonly release: ReleaseManifest;
  readonly directory: string;
  readonly path: string;
}

const sameInstaller = (left: ReleaseManifest, right: ReleaseManifest) =>
  left.sha256 === right.sha256 && left.version === right.version && left.sizeBytes === right.sizeBytes
    && left.commitSha === right.commitSha && left.buildNumber === right.buildNumber && left.filename === right.filename
    && new URL(left.downloadUrl).origin === new URL(right.downloadUrl).origin;

export class ManagedUpdate {
  private status: ManagedUpdateStatus = { phase: 'idle' };
  private staged?: StagedUpdate;
  private abort?: AbortController;
  private readonly receiptPath: string;

  constructor(private readonly environment: UpdateEnvironment) {
    this.receiptPath = join(environment.directory, 'last-managed-install.json');
    void pruneOldStages(environment.directory).catch(() => undefined);
    try {
      const stats = lstatSync(this.receiptPath);
      if (stats.isFile() && stats.size <= 1024) {
        const prior = JSON.parse(readFileSync(this.receiptPath, 'utf8')) as { from?: string; target?: string };
        if (typeof prior.from === 'string' && prior.target === environment.currentVersion && prior.target !== prior.from) {
          this.status = { phase: 'installed', version: environment.currentVersion };
        }
      }
    } catch { /* Missing local receipts do not affect ordinary release checks. */ }
  }

  snapshot(): ManagedUpdateStatus {
    return this.status;
  }

  private publish(next: ManagedUpdateStatus): void {
    this.status = next;
    this.environment.notify();
  }

  private assertUsable(): void {
    if (!this.environment.canUse()) throw new Error('Use an unlocked regular Account Space to manage updates.');
  }

  private async checkRelease(): Promise<UpdateCheckResult> {
    return await this.environment.check().catch(() => {
      throw new UpdateInstallError('release', 'The release service could not be checked.');
    });
  }

  private async requireApprovedPublisher(path: string) {
    const { state, name, fingerprint } = await (this.environment.inspectPublisher ?? inspectDownloadPublisher)(path);
    if (state !== 'valid' || !fingerprint || !this.environment.approvedPublishers.includes(fingerprint)) {
      throw new UpdateInstallError('verification', 'Windows could not verify an approved Private Browser publisher. The installer was blocked.');
    }
    return { state, name } as const;
  }

  async download(expectedVersion: string, expectedSha: string): Promise<void> {
    this.assertUsable();
    if (this.abort || this.status.phase === 'verifying') throw new Error('An update is already in progress.');
    const operation = new AbortController();
    this.abort = operation;
    this.publish({ phase: 'preparing' });
    let directory: string | undefined;
    let version: string | undefined;
    try {
      const { state, latest } = await this.checkRelease();
      if (state !== 'available' || latest.version !== expectedVersion || latest.sha256 !== expectedSha) {
        throw new UpdateInstallError('release', 'The available release changed. Check for updates again.');
      }
      operation.signal.throwIfAborted();
      version = latest.version;
      await mkdir(this.environment.directory, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(this.environment.directory, 'installer-'));
      const progress = (receivedBytes: number) => {
        this.publish({ phase: 'downloading', version, receivedBytes, totalBytes: latest.sizeBytes });
      };
      progress(0);
      const path = await streamUpdateInstaller(latest, directory, { signal: operation.signal, report: progress, request: this.environment.request });
      this.publish({ phase: 'verifying', version });
      const stamp = downloadFileStamp(path);
      const publisher = await this.requireApprovedPublisher(path);
      operation.signal.throwIfAborted();
      if (!stamp || stamp !== downloadFileStamp(path)) throw new UpdateInstallError('verification', 'The downloaded installer changed. Download a new copy.');
      const prior = this.staged?.directory;
      this.staged = { release: latest, directory, path };
      directory = undefined;
      if (prior) void clearStage(prior);
      this.publish({ phase: 'ready', version, publisher });
    } catch (error) {
      const problem = operation.signal.aborted ? { failure: 'cancelled' as const, message: 'Download cancelled.' } : describeFailure(error);
      this.publish({ phase: 'failed', version, ...problem });
    } finally {
      if (directory) await clearStage(directory);
      this.abort = undefined;
    }
  }

  cancel(): void {
    this.assertUsable();
    this.cancelTransfer();
  }

  cancelTransfer(): void {
    this.abort?.abort();
  }

  async install(): Promise<void> {
    this.assertUsable();
    const staged = this.staged;
    if (!staged || this.status.phase !== 'ready' || this.abort) throw new Error('Download and verify the installer first.');
    this.publish({ phase: 'verifying', version: staged.release.version });
    try {
      const { state, latest } = await this.checkRelease();
      if (state !== 'available' || !sameInstaller(latest, staged.release)) throw new UpdateInstallError('release', 'The available release changed. Check for updates again.');
      const stamp = downloadFileStamp(staged.path);
      const verified = stamp && await verifyDownload(staged.path, latest.filename, latest);
      if (verified === 'verified') await this.requireApprovedPublisher(staged.path);
      this.assertUsable();
      if (verified !== 'verified' || stamp !== downloadFileStamp(staged.path)
        || (process.platform === 'win32' && readFileSync(staged.path + ':Zone.Identifier', 'utf8') !== internetZone)) {
        throw new UpdateInstallError('verification', 'The installer changed or could not be verified. Download a new copy.');
      }
      atomicWrite(this.receiptPath, JSON.stringify({ from: this.environment.currentVersion, target: latest.version }));
      if (await this.environment.openInstaller(staged.path)) throw new UpdateInstallError('launch', 'Windows could not open the installer.');
      this.publish({ phase: 'launched', version: latest.version });
    } catch (error) {
      this.publish({ phase: 'failed', version: staged.release.version, ...describeFailure(error) });
    }
  }
}

async function clearStage(directory: string): Promise<void> {
  await Promise.all([installerName, partName].map((name) => unlink(join(directory, name)).catch(() => undefined)));
  await rmdir(directory).catch(() => undefined);
}

async function pruneOldStages(directory: string): Promise<void> {
  if (!(await lstat(directory)).isDirectory()) return;
  const cutoff = Date.now() - staleStageAge;
  for (const name of await readdir(directory)) {
    if (!/^installer-[\da-z]{6}$/i.test(name)) continue;
    const stage = join(directory, name);
    const info = await lstat(stage).catch(() => undefined);
    if (info?.isDirectory() && info.mtimeMs < cutoff) await clearStage(stage);
  }
}

function describeFailure(error: unknown): Pick<ManagedUpdateStatus, 'failure' | 'message'> {
  if (error instanceof UpdateInstallError) return { failure: error.failure, message: error.message };
  return { failure: 'storage', message: 'The installer could not be saved or verified. Try again or open the release page.' };
}
