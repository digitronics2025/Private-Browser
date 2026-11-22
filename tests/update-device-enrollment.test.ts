import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PUBLIC_UPDATE_ENDPOINT, UpdateServiceStore } from '../electron/update-service';

vi.mock('electron', () => ({ safeStorage: {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value).reverse(),
  decryptString: (value: Buffer) => Buffer.from(value).reverse().toString(),
} }));

it('retries enrollment with its existing saved proof and sends credentials only to the pinned installer route', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-browser-release-device-fixture-'));
  const file = join(root, 'updates.enc');
  const code = `pbenr_72f53bc0-dc23-4b8d-9999-8d1f688bcf10_${'a'.repeat(43)}`;
  const signal = new AbortController().signal;
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const run = vi.fn(async (target: RequestInfo | URL, request?: RequestInit) => {
    requests.push({ url: String(target), authorization: new Headers(request?.headers).get('authorization') });
    if (requests.length === 1) throw new Error('Response lost in fixture');
    return Response.json({ enrolled: true });
  });
  vi.stubGlobal('fetch', run);
  try {
    const first = new UpdateServiceStore(file);
    await expect(first.enrollDevice(code, '0.7.0', signal)).rejects.toThrow('Response lost in fixture');
    expect(first.status('0.7.0').source).toBe('public');
    expect(readFileSync(`${file}.enrollment`, 'utf8')).not.toContain(code);
    const reopened = new UpdateServiceStore(file);
    await expect(reopened.enrollDevice(code, '0.7.0', signal)).resolves.toMatchObject({ source: 'private', deviceEnrolled: true });
    expect(requests[0].authorization).toMatch(/^Bearer pbdev_/);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0].url).toBe(`${PUBLIC_UPDATE_ENDPOINT}/api/v1/device-enrollment/redeem`);
    expect(() => reopened.fetchInstaller('https://unrelated.example.test/download/latest.exe')).toThrow(/does not match/);
    expect(() => reopened.fetchInstaller(`${PUBLIC_UPDATE_ENDPOINT}/other`)).toThrow(/does not match/);
    await reopened.fetchInstaller(`${PUBLIC_UPDATE_ENDPOINT}/download/latest.exe?expires=1&signature=fixture`, { headers: { range: 'bytes=0-1' } });
    expect(requests.at(-1)?.authorization).toBe(requests[0].authorization);
    expect(new UpdateServiceStore(file).status('0.7.0').deviceEnrolled).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  }
});
