import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyVaultPayload, createVault } from '../../electron/myvault/security/vault-crypto';
import type { VaultEnvelope } from '../../electron/myvault/types';

const MASTER_PASSWORD = 'autofill fixture password'; // secret-guard:allow — inert E2E fixture
const FIXTURE_USERNAME = 'saved-user@example.test';
const FIXTURE_PASSWORD = 'saved-password-fixture'; // secret-guard:allow — inert E2E fixture

let application: ElectronApplication | undefined;
let launchFixture: () => Promise<ElectronApplication>;
let userDataPath: string;
let server: Server;
let targetOrigin: string;
let serviceOrigin: string;
let fixtureEnvelope: VaultEnvelope;
const fixtureId = '00000000-0000-4000-8000-000000000001';
const fixtureDeviceToken = ['mvd', fixtureId, 'a'.repeat(43)].join('_');

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
    '-subj', '/CN=autofill.example.test', '-addext', 'subjectAltName=DNS:autofill.example.test,IP:127.0.0.1', '-days', '1',
  ], { encoding: 'utf8' });
  if (certificate.status !== 0) throw new Error(`Could not create the HTTPS fixture certificate: ${certificate.stderr}`);
  const cert = readFileSync(certPath);
  const spkiHash = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  server = createServer({ key: readFileSync(keyPath), cert }, (request, response) => {
    if (request.url === '/api/v1/devices/redeem' && request.method === 'POST') {
      request.resume();
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ token: fixtureDeviceToken, device: { id: fixtureId, label: 'Test device', scope: 'read-write' } }));
      return;
    }
    if (request.url === '/api/v1/vault' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ envelope: fixtureEnvelope, version: 1, updatedAt: new Date().toISOString() }));
      return;
    }
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
  serviceOrigin = `https://127.0.0.1:${address.port}`;
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
  fixtureEnvelope = envelope;
  mkdirSync(join(userDataPath, 'myvault'), { recursive: true });
  const env = { ...process.env, NODE_ENV: 'test', PRIVATE_BROWSER_E2E_USER_DATA: userDataPath, NODE_EXTRA_CA_CERTS: certPath } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  launchFixture = () => electron.launch({
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

test('generates a credential in the isolated editor and saves only after explicit approval', async () => {
  application = await launchFixture();
  const page = await application!.firstWindow();
  await page.getByRole('button', { name: 'Open MyVault' }).click();
  const pairingWindowPromise = application!.waitForEvent('window');
  const paired = page.evaluate(() => window.privateBrowser.requestVaultPairing());
  const pairing = await pairingWindowPromise;
  await pairing.getByLabel('MyVault address').fill(serviceOrigin);
  await pairing.getByLabel('One-time enrollment code').fill(['mve', fixtureId, 'b'.repeat(43)].join('_'));
  await pairing.getByLabel('Master password').fill(MASTER_PASSWORD);
  await pairing.getByRole('button', { name: 'Connect securely' }).click();
  await expect(paired).resolves.toMatchObject({ lifecycle: 'unlocked' });
  await expect(page.getByText('Unlocked on this device')).toBeVisible();

  const settingsPage = targetOrigin + '/account/security';
  await page.evaluate((target) => window.privateBrowser.navigate(target), settingsPage);
  const editorWindowPromise = application!.waitForEvent('window');
  const saved = page.evaluate((origin) => window.privateBrowser.openVaultEditor(origin), targetOrigin);
  const editor = await editorWindowPromise;
  await editor.getByText('Generate a credential', { exact: true }).click();
  await editor.getByLabel('Preset').selectOption('passphrase');
  await editor.getByRole('button', { name: 'Generate', exact: true }).click();
  const passwordField = editor.locator('input[name="password"]');
  await expect.poll(() => passwordField.evaluate((input: HTMLInputElement) => input.value.split('-').length)).toBe(16);
  await editor.getByLabel('Preset').selectOption('pin');
  await editor.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect.poll(() => passwordField.evaluate((input: HTMLInputElement) => /^\d{8}$/.test(input.value))).toBe(true);
  await editor.getByLabel('Preset').selectOption('compatible');
  await editor.getByRole('button', { name: 'Generate', exact: true }).click();
  const save = editor.getByRole('button', { name: 'Save generated login' });
  await expect(save).toBeVisible();
  await expect.poll(() => passwordField.evaluate((input: HTMLInputElement) => ({
    length: input.value.length, alphanumeric: /^[a-z0-9]+$/i.test(input.value),
  }))).toEqual({ length: 24, alphanumeric: true });
  expect(await page.evaluate(() => 'secureVault' in window)).toBe(false);
  expect(await page.evaluate(async () => (await window.privateBrowser.listVault()).items.length)).toBe(1);
  expect((await readForm(settingsPage)).password).toBe('');

  await editor.getByLabel('Name', { exact: true }).fill('Generated fixture login');
  await editor.getByLabel('Website origin').fill(targetOrigin);
  await editor.getByLabel('Username or email').fill('generated@example.test');
  const authenticator = editor.getByLabel('Authenticator secret (optional)');
  await authenticator.fill('ABCDEFGH IJKLMNO0');
  await expect(editor.getByText('Enter a valid Base32 authenticator secret.')).toBeVisible();
  await expect(authenticator).toHaveJSProperty('validationMessage', 'Enter a valid Base32 authenticator secret.');
  await authenticator.fill('abcd efgh-ijkl mnop');
  await expect(authenticator).toHaveJSProperty('validationMessage', '');
  expect(await editor.locator('input:invalid').count()).toBe(0);
  await save.click();
  await expect(saved).resolves.toMatchObject({ label: 'Generated fixture login', hasTotp: true });
  const items = await page.evaluate(async () => (await window.privateBrowser.listVault()).items);
  expect(items.some((item) => item.label === 'Generated fixture login')).toBe(true);
  expect((await readForm(settingsPage)).password).toBe('');

  await page.evaluate(() => window.privateBrowser.navigate('private://home'));
  await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();
  const manualWindowPromise = application!.waitForEvent('window');
  const cancelled = page.evaluate(() => window.privateBrowser.openVaultEditor());
  const manual = await manualWindowPromise;
  await expect(manual.getByRole('heading', { name: 'Save in MyVault' })).toBeVisible();
  await expect(manual.getByText('Generate a credential', { exact: true })).toHaveCount(0);
  await manual.getByRole('button', { name: 'Cancel' }).click();
  await expect(cancelled).resolves.toBeUndefined();
});

test('automatically fills only safe empty HTTPS login forms without submitting', async () => {
  writeFileSync(join(userDataPath, 'myvault', 'envelope.myvault'), JSON.stringify(fixtureEnvelope), 'utf8');
  application = await launchFixture();
  const page = await application!.firstWindow();
  await page.getByRole('button', { name: 'Open MyVault' }).click();
  await expect(page.getByText('Vault locked', { exact: true })).toBeVisible();
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
  await expect.poll(() => page.evaluate(() => window.privateBrowser.vaultFillReadiness())).toBe('ready');
  const resetRememberedPicks = () => page.evaluate(async () => {
    const api = window.privateBrowser;
    const { activeAccountSpaceId } = await api.getState();
    return api.resetVaultPicks(activeAccountSpaceId);
  });
  await page.evaluate(async () => {
    const api = window.privateBrowser;
    const { items } = await api.listVault();
    await api.autofill(items[0].id);
  });
  await expect(resetRememberedPicks()).resolves.toBe(true);
  await expect(resetRememberedPicks()).resolves.toBe(false);

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
  await expect.poll(() => page.evaluate(() => window.privateBrowser.vaultFillReadiness())).toBe('unsupported');

  await page.evaluate(() => window.privateBrowser.switchWorkspace('development'));
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  expect(await settledForm(loginUrl)).toMatchObject({ username: '', password: '' });
  await expect(page.evaluate(() => window.privateBrowser.vaultFillReadiness())).resolves.toBe('unavailable');
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  await expect.poll(() => page.evaluate(() => window.privateBrowser.vaultFillReadiness())).toBe('manual');
  expect(await settledForm(loginUrl)).toMatchObject({ username: '', password: '' });
});

test('protects a disposable Windows vault copy and clears it on quit', async () => {
  test.skip(process.platform !== 'win32' || !process.env.CI, 'The hosted Windows runner provides a disposable system clipboard.');
  writeFileSync(join(userDataPath, 'myvault', 'envelope.myvault'), JSON.stringify(fixtureEnvelope), 'utf8');
  application = await launchFixture();
  const page = await application.firstWindow();
  await page.getByRole('button', { name: 'Open MyVault' }).click();
  const secureWindowPromise = application.waitForEvent('window');
  await page.getByRole('button', { name: 'Unlock in secure window' }).click();
  const secureWindow = await secureWindowPromise;
  await secureWindow.getByLabel('Master password').fill(MASTER_PASSWORD);
  await secureWindow.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Unlocked on this device')).toBeVisible();

  await page.locator('.credential-card').getByRole('button', { name: 'Password', exact: true }).click();
  await expect(page.getByText(/Vault clipboard clears in \d+s/)).toBeVisible();
  const format = 'electron application/osclipboard;format="ExcludeClipboardContentFromMonitorProcessing"';
  const nativeMarker = () => application!.evaluate(({ clipboard }, marker) => clipboard.has(marker), format);
  await expect(nativeMarker()).resolves.toBe(true);
  await page.getByRole('button', { name: 'Clear now', exact: true }).click();
  await expect(nativeMarker()).resolves.toBe(false);

  await page.locator('.credential-card').getByRole('button', { name: 'Password', exact: true }).click();
  await expect(nativeMarker()).resolves.toBe(true);
  await application.close();
  application = await launchFixture();
  await expect(nativeMarker()).resolves.toBe(false);
  await expect(application.evaluate(async ({ clipboard }, value) => (await clipboard.readText()) === value, FIXTURE_PASSWORD)).resolves.toBe(false);
});
