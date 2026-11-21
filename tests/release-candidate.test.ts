import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseCandidate } from '../cloudflare/scripts/verify-release-candidate.mjs';

let directory: string;
const filename = 'Private-Browser-Setup.exe';
const bytes = 'synthetic installer bytes';
const sha256 = createHash('sha256').update(bytes).digest('hex');

function fixture() {
  directory = mkdtempSync(join(tmpdir(), 'private-browser-release-candidate-'));
  const installer = join(directory, filename);
  const candidate = join(directory, 'candidate.exe');
  const sums = join(directory, 'SHA256SUMS.txt');
  writeFileSync(installer, bytes);
  writeFileSync(candidate, bytes);
  writeFileSync(sums, `\uFEFF${sha256.toUpperCase()}  ${filename}\r\n`);
  return { installer, candidate, sums };
}

afterEach(() => { if (directory) rmSync(directory, { force: true, recursive: true }); });

describe('release candidate verification', () => {
  it('matches private candidate bytes to the verified Windows artifact', async () => {
    const { installer, candidate } = fixture();
    await expect(verifyReleaseCandidate(installer, candidate)).resolves.toEqual({ filename, sizeBytes: Buffer.byteLength(bytes), sha256 });
  });

  it('rejects a same-length replacement in the private candidate', async () => {
    const { installer, candidate } = fixture();
    writeFileSync(candidate, 'x'.repeat(bytes.length));
    await expect(verifyReleaseCandidate(installer, candidate)).rejects.toThrow(/candidate differs/i);
  });

  it('rejects a checksum for another file or changed build bytes', async () => {
    const { installer, candidate, sums } = fixture();
    writeFileSync(sums, `${sha256}  Another-Setup.exe\n`);
    await expect(verifyReleaseCandidate(installer, candidate)).rejects.toThrow(/does not name this installer/i);
    writeFileSync(sums, `${sha256}  ${filename}\n`);
    writeFileSync(installer, bytes + 'x');
    await expect(verifyReleaseCandidate(installer, candidate)).rejects.toThrow(/does not match the Windows build checksum/i);
  });
});
