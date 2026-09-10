import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';

export type ChecksumResult = 'verified' | 'mismatch' | 'unchecked';

export interface ExpectedInstaller {
  filename: string;
  sha256: string;
  sizeBytes: number;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Compare a finished download against the checksum the release manifest carried.
 *
 * The service publishes a SHA-256 and the download page prints it, but until now
 * nothing on this side ever compared it to the bytes that arrived — the checksum
 * was presentation, not verification. The installer is also unsigned, so this is
 * the only tamper check the user gets between the service and the file they run.
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
