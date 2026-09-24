import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyVaultPayload, createVault } from '../../electron/myvault/security/vault-crypto';

const MASTER_PASSWORD = 'autofill fixture password'; // secret-guard:allow — inert E2E fixture
const FIXTURE_USERNAME = 'saved-user@example.test';
const FIXTURE_PASSWORD = 'saved-password-fixture'; // secret-guard:allow — inert E2E fixture

let application: ElectronApplication | undefined;
let userDataPath: string;
let server: Server;
let targetOrigin: string;

async function readForm(target: string): Promise<{ username: string; password: string; submitted?: boolean }> {
  return application!.evaluate(async ({ webContents }, value) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === value);
    if (!contents) return { username: '', password: '' };
    return contents.executeJavaScript(`({
      username: document.querySelector('input[type="email"]')?.value ?? '',
      password: document.querySelector('input[type="password"]')?.value ?? '',
      submitted: window.__submitted
    })`);
  }, target);
}

/**
 * Automatic fill retries at 0, 300, 1000 and 2500 ms after the page loads.
 * "Nothing was filled" is only proven once the form exists and the last retry
 * has had time to run — an empty read before that proves nothing (F-44).
 */
const AUTOMATIC_FILL_SETTLED_MS = 3_000;

async function settledForm(target: string): Promise<{ username: string; password: string; submitted?: boolean }> {
  await expect.poll(() => application!.evaluate(async ({ webContents }, value) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === value);
    return contents ? contents.executeJavaScript(`Boolean(document.querySelector('input[type="password"]'))`) as Promise<boolean> : false;
  }, target)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, AUTOMATIC_FILL_SETTLED_MS));
  return readForm(target);
}

test.beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'private-browser-autofill-'));
  const keyPath = join(userDataPath, 'fixture-key.pem');
  const certPath = join(userDataPath, 'fixture-cert.pem');
  const openssl = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
  const certificate = spawnSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=autofill.example.test', '-addext', 'subjectAltName=DNS:autofill.example.test', '-days', '1',
  ], { encoding: 'utf8' });
  if (certificate.status !== 0) throw new Error(`Could not create the HTTPS fixture certificate: ${certificate.stderr}`);
  const cert = readFileSync(certPath);
  const spkiHash = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  server = createServer({ key: readFileSync(keyPath), cert }, (request, response) => {
    const sharedHead = '<!doctype html><meta charset="utf-8"><title>Autofill fixture</title>';
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/login') {
      response.end(`${sharedHead}<main id="root"></main><script>
        window.__submitted = false;
        setTimeout(() => {
          document.querySelector('#root').innerHTML = '<form><input name="email" type="email" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>';
          document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.__submitted = true; });
        }, 500);
      </script>`);
      return;
    }
    if (request.url === '/occupied') {
      response.end(`${sharedHead}<form><input name="email" type="email" autocomplete="username" value="typed-user"><input name="password" type="password" autocomplete="current-password" value="typed-password"></form>`);
      return;
    }
    if (request.url === '/remembered-email') {
      response.end(`${sharedHead}<form><input name="email" type="email" autocomplete="username" value="${FIXTURE_USERNAME}"><input name="password" type="password" autocomplete="current-password"></form>`);
      return;
    }
    response.end(`${sharedHead}<form><input name="email" type="email" autocomplete="username"><input name="password" type="password" autocomplete="new-password"></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind to TCP');
  targetOrigin = `https://autofill.example.test:${address.port}`;
  const payload = createEmptyVaultPayload();
  payload.items.push({
    id: 'autofill-login',
    title: 'Autofill fixture',
    type: 'login',
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
    url: targetOrigin,
    folder: '',
    vault: 'Personal',
    favorite: false,
    tags: [],
    updatedAt: '2026-09-12T12:00:00.000Z',
  });
  const { envelope } = await createVault(MASTER_PASSWORD, payload, { memorySizeKiB: 8 * 1024, iterations: 1 });
  mkdirSync(join(userDataPath, 'myvault'), { recursive: true });
  writeFileSync(join(userDataPath, 'myvault', 'envelope.myvault'), JSON.stringify(envelope), 'utf8');
  const env = { ...process.env, NODE_ENV: 'test', PRIVATE_BROWSER_E2E_USER_DATA: userDataPath } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    args: [
      join(process.cwd(), 'dist-electron/main.js'),
      '--host-resolver-rules=MAP autofill.example.test 127.0.0.1',
      '--no-proxy-server',
      `--ignore-certificate-errors-spki-list=${spkiHash}`,
    ],
    env,
  });
});

test.afterEach(async () => {
  await application?.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(userDataPath, { recursive: true, force: true });
});

test('automatically fills only safe empty HTTPS login forms without submitting', async () => {
  const page = await application!.firstWindow();
  await page.getByRole('button', { name: 'Open MyVault' }).click();
  const secureWindowPromise = application!.waitForEvent('window');
  await page.getByRole('button', { name: 'Unlock in secure window' }).click();
  const secureWindow = await secureWindowPromise;
  await secureWindow.getByLabel('Master password').fill(MASTER_PASSWORD);
  await secureWindow.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Unlocked on this device')).toBeVisible();

  const loginUrl = `${targetOrigin}/login`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  await expect.poll(() => readForm(loginUrl)).toEqual({
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
    submitted: false,
  });

  const occupiedUrl = `${targetOrigin}/occupied`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), occupiedUrl);
  expect(await settledForm(occupiedUrl)).toMatchObject({ username: 'typed-user', password: 'typed-password' });

  const rememberedEmailUrl = `${targetOrigin}/remembered-email`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), rememberedEmailUrl);
  await expect.poll(() => readForm(rememberedEmailUrl)).toMatchObject({ username: FIXTURE_USERNAME, password: FIXTURE_PASSWORD });

  const signupUrl = `${targetOrigin}/sign-up`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), signupUrl);
  expect(await settledForm(signupUrl)).toMatchObject({ username: '', password: '' });

  // The new-password form itself is refused, not only its /sign-up address.
  const changePasswordUrl = `${targetOrigin}/account/security`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), changePasswordUrl);
  expect(await settledForm(changePasswordUrl)).toMatchObject({ username: '', password: '' });

  await page.evaluate(() => window.privateBrowser.switchWorkspace('development'));
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  expect(await settledForm(loginUrl)).toMatchObject({ username: '', password: '' });
});
