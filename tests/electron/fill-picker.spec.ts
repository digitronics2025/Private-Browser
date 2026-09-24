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
let siblingOrigin: string;
let spkiHash: string;

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

/** Rows ignore clicks for this long after the list is drawn (F-34); a person reads first. */
const HUMAN_READ_MS = 700;

async function clickPickerRow(index: number, options: { immediately?: boolean } = {}): Promise<void> {
  if (!options.immediately) await new Promise((resolve) => setTimeout(resolve, HUMAN_READ_MS));
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
  // After a restart the side panel comes back already open on the vault.
  const unlockButton = page.getByRole('button', { name: 'Unlock in secure window' });
  if (!await unlockButton.isVisible()) await page.getByRole('button', { name: 'Open MyVault' }).click();
  const secureWindowPromise = application!.waitForEvent('window', {
    predicate: (candidate) => decodeURIComponent(candidate.url()).includes('<title>Unlock MyVault</title>'),
  });
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
    '-subj', '/CN=picker.example.test', '-addext', 'subjectAltName=DNS:picker.example.test,DNS:www.picker.example.test', '-days', '1',
  ], { encoding: 'utf8' });
  if (certificate.status !== 0) throw new Error(`Could not create the HTTPS fixture certificate: ${certificate.stderr}`);
  const cert = readFileSync(certPath);
  spkiHash = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
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
  siblingOrigin = `https://www.picker.example.test:${address.port}`;
  await writeVault([
    { id: 'newest-login', title: 'Newest', username: NEWEST_USERNAME, password: NEWEST_PASSWORD, updatedAt: '2026-09-20T12:00:00.000Z' },
    { id: 'other-login', title: 'Other', username: OTHER_USERNAME, password: OTHER_PASSWORD, updatedAt: '2026-09-10T12:00:00.000Z' },
  ]);
  await launch();
});

interface FixtureLogin { id: string; title: string; username: string; password: string; updatedAt: string }

async function writeVault(logins: FixtureLogin[]): Promise<void> {
  const payload = createEmptyVaultPayload();
  for (const item of logins) payload.items.push({ ...item, type: 'login', url: targetOrigin, folder: '', vault: 'Personal', favorite: false, tags: [] });
  const { envelope } = await createVault(MASTER_PASSWORD, payload, { memorySizeKiB: 8 * 1024, iterations: 1 });
  mkdirSync(join(userDataPath, 'myvault'), { recursive: true });
  writeFileSync(join(userDataPath, 'myvault', 'envelope.myvault'), JSON.stringify(envelope), 'utf8');
}

/** Start (or restart) the app on the same profile, so what it remembered on disk is kept. */
async function launch(): Promise<void> {
  const env = { ...process.env, NODE_ENV: 'test', PRIVATE_BROWSER_E2E_USER_DATA: userDataPath } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    args: [
      join(process.cwd(), 'dist-electron/main.js'),
      '--host-resolver-rules=MAP picker.example.test 127.0.0.1, MAP www.picker.example.test 127.0.0.1',
      '--no-proxy-server',
      `--ignore-certificate-errors-spki-list=${spkiHash}`,
    ],
    env,
  });
}

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

  // A click that arrives as the list appears (the second half of a double-click
  // a page asked for) picks nothing and leaves the list open.
  await clickPickerRow(1, { immediately: true });
  await expect.poll(pickerRows).toEqual([NEWEST_USERNAME, OTHER_USERNAME]);
  expect(await readForm(loginUrl)).toMatchObject({ username: NEWEST_USERNAME, password: NEWEST_PASSWORD });

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

/** The overlay's window rectangle and the clicked field's, both in window DIPs. */
async function pickerAndFieldBounds(target: string, selector: string) {
  return application!.evaluate(async ({ BrowserWindow }, { value, css }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const views = window.contentView.children as Electron.WebContentsView[];
    const pageView = views.find((view) => view.webContents.getURL() === value)!;
    const overlay = views.find((view) => view.webContents.getURL().startsWith('data:text/html') && decodeURIComponent(view.webContents.getURL()).includes('<title>Saved logins</title>'));
    const page = pageView.getBounds();
    const rect = await pageView.webContents.executeJavaScript(`JSON.parse(JSON.stringify(document.querySelector(${JSON.stringify(css)}).getBoundingClientRect()))`) as { x: number; y: number; width: number; height: number };
    return { overlay: overlay?.getBounds(), field: { x: page.x + rect.x, y: page.y + rect.y, width: rect.width, height: rect.height } };
  }, { value: target, css: selector });
}

test('a long list scrolls and never covers the field it belongs to', async () => {
  await application!.close();
  await writeVault(Array.from({ length: 12 }, (_, index) => ({
    id: `login-${index + 1}`,
    title: `Login ${index + 1}`,
    username: `user${index + 1}@example.test`,
    password: `password-${index + 1}-fixture`, // secret-guard:allow — inert E2E fixture
    updatedAt: `2026-09-${String(20 - index).padStart(2, '0')}T12:00:00.000Z`,
  })));
  await launch();
  const page = await application!.firstWindow();
  await unlock(page);
  const loginUrl = `${targetOrigin}/login`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  await expect.poll(() => readForm(loginUrl)).toMatchObject({ username: 'user1@example.test' });

  for (const selector of ['input[type="email"]', 'input[type="password"]']) {
    await clickField(loginUrl, selector);
    await expect.poll(async () => (await pickerRows())?.length).toBe(12);
    const { overlay, field } = await pickerAndFieldBounds(loginUrl, selector);
    const overlaps = overlay!.x < field.x + field.width && field.x < overlay!.x + overlay!.width
      && overlay!.y < field.y + field.height && field.y < overlay!.y + overlay!.height;
    expect(overlaps, `${selector} covered`).toBe(false);
    await pressKey(loginUrl, 'Escape');
    await expect.poll(pickerRows).toBeNull();
  }

  // The twelfth login is below the visible rows; the keyboard scrolls to it.
  await clickField(loginUrl, 'input[type="email"]');
  await expect.poll(async () => (await pickerRows())?.length).toBe(12);
  for (let index = 0; index < 12; index += 1) await pressKey(loginUrl, 'Down');
  await pressKey(loginUrl, 'Return');
  await expect.poll(() => readForm(loginUrl)).toEqual({ username: 'user12@example.test', password: 'password-12-fixture', submitted: false }); // secret-guard:allow — inert E2E fixture
});

test('offers logins saved for another address of the same site, but only on request', async () => {
  const page = await application!.firstWindow();
  await unlock(page);
  const siblingUrl = `${siblingOrigin}/login`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), siblingUrl);
  // Automatic fill stays exact-origin: nothing is filled on www. by itself.
  await page.waitForTimeout(1500);
  expect(await readForm(siblingUrl)).toMatchObject({ username: '', password: '' });

  await clickField(siblingUrl, 'input[type="email"]');
  await expect.poll(pickerRows).toEqual([NEWEST_USERNAME, OTHER_USERNAME]);
  const savedFor = await application!.evaluate(async ({ webContents }) => {
    const overlay = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith('data:text/html') && decodeURIComponent(candidate.getURL()).includes('<title>Saved logins</title>'));
    return overlay!.executeJavaScript(`[...document.querySelectorAll('.site')].map((node) => node.textContent)`) as Promise<string[]>;
  });
  expect(savedFor).toEqual([new URL(targetOrigin).host, new URL(targetOrigin).host]);
  await clickPickerRow(1);
  await expect.poll(() => readForm(siblingUrl)).toEqual({ username: OTHER_USERNAME, password: OTHER_PASSWORD, submitted: false });
});

test('remembers the login picked on a site after a restart, on every address of it', async () => {
  const page = await application!.firstWindow();
  await unlock(page);
  const loginUrl = `${targetOrigin}/login`;
  await page.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  await expect.poll(() => readForm(loginUrl)).toMatchObject({ username: NEWEST_USERNAME });
  await clickField(loginUrl, 'input[type="email"]');
  await expect.poll(pickerRows).not.toBeNull();
  await clickPickerRow(1);
  await expect.poll(() => readForm(loginUrl)).toMatchObject({ username: OTHER_USERNAME });

  await application!.close();
  await launch();
  // The restored login tab is also a window to Playwright; the chrome is the file:// one.
  await expect.poll(() => application!.windows().some((candidate) => candidate.url().startsWith('file:'))).toBe(true);
  const restarted = application!.windows().find((candidate) => candidate.url().startsWith('file:'))!;
  await unlock(restarted);
  await restarted.evaluate((target) => window.privateBrowser.navigate(target), loginUrl);
  await expect.poll(() => readForm(loginUrl)).toMatchObject({ username: OTHER_USERNAME, password: OTHER_PASSWORD });

  const siblingUrl = `${siblingOrigin}/login`;
  await restarted.evaluate((target) => window.privateBrowser.navigate(target), siblingUrl);
  await expect.poll(() => readForm(siblingUrl)).toMatchObject({ username: '' });
  await clickField(siblingUrl, 'input[type="email"]');
  await expect.poll(pickerRows).toEqual([OTHER_USERNAME, NEWEST_USERNAME]);
});
