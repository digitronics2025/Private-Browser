import { describe, expect, it } from 'vitest';
import { compareVersions, validateManifest } from '../electron/update-service';

function manifest() {
  const expires = Math.floor(Date.now() / 1000) + 600;
  return {
    schemaVersion: 1,
    appId: 'private-browser',
    version: '0.3.1',
    buildNumber: 4,
    channel: 'stable',
    publishedAt: new Date().toISOString(),
    filename: 'Private-Browser-0.3.1-Setup.exe',
    sizeBytes: 100,
    sha256: 'a'.repeat(64),
    commitSha: 'abcdef123456',
    releaseNotes: 'Stable',
    downloadUrl: `https://downloads.example.com/download/latest.exe?expires=${expires}&signature=signed`,
    downloadPageUrl: `https://downloads.example.com/download?expires=${expires}&signature=signed`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

describe('desktop update client', () => {
  it('compares stable and prerelease versions', () => {
    expect(compareVersions('0.3.1', '0.3.0')).toBe(1);
    expect(compareVersions('0.3.0', '0.3.0')).toBe(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBe(-1);
  });

  it('accepts a same-origin signed manifest', () => {
    expect(validateManifest(manifest(), 'https://downloads.example.com').version).toBe('0.3.1');
  });

  it('rejects signed links on another origin', () => {
    const value = manifest();
    value.downloadUrl = value.downloadUrl.replace('downloads.example.com', 'attacker.example');
    expect(() => validateManifest(value, 'https://downloads.example.com')).toThrow(/signed update URL/);
  });

  it('rejects same-origin links pointing at an unexpected route', () => {
    const value = manifest();
    value.downloadPageUrl = value.downloadPageUrl.replace('/download?', '/account?');
    expect(() => validateManifest(value, 'https://downloads.example.com')).toThrow(/signed update URL/);
  });
});
