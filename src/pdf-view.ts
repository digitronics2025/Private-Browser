import { AnnotationMode, GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './pdf-view.css';

GlobalWorkerOptions.workerSrc = workerUrl;
const api = (window as unknown as { privatePdfPreview?: { load(receive: (bytes: Uint8Array) => void): void } }).privatePdfPreview;
const canvas = document.querySelector<HTMLCanvasElement>('#page')!;
const message = document.querySelector<HTMLElement>('#status')!;
const previous = document.querySelector<HTMLButtonElement>('#previous')!;
const next = document.querySelector<HTMLButtonElement>('#next')!;
const find = document.querySelector<HTMLButtonElement>('#find')!;
const query = document.querySelector<HTMLInputElement>('#query')!;
const maxPages = 250;
let pdf: PDFDocumentProxy;
let current = 1;
let busy = false;

function updateButtons(): void {
  previous.disabled = busy || !pdf || current <= 1;
  next.disabled = busy || !pdf || current >= pdf.numPages;
  query.disabled = busy || !pdf;
  find.disabled = query.disabled;
}

async function showPage(number: number): Promise<void> {
  const page = await pdf.getPage(number);
  try {
    const size = page.getViewport({ scale: 1 });
    const scale = Math.min(1.7, 2300 / Math.max(size.width, size.height));
    const viewport = page.getViewport({ scale });
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    await page.render({ canvas, viewport, annotationMode: AnnotationMode.DISABLE }).promise;
    current = number;
    canvas.setAttribute('aria-label', 'PDF page ' + current);
    message.textContent = 'Page ' + current + ' of ' + pdf.numPages;
  } finally { page.cleanup(); }
}

async function perform(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  updateButtons();
  try { await action(); }
  catch { message.textContent = 'This PDF could not be read in the protected preview.'; }
  finally { busy = false; updateButtons(); }
}

async function findText(): Promise<void> {
  const text = query.value.trim().toLocaleLowerCase();
  if (!text) { message.textContent = 'Enter text to find.'; return; }
  message.textContent = 'Searching pages…';
  const start = current;
  for (let offset = 0; offset < pdf.numPages; offset++) {
    const number = (start + offset - 1) % pdf.numPages + 1;
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    page.cleanup();
    if (content.items.map((item) => 'str' in item ? item.str : '').join(' ').toLocaleLowerCase().includes(text)) {
      await showPage(number);
      message.textContent = 'Match on page ' + number + ' of ' + pdf.numPages;
      return;
    }
  }
  message.textContent = 'No matching searchable text found.';
}

previous.addEventListener('click', () => { void perform(() => showPage(current - 1)); });
next.addEventListener('click', () => { void perform(() => showPage(current + 1)); });
find.addEventListener('click', () => { void perform(findText); });
document.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'f') { event.preventDefault(); query.focus(); }
  if (key === 's' || key === 'p') event.preventDefault();
});
query.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void perform(findText); } });

api?.load((bytes) => void perform(async () => {
  const documentTask = getDocument({
    data: new Uint8Array(bytes), enableXfa: false, useWorkerFetch: false,
    stopAtErrors: true, maxImageSize: 16_777_216, disableFontFace: true,
  });
  const timeout = window.setTimeout(() => { void documentTask.destroy(); }, 15_000);
  try {
    const candidate = await documentTask.promise;
    if (candidate.numPages < 1 || candidate.numPages > maxPages) throw new Error('PDF page limit exceeded');
    pdf = candidate;
    await showPage(1);
  } catch (error) {
    await documentTask.destroy();
    throw error;
  } finally { window.clearTimeout(timeout); }
}));
