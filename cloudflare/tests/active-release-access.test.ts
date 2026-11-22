import { afterEach, expect, it, vi } from 'vitest';

const script = '../scripts/read-active-release.mjs';
const { readActiveRelease } = await import(script) as { readActiveRelease: () => Promise<unknown> };

const origin = 'https://releases.example.test';
const metadata = { version: '1.2.3', buildNumber: 123, commitSha: 'a'.repeat(40) };

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('reads existing public releases without forwarding credentials', async () => {
  vi.stubEnv('PRIVATE_BROWSER_DOWNLOAD_URL', origin);
  vi.stubEnv('PRIVATE_BROWSER_RELEASE_VERIFY_DEVICE', 'fixture-not-used-in-public');
  const request = vi.fn(async (url: string, init: RequestInit) => {
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    return url.endsWith('/distribution') ? new Response(null, { status: 404 }) : Response.json(metadata);
  });
  vi.stubGlobal('fetch', request);
  await expect(readActiveRelease()).resolves.toEqual(metadata);
  expect(request.mock.calls.map(([url]) => url)).toEqual([origin + '/api/v1/distribution', origin + '/api/v1/releases/public/latest']);
});

it('requires the pinned verification device when the service is private', async () => {
  vi.stubEnv('PRIVATE_BROWSER_DOWNLOAD_URL', origin);
  vi.stubEnv('PRIVATE_BROWSER_RELEASE_VERIFY_DEVICE', undefined);
  const fixture = `pbdev_72f53bc0-dc23-4b8d-9999-8d1f688bcf10_${'a'.repeat(43)}`;
  const request = vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith('/distribution')) return Response.json({ mode: 'private' });
    expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${fixture}`);
    return Response.json(metadata);
  });
  vi.stubGlobal('fetch', request);
  await expect(readActiveRelease()).rejects.toThrow(/verification device/);
  expect(request).toHaveBeenCalledOnce();
  vi.stubEnv('PRIVATE_BROWSER_RELEASE_VERIFY_DEVICE', fixture);
  await expect(readActiveRelease()).resolves.toEqual(metadata);
  expect(request.mock.calls.at(-1)?.[0]).toBe(origin + '/update.json');
});
