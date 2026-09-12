import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkUpdateEndpoint, compareVersions, PUBLIC_UPDATE_ENDPOINT, validateManifest } from '../electron/update-service';

function manifest(endpoint = 'https://downloads.example.com') {
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
    downloadUrl: `${endpoint}/download/latest.exe?expires=${expires}&signature=signed`,
    downloadPageUrl: `${endpoint}/download?expires=${expires}&signature=signed`,
    expiresAt: new Date(expires * 1000).toISOString(),
  };
}

describe('desktop update client', () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it('checks the public stable feed without sending credentials', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify(manifest(PUBLIC_UPDATE_ENDPOINT)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkUpdateEndpoint('0.3.1');

    expect(result.state).toBe('up-to-date');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(requestUrl).toBe(`${PUBLIC_UPDATE_ENDPOINT}/api/v1/releases/public/latest`);
    expect(requestInit?.headers).toEqual({ accept: 'application/json' });
    expect(JSON.stringify(requestInit)).not.toContain('authorization');
  });

  it('retains bearer-authenticated checks for an encrypted private override', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({ ...manifest(), version: '0.3.2' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await checkUpdateEndpoint('0.3.1', 'https://downloads.example.com', 'private-token');

    expect(result.state).toBe('available');
    expect(requestUrl).toBe('https://downloads.example.com/update.json');
    expect(requestInit?.headers).toEqual({ authorization: 'Bearer private-token', accept: 'application/json' });
    expect(requestInit?.redirect).toBe('error');
  });

  it('reports an unavailable public release without implying a token failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    await expect(checkUpdateEndpoint('0.3.1')).rejects.toThrow('The public download service has no stable release');
  });
});
