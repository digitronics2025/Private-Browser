import { BrowserWindow, ipcMain, session, type IpcMainEvent, type Session } from 'electron';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const maxPdfBytes = 12 * 1024 * 1024;
const viewFile = join(import.meta.dirname, '../dist/pdf-view.html');
const exactViewerUrl = pathToFileURL(viewFile).href;
const viewerAssets = pathToFileURL(join(import.meta.dirname, '../dist/assets') + sep).href;
type HttpHeaders = Record<string, string[]>;

export interface PdfDocumentStatus {
  mode: 'native' | 'protected';
  canOpen: boolean;
}

export function pdfResponse(headers: HttpHeaders | undefined): boolean {
  return Boolean(headers && Object.entries(headers).some(([key, values]) =>
    key.toLowerCase() === 'content-type' && values.some((value) => value.split(';', 1)[0].trim().toLowerCase() === 'application/pdf')));
}

export function blockInlinePdf(headers: HttpHeaders | undefined): HttpHeaders {
  const output = { ...headers };
  const csp = Object.keys(output).find((key) => key.toLowerCase() === 'content-security-policy') ?? 'Content-Security-Policy';
  output[csp] = [...(output[csp] ?? []), "object-src 'none'; frame-src http: https: about:"];
  return output;
}

async function readPdf(source: Session, url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await source.fetch(url, { method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store',
    headers: { Accept: 'application/pdf' }, signal });
  if (!response.ok || !response.body || !pdfResponse({ 'content-type': [response.headers.get('content-type') ?? ''] })) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('The original site did not return a readable PDF.');
  }
  if (Number(response.headers.get('content-length')) > maxPdfBytes) {
    await response.body.cancel().catch(() => undefined);
    throw new Error('This PDF exceeds the 12 MiB protected preview limit.');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPdfBytes) throw new Error('This PDF exceeds the 12 MiB protected preview limit.');
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, size);
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
      bytes.fill(0);
      throw new Error('The original site did not return a readable PDF.');
    }
    return bytes;
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    await reader.cancel().catch(() => undefined);
  }
}

export class ProtectedPdfPreview {
  private active?: { abort: AbortController; window?: BrowserWindow };
  private viewerSession?: Session;

  private rendererSession(): Session {
    if (this.viewerSession) return this.viewerSession;
    const isolated = session.fromPartition('private-browser-protected-pdf');
    isolated.webRequest.onBeforeRequest((details, reply) => reply({
      cancel: details.url !== exactViewerUrl && !details.url.startsWith(viewerAssets),
    }));
    isolated.setPermissionRequestHandler((_page, _permission, reply) => reply(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on('will-download', (event) => event.preventDefault());
    this.viewerSession = isolated;
    return isolated;
  }

  close(): void {
    const active = this.active;
    this.active = undefined;
    active?.abort.abort();
    if (active?.window && !active.window.isDestroyed()) active.window.destroy();
  }

  async open(parent: BrowserWindow, source: Session, url: string, current: () => boolean): Promise<void> {
    this.close();
    const active: NonNullable<ProtectedPdfPreview['active']> = { abort: new AbortController() };
    this.active = active;
    const assertCurrent = () => {
      if (this.active !== active || parent.isDestroyed() || !current()) throw new Error('Go back to the PDF in its original workspace.');
    };
    let bytes: Buffer | undefined;
    try {
      assertCurrent();
      bytes = await readPdf(source, url, AbortSignal.any([active.abort.signal, AbortSignal.timeout(15_000)]));
      assertCurrent();
      const viewer = new BrowserWindow({
        parent, modal: true, show: false, width: 860, height: 720, minWidth: 380, minHeight: 380,
        title: 'Protected PDF preview', autoHideMenuBar: true,
        webPreferences: { session: this.rendererSession(), preload: join(import.meta.dirname, 'pdf-preview-preload.cjs'),
          sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, navigateOnDragDrop: false, devTools: false },
      });
      active.window = viewer;
      viewer.removeMenu();
      const contents = viewer.webContents;
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (event) => event.preventDefault());
      contents.on('will-frame-navigate', (event) => event.preventDefault());
      contents.on('will-attach-webview', (event) => event.preventDefault());
      contents.on('before-input-event', (event, input) => {
        if ((input.control || input.meta) && ['s', 'p'].includes(input.key.toLowerCase())) event.preventDefault();
      });
      viewer.once('closed', () => { if (this.active === active) this.close(); });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          ipcMain.removeListener('protected-pdf:ready', ready);
          active.abort.signal.removeEventListener('abort', cancelled);
        };
        const cancelled = () => { cleanup(); reject(new Error('The protected PDF preview closed.')); };
        const ready = (event: IpcMainEvent) => {
          if (event.sender !== contents || event.senderFrame !== contents.mainFrame || event.senderFrame.url !== exactViewerUrl) return;
          cleanup();
          try {
            assertCurrent();
            contents.send('protected-pdf:document', new Uint8Array(bytes!));
            viewer.show();
            resolve();
          } catch (error) { reject(error); }
        };
        const timer = setTimeout(cancelled, 8_000);
        ipcMain.on('protected-pdf:ready', ready);
        active.abort.signal.addEventListener('abort', cancelled, { once: true });
        void viewer.loadFile(viewFile).catch(cancelled);
      });
    } catch (error) {
      if (this.active === active) this.close();
      throw error;
    } finally { bytes?.fill(0); }
  }
}
