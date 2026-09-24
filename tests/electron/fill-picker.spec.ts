import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyVaultPayload, createVault } from '../../electron/myvault/security/vault-crypto';

const MASTER_PASSWORD = 'picker fixture password'; // secret-guard:allow — inert E2E fixture
const NEWEST_USERNAME = 'newest-user@example.test';
const NEWEST_PASSWORD = 'newest-password-fixture'; // secret-guard:allow — inert E2E fixture
const OTHER_USERNAME = 'other-user@example.test';
const OTHER_PASSWORD = 'other-password-fixture'; // secret-guard:allow — inert E2E fixture
const ROW_HEIGHT = 52;
const PADDING = 6;

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

/** What the page's own scripts can see of the document — the usernames must never be in it. */
async function pageText(target: string): Promise<string> {
  return application!.evaluate(async ({ webContents }, value) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === value);
    return contents ? contents.executeJavaScript('document.documentElement.outerHTML + document.body.innerText') : '';
  }, target);
}

async function pageHasFocus(target: string): Promise<boolean> {
  return application!.evaluate(({ webContents }, value) => Boolean(webContents.getAllWebContents().find((candidate) => candidate.getURL() === value)?.isFocused()), target);
}

/** A real click, delivered as OS-style input to the page view rather than a DOM event. */
async function clickField(target: string, selector: string): Promise<void> {
  await application!.evaluate(async ({ webContents }, { value, css }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === value);
    if (!contents) throw new Error('page not found');
    const point = await contents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(css)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`) as { x: number; y: number };
    contents.focus();
    contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  }, { value: target, css: selector });
}

async function pressKey(target: string, keyCode: string): Promise<void> {
  await application!.evaluate(({ webContents }, { value, key }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === value);
    if (!contents) throw new Error('page not found');
    contents.sendInputEvent({ type: 'keyDown', keyCode: key });
    contents.sendInputEvent({ type: 'keyUp', keyCode: key });
  }, { value: target, key: keyCode });
}

/** Usernames listed by the open picker overlay, or null when no picker exists. */
async function pickerRows(): Promise<string[] | null> {
  return application!.evaluate(async ({ webContents }) => {
    const overlay = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed()
      && candidate.getURL().startsWith('data:text/html') && decodeURIComponent(candidate.getURL()).includes('<title>Saved logins</title>'));
    if (!overlay || overlay.isLoading()) return null;
    return overlay.executeJavaScript(`[...document.querySelectorAll('.user')].map((node) => node.textContent)`) as Promise<string[]>;
  });
}

async function clickPickerRow(index: number): Promise<void> {
  await application!.evaluate(({ webContents }, { row, rowHeight, padding }) => {
    const overlay = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed()
      && candidate.getURL().startsWith('data:text/html') && decodeURIComponent(candidate.getURL()).includes('<title>Saved logins</title>'));
    if (!overlay) throw new Error('picker not open');
    const y = padding + row * rowHeight + rowHeight / 2;
    overlay.sendInputEvent({ type: 'mouseDown', x: 40, y, button: 'left', clickCount: 1 });
    overlay.sendInputEvent({ type: 'mouseUp', x: 40, y, button: 'left', clickCount: 1 });
  }, { row: index, rowHeight: ROW_HEIGHT, padding: PADDING });
}

async function unlock(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open MyVault' }).click();
  const secureWindowPromise = application!.waitForEvent('window');
  await page.getByRole('button', { name: 'Unlock in secure window' }).click();
  const secureWindow = await secureWindowPromise;
  await secureWindow.getByLabel('Master password').fill(MASTER_PASSWORD);
  await secureWindow.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Unlocked on this device')).toBeVisible();
}

test.beforeEach(async () => {
  userDataPath = mkdtempSync(join(tmpdir(), 'private-browser-picker-'));
  const keyPath = join(userDataPath, 'fixture-key.pem');
  const certPath = join(userDataPath, 'fixture-cert.pem');
  const openssl = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
  const certificate = spawnSync(openssl, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=picker.example.test', '-addext', 'subjectAltName=DNS:picker.example.test', '-days', '1',
  ], { encoding: 'utf8' });
  if (certificate.status !== 0) throw new Error(`Could not create the HTTPS fixture certificate: ${certificate.stderr}`);
  const cert = readFileSync(certPath);
  const spkiHash = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  server = createServer({ key: readFileSync(keyPath), cert }, (request, response) => {
    const sharedHead = '<!doctype html><meta charset="utf-8"><title>Picker fixture</title><style>input{display:block;width:360px;height:40px;margin:24px}</style>';
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/login' || request.url === '/other') {
      response.end(`${sharedHead}<form><input name="email" type="email" autocomplete="username"><input name="password" type="password" autocomplete="current-password"><button>Sign in</button></form>
        <script>window.__submitted = false; document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.__submitted = true; });</script>`);
      return;
    }
    response.end(`${sharedHead}<form><input name="email" type="email" autocomplete="username"><input name="password" type="password" autocomplete="new-password"></form>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not bind to TCP');
  targetOrigin = `https://picker.example.test:${address.port}`;
  const payload = createEmptyVaultPayload();
  const login = { type: 'login' as const, url: targetOrigin, folder: '', vault: 'Personal', favorite: false, tags: [] };
  payload.items.push(
    { ...login, id: 'newest-login', title: 'Newest', username: NEWEST_USERNAME, password: NEWEST_PASSWORD, updatedAt: '2026-09-20T12:00:00.000Z' },
    { ...login, id: 'other-login', title: 'Other', username: OTHER_USERNAME, password: OTHER_PASSWORD, updatedAt: '2026-09-10T12:00:00.000Z' },
  );
  const { envelope } = await createVault(MASTER_PASSWORD, payload, { memorySizeKiB: 8 * 1024, iterations: 1 });
  mkdirSync(join(userDataPath, 'myvault'), { recursive: true });
  writeFileSync(join(userDataPath, 'myvault', 'envelope.myvault'), JSON.stringify(envelope), 'utf8');
  const env = { ...process.env, NODE_ENV: 'test', PRIVATE_BROWSER_E2E_USER_DATA: userDataPath } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    args: [
      join(process.cwd(), 'dist-electron/main.js'),
      '--host-resolver-rules=MAP picker.example.test 127.0.0.1',
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

test('lists every saved login under the field and fills the one chosen, without the page seeing the list', async () => {
  const page = await application!.firstWindow();
  await unlock(page);
  const loginUrl = `${targetOrigin}/login`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  // Automatic fill still picks the newest login first.
  await expect.poll(() => readForm(loginUrl)).toMatchObject({ username: NEWEST_USERNAME, password: NEWEST_PASSWORD });

  await clickField(loginUrl, 'input[type="email"]');
  await expect.poll(pickerRows).toEqual([NEWEST_USERNAME, OTHER_USERNAME]);
  expect(await pageText(loginUrl)).not.toContain(OTHER_USERNAME);
  // Typing must still land in the field: the overlay never keeps keyboard focus.
  await expect.poll(() => pageHasFocus(loginUrl)).toBe(true);

  await clickPickerRow(1);
  await expect.poll(() => readForm(loginUrl)).toEqual({ username: OTHER_USERNAME, password: OTHER_PASSWORD, submitted: false });
  await expect.poll(pickerRows).toBeNull();

  // The choice is remembered for the site: it now leads the list.
  await clickField(loginUrl, 'input[type="password"]');
  await expect.poll(pickerRows).toEqual([OTHER_USERNAME, NEWEST_USERNAME]);
});

test('is driven from the keyboard while focus stays in the page', async () => {
  const page = await application!.firstWindow();
  await unlock(page);
  const loginUrl = `${targetOrigin}/login`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  await expect.poll(() => readForm(loginUrl)).toMatchObject({ username: NEWEST_USERNAME });

  await clickField(loginUrl, 'input[type="email"]');
  await expect.poll(pickerRows).not.toBeNull();
  await pressKey(loginUrl, 'Escape');
  await expect.poll(pickerRows).toBeNull();

  await clickField(loginUrl, 'input[type="email"]');
  await expect.poll(pickerRows).not.toBeNull();
  await pressKey(loginUrl, 'Down');
  await pressKey(loginUrl, 'Down');
  await pressKey(loginUrl, 'Return');
  await expect.poll(() => readForm(loginUrl)).toEqual({ username: OTHER_USERNAME, password: OTHER_PASSWORD, submitted: false });
});

test('closes when the page navigates away', async () => {
  const page = await application!.firstWindow();
  await unlock(page);
  const loginUrl = `${targetOrigin}/login`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  await expect.poll(() => readForm(loginUrl)).toMatchObject({ username: NEWEST_USERNAME });
  await clickField(loginUrl, 'input[type="email"]');
  await expect.poll(pickerRows).not.toBeNull();

  const otherUrl = `${targetOrigin}/other`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), otherUrl);
  await expect.poll(pickerRows).toBeNull();
});

test('never opens on a new-password form or in Banking', async () => {
  const page = await application!.firstWindow();
  await unlock(page);
  const signupUrl = `${targetOrigin}/sign-up`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), signupUrl);
  await expect.poll(() => readForm(signupUrl)).toMatchObject({ username: '', password: '' });
  await clickField(signupUrl, 'input[type="email"]');
  await page.waitForTimeout(500);
  expect(await pickerRows()).toBeNull();

  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  const loginUrl = `${targetOrigin}/login`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  await expect.poll(() => readForm(loginUrl)).toMatchObject({ username: '', password: '' });
  await clickField(loginUrl, 'input[type="email"]');
  await page.waitForTimeout(500);
  expect(await pickerRows()).toBeNull();
});
