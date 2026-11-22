import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('uses an isolated window to enroll the Windows update device and saves protected state', async () => {
  test.skip(process.platform !== 'win32', 'Checks Windows credential protection');
  const root = mkdtempSync(join(tmpdir(), 'private-browser-update-device-test-'));
  const origin = 'https://private-browser-downloads.digitronics-electro.workers.dev';
  const id = '72f53bc0-dc23-4b8d-9999-8d1f688bcf10';
  const code = `pbenr_${id}_${'a'.repeat(43)}`;
  let app: ElectronApplication | undefined;
  try {
    const env = { ...process.env, LOCALAPPDATA: join(root, 'local') } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), '--user-data-dir=' + root, '--no-proxy-server'], env });
    const chrome = await app.firstWindow();
    await expect(chrome.getByRole('main', { name: 'New Tab' })).toBeVisible();
    await app.evaluate((_electron, { origin, id, code }) => {
      globalThis.fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.origin === origin && url.pathname === '/api/v1/device-enrollment/redeem' && init?.method === 'POST') {
          const token = new Headers(init.headers).get('authorization');
          const body = JSON.parse(String(init.body)) as { code: string };
          const success = token?.startsWith(`Bearer pbdev_${id}_`) && body.code === code && init.redirect === 'error';
          Reflect.set(globalThis, 'enrollmentFixtureVerified', success);
          return success ? Response.json({ enrolled: true }) : new Response(null, { status: 404 });
        }
        return new Response(null, { status: 404 });
      };
    }, { origin, id, code });
    const opened = app.waitForEvent('window');
    const enrollment = chrome.evaluate(() => window.privateBrowser.enrollUpdateDevice());
    const dialog = await opened;
    await expect(dialog.getByRole('heading', { name: 'Enroll this device' })).toBeVisible();
    await dialog.getByLabel('Download enrollment code').fill(code);
    await dialog.getByRole('button', { name: 'Enroll device' }).click();
    await expect(enrollment).resolves.toMatchObject({ deviceEnrolled: true, source: 'private' });
    expect(await app.evaluate(() => Reflect.get(globalThis, 'enrollmentFixtureVerified'))).toBe(true);
    const disk = readFileSync(join(root, 'update-service.enc'), 'utf8');
    expect(disk).not.toContain(code);
    expect(disk).not.toContain('pbdev_');
  } finally {
    await app?.close().catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
