import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';

/**
 * The Control Center link in the real app (docs/systems/control-center-link.md):
 * a stand-in Control Center on loopback signs with the committed test key,
 * found through runtime.json exactly as the real one is. Proves pairing, the
 * exact-context send, re-check, one approval per send, and that nothing
 * leaves from outside the Development workspace or from a non-developer
 * preview.
 */

const vectors = JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', 'acc-connected-app-v1.vectors.json'), 'utf8'));
const MARKER = `boom-${randomBytes(4).toString('hex')}`;

interface Received { path: string; headers: IncomingMessage['headers']; body: any }
const received: Received[] = [];
let controlCenter: Server;
let site: Server;
let controlCenterUrl = '';
let siteOrigin = '';
const token = randomBytes(32).toString('base64url');
const appId = 'e2e-app-0000000000001';
let taskStatus = 'RUNNING';

async function sign(purpose: string, nonce: string): Promise<string> {
  const key = await webcrypto.subtle.importKey('jwk', vectors.identity.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  return Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`acc-connected-app-v1 ${purpose}\n${appId}\n${nonce}`))).toString('base64url');
}

const readBody = (request: IncomingMessage) => new Promise<any>((resolve) => {
  let data = '';
  request.on('data', (chunk) => { data += chunk; });
  request.on('end', () => resolve(data ? JSON.parse(data) : undefined));
});

const task = () => ({ id: 'TASK-0001', title: 'The cart crashes', repositoryName: 'shop', status: taskStatus, currentStageName: taskStatus === 'COMPLETED' ? 'Complete' : 'Investigate', blocker: null, finalStatus: taskStatus === 'COMPLETED' ? 'READY' : null, createdAt: '2026-09-24T10:00:00.000Z', updatedAt: new Date().toISOString(), dashboardPath: '/tasks/TASK-0001' });

test.beforeAll(async () => {
  controlCenter = createServer(async (request, response) => {
    const body = await readBody(request);
    const path = new URL(request.url ?? '/', 'http://x').pathname;
    received.push({ path, headers: request.headers, body });
    const send = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path === '/api/connected-app/pair') return body?.code === '24681357' ? send(201, { appId, token, identityKey: vectors.identity.publicKey, signature: await sign('pair', body.nonce), kind: 'private-browser' }) : send(400, { error: { code: 'CODE_REJECTED', message: 'Code not accepted.' } });
    if (request.headers.authorization !== `Bearer ${token}`) return send(401, { error: { code: 'UNAUTHORIZED', message: 'no' } });
    if (path === '/api/connected-app/hello') return send(200, { appId, identityKey: vectors.identity.publicKey, signature: await sign('hello', body.nonce), name: 'Private Browser' });
    if (path === '/api/connected-app/repositories') return send(200, [{ id: 'repo-shop', name: 'shop', devOrigin: siteOrigin }, { id: 'repo-other', name: 'other', devOrigin: null }]);
    if (path === '/api/connected-app/tasks' && request.method === 'POST') return send(201, task());
    if (path === '/api/connected-app/tasks') return send(200, received.some((r) => r.path === '/api/connected-app/tasks' && r.body) ? [task()] : []);
    if (path === '/api/connected-app/tasks/TASK-0001/evidence') return send(201, { artifactId: 'a1', name: 'browser-recheck-1.md', created: true });
    return send(404, { error: { code: 'NOT_FOUND', message: 'nope' } });
  });
  await new Promise<void>((ready) => controlCenter.listen(0, '127.0.0.1', ready));
  controlCenterUrl = `http://127.0.0.1:${(controlCenter.address() as AddressInfo).port}`;
  site = createServer((request, response) => {
    if (request.url?.startsWith('/missing')) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>Cart</title><main><h1>Cart</h1><button id="pay">Pay</button></main><script>console.error('${MARKER}'); fetch('/missing.json');</script>`);
  });
  await new Promise<void>((ready) => site.listen(0, '127.0.0.1', ready));
  siteOrigin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise((done) => controlCenter.close(done));
  await new Promise((done) => site.close(done));
});

async function launch(): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
  const profile = mkdtempSync(join(tmpdir(), 'private-browser-cc-'));
  mkdirSync(join(profile, 'AIDevControlCenter'), { recursive: true });
  writeFileSync(join(profile, 'AIDevControlCenter', 'runtime.json'), JSON.stringify({ url: controlCenterUrl, port: 0, pid: 0 }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.PRIVATE_BROWSER_E2E_USER_DATA = join(profile, 'user-data');
  env.LOCALAPPDATA = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: ['dist-electron/main.js'], env });
  const page = await app.firstWindow();
  await expect(page.getByText('Private Browser', { exact: true }).first()).toBeVisible();
  return { app, page, profile };
}

async function openTasksPanel(page: Page) {
  const panelToggle = page.getByRole('button', { name: 'Side panel', exact: true });
  if ((await panelToggle.getAttribute('aria-pressed')) !== 'true') await panelToggle.click();
  await page.getByTitle('Developer cockpit').click();
  await expect(page.getByRole('heading', { name: 'Developer Bridge' })).toBeVisible();
  await page.getByRole('tab', { name: 'Tasks' }).click();
}

test('pairs, sends the exact approved context, follows the task and attaches a re-check', async () => {
  const { app, page, profile } = await launch();
  try {
    await page.evaluate(() => window.privateBrowser.switchWorkspace('development'));
    await page.evaluate((url) => window.privateBrowser.navigate(url), `${siteOrigin}/cart?session=secret-value#top`);
    await expect.poll(() => page.evaluate(async () => { const s = await window.privateBrowser.getState(); return s.tabs.find((t) => t.id === s.activeTabId)?.developerToolsAllowed; })).toBe(true);
    await openTasksPanel(page);

    await expect(page.getByText('Control Center not paired')).toBeVisible();
    await page.getByLabel('Pairing code').fill('24681357');
    await page.getByRole('button', { name: 'Pair', exact: true }).last().click();
    await expect(page.getByText('Control Center connected')).toBeVisible();
    await expect(page.getByText(/^Key ([0-9A-F]{4} ){7}[0-9A-F]{4}$/)).toBeVisible();

    // The repository whose address matches this page is suggested.
    await expect(page.getByLabel('Repository')).toHaveValue('repo-shop');
    await page.getByLabel('What should be fixed').fill('The cart logs an error on load');
    await page.getByRole('button', { name: 'Preview what will be sent' }).click();
    await expect(page.getByText(/EXACT CONTEXT/)).toBeVisible();
    await expect(page.locator('.ai-context-preview pre').first()).toContainText(MARKER);
    await page.getByRole('button', { name: 'Send to Control Center' }).click();
    await expect.poll(() => received.filter((r) => r.path === '/api/connected-app/tasks' && r.body).length).toBe(1);
    const sent = received.find((r) => r.path === '/api/connected-app/tasks' && r.body)!;
    expect(sent.body).toMatchObject({ repositoryId: 'repo-shop', note: 'The cart logs an error on load', sourceUrl: `${siteOrigin}/cart` });
    expect(sent.body.evidence).toContain(MARKER);
    expect(JSON.stringify(sent.body)).not.toContain('secret-value');
    expect(sent.body.screenshotJpegBase64).toBeUndefined();
    // Every call came from the main process: no Origin, bearer only after pairing.
    expect(received.every((r) => r.headers.origin === undefined)).toBe(true);

    // The task shows; once it finishes, Check again attaches fresh evidence.
    await expect(page.getByText('TASK-0001 · The cart crashes')).toBeVisible({ timeout: 10_000 });
    taskStatus = 'COMPLETED';
    await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText(/RE-CHECK FOR TASK-0001/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Attach to TASK-0001' }).click();
    await expect.poll(() => received.filter((r) => r.path === '/api/connected-app/tasks/TASK-0001/evidence').length).toBe(1);
    expect(received.find((r) => r.path === '/api/connected-app/tasks/TASK-0001/evidence')!.body.evidence).toContain(MARKER);

    // Optional evidence for a person to look at: the chrome window only, never the whole screen.
    if (process.env.PB_EVIDENCE_DIR) {
      mkdirSync(process.env.PB_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.PB_EVIDENCE_DIR, 'control-center-tasks-dark.png') });
      await page.evaluate(() => window.privateBrowser.setUiPreferences({ theme: 'light' }));
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(process.env.PB_EVIDENCE_DIR, 'control-center-tasks-light.png') });
    }

    // The token never reached the renderer.
    const status = await page.evaluate(() => window.privateBrowser.getControlCenterStatus());
    expect(JSON.stringify(status)).not.toContain(token);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('one approval sends once, only Developer previews go, and nothing leaves outside Development', async () => {
  const { app, page, profile } = await launch();
  try {
    await page.evaluate(() => window.privateBrowser.switchWorkspace('development'));
    await page.evaluate((url) => window.privateBrowser.navigate(url), `${siteOrigin}/cart`);
    await expect.poll(() => page.evaluate(async () => { const s = await window.privateBrowser.getState(); return s.tabs.find((t) => t.id === s.activeTabId)?.developerToolsAllowed; })).toBe(true);
    await page.evaluate(() => window.privateBrowser.pairControlCenter('24681357'));
    const before = received.filter((r) => r.path === '/api/connected-app/tasks' && r.body).length;

    const outcome = await page.evaluate(async () => {
      const api = window.privateBrowser;
      const result: Record<string, string> = {};
      const attempt = async (label: string, run: () => Promise<unknown>) => { try { await run(); result[label] = 'sent'; } catch (error) { result[label] = error instanceof Error ? error.message : String(error); } };
      const preview = await api.prepareDeveloperAiPreview({ includeDom: false, includeScreenshot: false });
      const approval = await api.approveAiPreview(preview.id);
      const input = { approvalToken: approval.token, repositoryId: 'repo-shop', note: 'Once only' };
      await attempt('first', () => api.sendToControlCenter(input));
      await attempt('replay', () => api.sendToControlCenter(input));
      // An ordinary page preview (not the Developer panel's) is refused, and its approval is spent anyway.
      const plain = await api.prepareAiPreview();
      const plainApproval = await api.approveAiPreview(plain.id);
      await attempt('plain', () => api.sendToControlCenter({ approvalToken: plainApproval.token, repositoryId: 'repo-shop', note: 'Plain' }));
      // Banking: the request is refused before any approval is looked at.
      const developer = await api.prepareDeveloperAiPreview({ includeDom: false, includeScreenshot: false });
      const developerApproval = await api.approveAiPreview(developer.id);
      await api.switchWorkspace('banking');
      await attempt('banking', () => api.sendToControlCenter({ approvalToken: developerApproval.token, repositoryId: 'repo-shop', note: 'From Banking' }));
      await attempt('bankingTasks', () => api.listControlCenterTasks());
      return result;
    });
    expect(outcome.first).toBe('sent');
    expect(outcome.replay).toMatch(/approval expired/i);
    expect(outcome.plain).toMatch(/Only Developer panel diagnostics/);
    expect(outcome.banking).toMatch(/Development workspace/);
    expect(outcome.bankingTasks).toMatch(/Development workspace/);
    expect(received.filter((r) => r.path === '/api/connected-app/tasks' && r.body).length).toBe(before + 1);

    // Banking shows no Control Center controls at all.
    const panelToggle = page.getByRole('button', { name: 'Side panel', exact: true });
    if ((await panelToggle.getAttribute('aria-pressed')) !== 'true') await panelToggle.click();
    await page.getByTitle('Developer cockpit').click();
    await expect(page.getByText('Protected by workspace policy')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Tasks' })).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
