import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256File, verifyDownload } from '../electron/download-verify';

const directory = mkdtempSync(join(tmpdir(), 'pb-download-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function installer(name: string, contents: string) {
  const path = join(directory, name);
  writeFileSync(path, contents);
  return {
    path,
    expected: {
      filename: name,
      sha256: createHash('sha256').update(contents).digest('hex'),
      sizeBytes: Buffer.byteLength(contents),
    },
  };
}

describe('download verification', () => {
  it('hashes a file the same way the release pipeline does', async () => {
    const { path, expected } = installer('a.exe', 'installer bytes');
    expect(await sha256File(path)).toBe(expected.sha256);
  });

  it('accepts the installer the manifest described', async () => {
    const { path, expected } = installer('b.exe', 'the real installer');
    expect(await verifyDownload(path, 'b.exe', expected)).toBe('verified');
  });

  it('rejects a file whose bytes were swapped after publication', async () => {
    const { expected } = installer('c.exe', 'the real installer');
    const tampered = installer('c.exe', 'a different installer entirely');
    // Same name and same expected checksum, different content.
    expect(await verifyDownload(tampered.path, 'c.exe', expected)).toBe('mismatch');
  });

  it('rejects on a size mismatch without reading the whole file', async () => {
    const { expected } = installer('d.exe', 'original');
    const bigger = installer('d.exe', 'original plus a great deal more content');
    expect(await verifyDownload(bigger.path, 'd.exe', expected)).toBe('mismatch');
  });

  it('stays out of the way of downloads it knows nothing about', async () => {
    const { path, expected } = installer('e.exe', 'installer');
    // A different file the user downloaded themselves.
    expect(await verifyDownload(path, 'holiday-photos.zip', expected)).toBe('unchecked');
    // No update check has run, so there is nothing to compare against.
    expect(await verifyDownload(path, 'e.exe', undefined)).toBe('unchecked');
    // A path that is not there.
    expect(await verifyDownload(join(directory, 'missing.exe'), 'missing.exe', { ...expected, filename: 'missing.exe' })).toBe('unchecked');
  });

  it('is case-insensitive about the published checksum', async () => {
    const { path, expected } = installer('f.exe', 'installer');
    expect(await verifyDownload(path, 'f.exe', { ...expected, sha256: expected.sha256.toUpperCase() })).toBe('verified');
  });
});
