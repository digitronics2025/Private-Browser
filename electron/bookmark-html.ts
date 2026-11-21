import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { SAXParser } from 'parse5-sax-parser';
import { isAllowedRemoteUrl } from './security.js';
import type { AccountSpaceId, Bookmark, WorkspaceId } from './types.js';

const maxFileBytes = 16 * 1024 * 1024;
const maxBookmarks = 25_000;
const maxFolderDepth = 20;
type Destination = { workspaceId: WorkspaceId; accountSpaceId: AccountSpaceId };
type Level = { location: Bookmark['location']; folderPath: string[]; orderPath: number[]; next: number };

export async function readBookmarkHtml(filePath: string, destination: Destination) {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxFileBytes) throw new Error('Choose a bookmark HTML file smaller than 16 MB.');
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== stat.size) throw new Error('The bookmark file changed while it was open. Choose it again.');
    return await parseBookmarkHtml(buffer.toString('utf8', 0, size), destination);
  } finally {
    await file.close();
  }
}

export async function parseBookmarkHtml(html: string, destination: Destination): Promise<{ bookmarks: Bookmark[]; skipped: number }> {
  if (Buffer.byteLength(html) > maxFileBytes) throw new Error('Choose a bookmark HTML file smaller than 16 MB.');
  const parser = new SAXParser();
  const bookmarks: Bookmark[] = [];
  const levels: Level[] = [];
  let depth = 0;
  let ignoredDepth = 0;
  let sawRoot = false;
  let recognized = false;
  let inItem = false;
  let skipped = 0;
  let caption: { kind: 'folder' | 'bookmark'; text: string; toolbar?: boolean; url?: string; date?: string } | undefined;
  let folder: { name: string; toolbar: boolean } | undefined;
  const now = new Date().toISOString();
  const inert = new Set(['script', 'style', 'template', 'noscript']);

  const finishCaption = () => {
    const item = caption;
    caption = undefined;
    const level = levels.at(-1);
    if (!item || !level) return;
    if (item.kind === 'folder') {
      folder = { name: item.text.trim().slice(0, 200) || 'Untitled folder', toolbar: Boolean(item.toolbar) };
      return;
    }
    if (depth > maxFolderDepth + 1 || bookmarks.length >= maxBookmarks || !item.url
      || item.url.length > 4_096 || !isAllowedRemoteUrl(item.url)) {
      skipped += 1;
      return;
    }
    const url = new URL(item.url).toString();
    const orderPath = [...level.orderPath, level.next++];
    const epoch = item.date && /^\d{1,12}$/.test(item.date) ? Number(item.date) : 0;
    bookmarks.push({
      accountSpaceId: destination.accountSpaceId, workspaceId: destination.workspaceId, id: randomUUID(), url,
      title: (item.text.trim() || url).slice(0, 500),
      createdAt: epoch > 0 && epoch < 253_402_300_800 ? new Date(epoch * 1000).toISOString() : now,
      location: level.location, folderPath: [...level.folderPath], order: orderPath[0], orderPath,
    });
  };

  parser.on('doctype', ({ name }) => { recognized = name?.toLowerCase() === 'netscape-bookmark-file-1'; });
  parser.on('startTag', ({ tagName, attrs }) => {
    if (inert.has(tagName)) { ignoredDepth += 1; return; }
    if (ignoredDepth || !recognized) return;
    if (tagName === 'dl') {
      finishCaption();
      const parent = levels.at(-1);
      depth += 1;
      if (depth === 1) sawRoot = true;
      if (depth <= maxFolderDepth + 1) {
        if (!parent) levels.push({ location: 'other', folderPath: [], orderPath: [], next: 0 });
        else if (folder?.toolbar && depth === 2) levels.push({ location: 'bar', folderPath: [], orderPath: [], next: 0 });
        else if (folder && depth === 2 && folder.name.toLowerCase() === 'other bookmarks') levels.push({ location: 'other', folderPath: [], orderPath: [], next: 0 });
        else levels.push({ location: parent.location, folderPath: [...parent.folderPath, folder?.name ?? 'Untitled folder'],
          orderPath: [...parent.orderPath, parent.next++], next: 0 });
      }
      folder = undefined;
      inItem = false;
    } else if (tagName === 'dt' && depth > 0) {
      finishCaption();
      folder = undefined;
      inItem = true;
    } else if (inItem && (tagName === 'a' || tagName === 'h3')) {
      finishCaption();
      const attribute = (name: string) => attrs.find((item) => item.name === name)?.value;
      caption = tagName === 'a' ? { kind: 'bookmark', text: '', url: attribute('href'), date: attribute('add_date') }
        : { kind: 'folder', text: '', toolbar: attribute('personal_toolbar_folder')?.toLowerCase() === 'true' };
      inItem = false;
    }
  });
  parser.on('text', ({ text }) => {
    if (!ignoredDepth && caption && caption.text.length < 500) caption.text += text.slice(0, 500 - caption.text.length);
  });
  parser.on('endTag', ({ tagName }) => {
    if (inert.has(tagName)) { if (ignoredDepth) ignoredDepth -= 1; return; }
    if (ignoredDepth) return;
    if ((tagName === 'a' && caption?.kind === 'bookmark') || (tagName === 'h3' && caption?.kind === 'folder')) finishCaption();
    if (tagName === 'dl' && depth > 0) {
      finishCaption();
      if (depth <= maxFolderDepth + 1) levels.pop();
      depth -= 1;
      folder = undefined;
      inItem = false;
    }
  });
  parser.resume();
  parser.end(html);
  await finished(parser);
  finishCaption();
  if (!recognized || !sawRoot) throw new Error('Choose a standard browser bookmark HTML export.');
  return { bookmarks, skipped };
}
