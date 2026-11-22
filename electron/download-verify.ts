import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DownloadEntry } from './types.js';

export type ChecksumResult = 'verified' | 'mismatch' | 'unchecked';

export interface ExpectedInstaller {
  filename: string;
  sha256: string;
  sizeBytes: number;
}

export function downloadFileStamp(filePath: string): string | undefined {
  try {
    const file = lstatSync(filePath, { bigint: true });
    if (file.isFile()) return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(':');
  } catch {
    // File was removed or is unreadable.
  }
  return undefined;
}

const readSignature = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '$item = Get-AuthenticodeSignature -LiteralPath $env:PRIVATE_BROWSER_SIGNATURE_FILE',
  '$publisher = if ($item.SignerCertificate) { $item.SignerCertificate.GetNameInfo("SimpleName", $false) }',
  '$fingerprint = if ($item.SignerCertificate) { $sha = [Security.Cryptography.SHA256]::Create(); try { [BitConverter]::ToString($sha.ComputeHash($item.SignerCertificate.RawData)).Replace("-", "").ToLowerInvariant() } finally { $sha.Dispose() } }',
  '[pscustomobject]@{status=$item.Status.ToString();publisher=$publisher;fingerprint=$fingerprint;embedded=($item.SignatureType.ToString() -eq "Authenticode");timestamped=($null -ne $item.TimeStamperCertificate)} | ConvertTo-Json -Compress',
].join('\n');

export async function inspectDownloadPublisher(filePath: string): Promise<NonNullable<DownloadEntry['publisher']> & { fingerprint?: string }> {
  if (process.platform !== 'win32') return { state: 'unavailable' };
  try {
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const command = Buffer.from(readSignature, 'utf16le').toString('base64');
    const { stdout } = await promisify(execFile)(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      env: { ...process.env, PRIVATE_BROWSER_SIGNATURE_FILE: filePath }, windowsHide: true, timeout: 10_000, maxBuffer: 8192,
    });
    const result = JSON.parse(stdout) as { status?: string; publisher?: unknown; fingerprint?: unknown; embedded?: boolean; timestamped?: boolean };
    if (result.status === 'NotSigned') return { state: 'unsigned' };
    if (result.status === 'Valid') {
      const name = typeof result.publisher === 'string' ? result.publisher.replace(/[\p{C}]/gu, '').trim().slice(0, 150) : undefined;
      const fingerprint = result.embedded && result.timestamped && typeof result.fingerprint === 'string'
        && /^[a-f0-9]{64}$/.test(result.fingerprint) ? result.fingerprint : undefined;
      return { state: 'valid', name, fingerprint };
    }
    return { state: result.status === 'UnknownError' ? 'unavailable' : 'untrusted' };
  } catch {
    return { state: 'unavailable' };
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Compare a finished download against the checksum the release manifest carried.
 *
 * Returns `unchecked` rather than throwing when there is nothing to compare
 * against or the file cannot be read: an unrelated download must not be reported
 * as a failed verification.
 */
export async function verifyDownload(filePath: string, filename: string, expected?: ExpectedInstaller): Promise<ChecksumResult> {
  if (!expected || !filePath) return 'unchecked';
  if (filename !== expected.filename) return 'unchecked';
  try {
    if (statSync(filePath).size !== expected.sizeBytes) return 'mismatch';
    const actual = await sha256File(filePath);
    return actual === expected.sha256.toLowerCase() ? 'verified' : 'mismatch';
  } catch {
    return 'unchecked';
  }
}
