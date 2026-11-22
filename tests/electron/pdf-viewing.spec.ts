import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function samplePdf(): Buffer {
  const stream = 'BT /F1 20 Tf 28 190 Td (Private Browser invoice fixture) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 240] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = body.length;
    body += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
    return offset;
  });
  return Buffer.from(body + 'xref\n0 6\n0000000000 65535 f \n'
    + offsets.map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
    + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + body.length + '\n%%EOF\n');
}

const sample = samplePdf();
let app: ElectronApplication;
let profile: string;
let origin: string;
let server: Server;

test.beforeEach(async () => {
  profile = mkdtempSync(join(tmpdir(), 'private-browser-pdf-view-'));
  server = createServer((request, response) => {
    if (request.url === '/embed') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<title>Embedded PDF fixture</title><iframe src="/invoice.pdf"></iframe><embed type="application/pdf" src="data:application/pdf;base64,'
        + sample.toString('base64') + '">');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': sample.length });
    response.end(sample);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('PDF fixture did not bind to loopback');
  origin = 'http://127.0.0.1:' + address.port;
  const env = { ...process.env, LOCALAPPDATA: join(profile, 'local') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), '--user-data-dir=' + profile, '--no-proxy-server'], env });
});

test.afterEach(async () => {
  await app?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const nativeFrames = () => app.evaluate(({ webContents }, url) => webContents.getAllWebContents()
  .filter((contents) => contents.getURL().startsWith(url))
  .flatMap((contents) => contents.mainFrame.framesInSubtree.filter((frame) => frame.url.startsWith('chrome-extension:')).map(() => 'PDF frame')), origin);

test('regular PDF opens in the native viewer and saves through download permission', async () => {
  const chrome = await app.firstWindow();
  await expect(chrome.getByRole('main', { name: 'New Tab' })).toBeVisible();
  await chrome.evaluate((url) => window.privateBrowser.navigate(url), origin + '/invoice.pdf');
  const state = () => chrome.evaluate(() => window.privateBrowser.getState());
  await expect.poll(nativeFrames).toEqual(['PDF frame']);
  expect((await state()).pdfDocument).toEqual({ mode: 'native', canOpen: true });
  await chrome.getByRole('button', { name: 'Browser menu', exact: true }).click();
  await expect(chrome.getByRole('menuitem', { name: /^Print/ })).toBeEnabled();
  await app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
    contents.print = () => { Reflect.set(contents, 'fixturePrintRequested', true); };
  }, origin + '/invoice.pdf');
  await chrome.getByRole('menuitem', { name: /^Print/ }).click();
  await expect.poll(() => app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    return contents && Reflect.get(contents, 'fixturePrintRequested');
  }, origin + '/invoice.pdf')).toBe(true);
  await chrome.getByRole('button', { name: 'Browser menu', exact: true }).click();
  await expect(chrome.getByRole('menuitem', { name: /^Find/ })).toBeEnabled();
  await chrome.getByRole('menuitem', { name: /^Find/ }).click();
  await chrome.getByRole('textbox', { name: 'Find in page' }).fill('Browser invoice fixture');
  await expect(chrome.getByRole('search', { name: 'Find in page' })).toContainText('1/1');
  await chrome.getByRole('textbox', { name: 'Find in page' }).press('Escape');
  await chrome.getByRole('button', { name: 'Browser menu', exact: true }).click();
  await chrome.getByRole('menuitem', { name: 'Open PDF in new tab' }).click();
  await expect.poll(nativeFrames).toEqual(['PDF frame', 'PDF frame']);
  const path = join(profile, 'approved-invoice.pdf');
  await app.evaluate(({ webContents }, { url, path }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url)!;
    contents.session.once('will-download', () => contents.session.once('will-download', (_event, item) => item.setSavePath(path)));
  }, { url: origin + '/invoice.pdf', path });
  await chrome.getByRole('button', { name: 'Browser menu', exact: true }).click();
  await chrome.getByRole('menuitem', { name: /^Save PDF/ }).click();
  await expect.poll(() => state().then(({ pendingPermission }) => pendingPermission?.capability)).toBe('download');
  await chrome.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect.poll(() => state().then(({ downloads }) => downloads[0]?.state)).toBe('completed');
  expect(readFileSync(path)).toEqual(sample);
});

test('Banking isolates PDF rendering and blocks native and embedded saving paths', async () => {
  const chrome = await app.firstWindow();
  await expect(chrome.getByRole('main', { name: 'New Tab' })).toBeVisible();
  await chrome.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await chrome.evaluate((url) => window.privateBrowser.navigate(url), origin + '/embed');
  await expect.poll(async () => chrome.evaluate(() => window.privateBrowser.getState().then(({ tabs }) => tabs[0]?.title))).toBe('Embedded PDF fixture');
  expect(await nativeFrames()).toEqual([]);
  await chrome.evaluate((url) => window.privateBrowser.navigate(url), origin + '/invoice.pdf');
  await expect(chrome.getByRole('heading', { name: 'Protected PDF', exact: true })).toBeVisible();
  expect(await nativeFrames()).toEqual([]);
  await expect(chrome.evaluate(() => window.privateBrowser.savePdf())).rejects.toThrow(/Saving is unavailable/);
  await expect(chrome.evaluate(() => window.privateBrowser.print())).rejects.toThrow(/Printing is blocked/);
  const viewerReady = app.waitForEvent('window');
  await chrome.getByRole('button', { name: 'Open protected preview', exact: true }).click();
  const viewer = await viewerReady;
  await expect(viewer.getByRole('status')).toHaveText('Page 1 of 1');
  await expect(viewer.getByRole('button', { name: /print|save|download/i })).toHaveCount(0);
  await viewer.getByRole('searchbox', { name: 'Find text' }).fill('invoice');
  await viewer.getByRole('button', { name: 'Find', exact: true }).click();
  await expect(viewer.getByRole('status')).toHaveText('Match on page 1 of 1');
  await viewer.keyboard.press('Control+s');
  await viewer.keyboard.press('Control+p');
  expect((await chrome.evaluate(() => window.privateBrowser.getState())).downloads).toEqual([]);
});
