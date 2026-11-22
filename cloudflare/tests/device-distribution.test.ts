/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import worker, { type Env } from '../src/index';

it('requires verified enrollment for private feeds and range requests and rejects a revoked device', async () => {
  const database = new DatabaseSync(':memory:');
  const parameters = (values: Array<string | number | null>) => Object.fromEntries(values.map((value, index) => [`?${index + 1}`, value]));
  const DB = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const bound = (values: Array<string | number | null> = []) => ({
        first: async () => statement.get(parameters(values)) ?? null,
        run: async () => statement.run(parameters(values)),
        all: async () => ({ results: statement.all(parameters(values)), success: true }),
      });
      return { ...bound(), bind: (...values: Array<string | number | null>) => bound(values) };
    },
  };
  const RELEASES = {
    head: async () => ({ httpEtag: '"fixture"', size: 4 }),
    get: async (_key: string, options?: { range?: { offset: number; length: number } }) => ({ body: options?.range ? 'ab' : 'abcd' }),
  };
  const env = { DB, RELEASES, DOWNLOAD_ACCESS_TOKEN: 'fixture-legacy-' + 'a'.repeat(32), SIGNING_SECRET: 'fixture-signer-' + 'b'.repeat(32), ADMIN_API_KEY: 'fixture-admin-' + 'c'.repeat(32) } as unknown as Env;
  const origin = 'https://release-fixture.example.test';
  const fetch = (path: string, init?: RequestInit) => worker.fetch(new Request(new URL(path, origin), init), env);
  const admin = (path: string, data?: Record<string, unknown>) => fetch(path, {
    method: data ? 'POST' : 'GET', headers: { 'x-api-key': env.ADMIN_API_KEY, 'content-type': 'application/json' },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const setPrivate = { mode: 'private', confirm: 'SWITCH_TO_PRIVATE' };
  try {
    for (const migration of ['0001_releases.sql', '0002_prevent_downgrades.sql', '0003_release_restore_history.sql', '0004_release_device_enrollment.sql']) {
      database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    database.prepare(`INSERT INTO releases (id,app_id,version,build_number,channel,object_key,filename,content_type,size_bytes,sha256,commit_sha,release_notes,published_at,is_active)
      VALUES ('stable-fixture','private-browser','0.7.1',10,'stable','fixture/setup.exe','Private-Browser-0.7.1-Setup.exe','application/octet-stream',4,?,?,'fixture notes','2026-11-20T12:00:00Z',1)`)
      .run('a'.repeat(64), 'b'.repeat(40));
    const publicResult = await fetch('/api/v1/releases/public/latest');
    expect(publicResult.status).toBe(200);
    const oldLink = (await publicResult.json() as { downloadUrl: string }).downloadUrl;
    expect((await admin('/api/v1/admin/distribution', setPrivate)).status).toBe(409);
    expect((await fetch('/api/v1/admin/download-devices')).status).toBe(404);
    const issued = await admin('/api/v1/admin/download-devices', { label: 'Fixture Windows PC' });
    expect(issued.status).toBe(201);
    const { code, id } = await issued.json() as { code: string; id: string };
    const credential = `pbdev_${id}_${'a'.repeat(43)}`;
    const wrong = `pbdev_${id}_${'b'.repeat(43)}`;
    const auth = { authorization: `Bearer ${credential}` };
    const redeem = (token: string) => fetch('/api/v1/device-enrollment/redeem', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ code }) });
    expect((await redeem(credential)).status).toBe(200);
    expect((await redeem(credential)).status).toBe(200);
    expect((await redeem(wrong)).status).toBe(404);
    expect((await fetch('/update.json', { method: 'HEAD', headers: auth })).status).toBe(200);
    expect((await admin('/api/v1/admin/distribution', setPrivate)).status).toBe(200);
    expect(await (await fetch('/api/v1/distribution')).json()).toEqual({ mode: 'private' });
    expect((await fetch('/api/v1/releases/public/latest')).status).toBe(404);
    expect((await fetch('/download/' + env.DOWNLOAD_ACCESS_TOKEN)).status).toBe(404);
    expect((await fetch('/update.json', { headers: { authorization: `Bearer ${env.DOWNLOAD_ACCESS_TOKEN}` } })).status).toBe(404);
    expect((await fetch(oldLink, { headers: { range: 'bytes=0-1' } })).status).toBe(404);
    const manifest = await (await fetch('/update.json', { headers: auth })).json() as { downloadUrl: string };
    const ranged = await fetch(manifest.downloadUrl, { headers: { ...auth, range: 'bytes=0-1' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 0-1/4');
    expect(await ranged.text()).toBe('ab');
    const list = await (await admin('/api/v1/admin/download-devices')).json();
    expect(list).toMatchObject({ devices: [{ id, label: 'Fixture Windows PC', enrolledAt: expect.any(String), lastUsedAt: expect.any(String) }] });
    expect(JSON.stringify(list)).not.toContain(credential);
    expect((await admin(`/api/v1/admin/download-devices/${id}/revoke`, {})).status).toBe(200);
    expect((await fetch(manifest.downloadUrl, { method: 'HEAD', headers: auth })).status).toBe(404);
    expect((await fetch('/update.json', { headers: auth })).status).toBe(404);
    expect((await redeem(credential)).status).toBe(404);
    expect((await admin('/api/v1/admin/distribution', { mode: 'public', confirm: 'SWITCH_TO_PUBLIC' })).status).toBe(200);
    expect((await fetch('/api/v1/releases/public/latest')).status).toBe(200);
  } finally { database.close(); }
});
