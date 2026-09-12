import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Bookmark, ChromeImportResult, ChromeProfileSource, HistoryEntry, VaultItemInput, WorkspaceId } from './types.js';
import { isAllowedRemoteUrl } from './security.js';

const MAX_BOOKMARK_FILE_BYTES = 32 * 1024 * 1024;
const MAX_IMPORTED_BOOKMARKS = 25_000;
const MAX_IMPORTED_HISTORY = 10_000;
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

interface ChromeNode {
  type?: string;
  name?: string;
  url?: string;
  date_added?: string;
  children?: ChromeNode[];
}

interface ChromeBookmarksFile {
  roots?: Record<string, ChromeNode>;
}

interface ProfileRecord extends ChromeProfileSource {
  directory: string;
}

export interface ChromeProfileData {
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  result: ChromeImportResult;
}

function chromeUserDataDirectory(platform = process.platform): string {
  if (platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome');
  return join(homedir(), '.config', 'google-chrome');
}

function profileNameMap(userDataDirectory: string): Map<string, string> {
  try {
    const raw = JSON.parse(readFileSync(join(userDataDirectory, 'Local State'), 'utf8')) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    return new Map(Object.entries(raw.profile?.info_cache ?? {}).map(([id, value]) => [id, value.name || id]));
  } catch {
    return new Map();
  }
}

function detectProfileRecords(userDataDirectory = chromeUserDataDirectory()): ProfileRecord[] {
  if (!existsSync(userDataDirectory)) return [];
  const names = profileNameMap(userDataDirectory);
  return readdirSync(userDataDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/.test(entry.name)))
    .map((entry) => {
      const directory = join(userDataDirectory, entry.name);
      return {
        id: entry.name,
        name: names.get(entry.name) ?? (entry.name === 'Default' ? 'Default' : entry.name),
        isDefault: entry.name === 'Default',
        hasBookmarks: existsSync(join(directory, 'Bookmarks')),
        hasHistory: existsSync(join(directory, 'History')),
        directory,
      };
    })
    .filter((profile) => profile.hasBookmarks || profile.hasHistory)
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name));
}

export function listChromeProfiles(userDataDirectory?: string): ChromeProfileSource[] {
  return detectProfileRecords(userDataDirectory).map(({ directory: _directory, ...profile }) => profile);
}

function chromeTime(value?: string | number): string {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return new Date().toISOString();
  const date = new Date(micros / 1000 - CHROME_EPOCH_OFFSET_MS);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

export function parseChromeBookmarks(content: string, workspaceId: WorkspaceId): { bookmarks: Bookmark[]; skipped: number; truncated: boolean } {
  const parsed = JSON.parse(content) as ChromeBookmarksFile;
  const bookmarks: Bookmark[] = [];
  let skipped = 0;
  let truncated = false;

  const visit = (node: ChromeNode, location: Bookmark['location'], folderPath: string[], orderPath: number[]): void => {
    if (bookmarks.length >= MAX_IMPORTED_BOOKMARKS) { truncated = true; return; }
    if (node.type === 'url') {
      if (!node.url || !isAllowedRemoteUrl(node.url)) { skipped += 1; return; }
      bookmarks.push({
        id: randomUUID(),
        title: (node.name || node.url).slice(0, 500),
        url: node.url,
        workspaceId,
        createdAt: chromeTime(node.date_added),
        location,
        folderPath,
        order: orderPath.at(-1) ?? 0,
        orderPath,
      });
      return;
    }
    if (node.type !== 'folder' && !Array.isArray(node.children)) return;
    const nextPath = node.name ? [...folderPath, node.name.slice(0, 200)] : folderPath;
    for (const [childOrder, child] of (node.children ?? []).entries()) visit(child, location, nextPath, [...orderPath, childOrder]);
  };

  const roots = parsed.roots ?? {};
  for (const [rootName, root] of Object.entries(roots)) {
    const location: Bookmark['location'] = rootName === 'bookmark_bar' ? 'bar' : 'other';
    const prefix = rootName === 'bookmark_bar' || rootName === 'other' ? [] : [root.name || 'Mobile bookmarks'];
    for (const [order, child] of (root.children ?? []).entries()) visit(child, location, prefix, [order]);
  }
  return { bookmarks, skipped, truncated };
}

function readBookmarks(directory: string, workspaceId: WorkspaceId) {
  const filePath = join(directory, 'Bookmarks');
  if (!existsSync(filePath)) return { bookmarks: [] as Bookmark[], skipped: 0, truncated: false };
  if (statSync(filePath).size > MAX_BOOKMARK_FILE_BYTES) throw new Error('Chrome bookmarks file is unusually large');
  return parseChromeBookmarks(readFileSync(filePath, 'utf8'), workspaceId);
}

function readHistory(directory: string, workspaceId: WorkspaceId): { history: HistoryEntry[]; skipped: number } {
  const source = join(directory, 'History');
  if (!existsSync(source)) return { history: [], skipped: 0 };
  const scratch = join(tmpdir(), `private-browser-chrome-${randomUUID()}`);
  mkdirSync(scratch, { mode: 0o700 });
  const copy = join(scratch, 'History');
  try {
    copyFileSync(source, copy);
    if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${copy}-wal`);
    if (existsSync(`${source}-shm`)) copyFileSync(`${source}-shm`, `${copy}-shm`);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db.prepare('SELECT url, title, last_visit_time FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ?').all(MAX_IMPORTED_HISTORY) as Array<{ url: string; title: string; last_visit_time: number }>;
      let skipped = 0;
      const history = rows.flatMap((row) => {
        if (!isAllowedRemoteUrl(row.url)) { skipped += 1; return [] as HistoryEntry[]; }
        return [{ id: randomUUID(), title: String(row.title || row.url).slice(0, 500), url: row.url, workspaceId, visitedAt: chromeTime(row.last_visit_time) }];
      });
      return { history, skipped };
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function readChromeProfile(profileId: string, workspaceId: WorkspaceId, includeBookmarks: boolean, includeHistory: boolean, userDataDirectory?: string): ChromeProfileData {
  if (!['digitronics', 'tenten', 'development', 'personal'].includes(workspaceId)) throw new Error('Choose a non-banking workspace for imported Chrome data');
  const profile = detectProfileRecords(userDataDirectory).find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error('Chrome profile was not found');
  if (!includeBookmarks && !includeHistory) throw new Error('Choose at least one data type to import');
  const warnings: string[] = [];
  let bookmarkData = { bookmarks: [] as Bookmark[], skipped: 0, truncated: false };
  let historyData = { history: [] as HistoryEntry[], skipped: 0 };
  if (includeBookmarks) {
    try { bookmarkData = readBookmarks(profile.directory, workspaceId); }
    catch { warnings.push('Chrome bookmarks could not be read. Close Chrome and try again.'); }
  }
  if (includeHistory) {
    try { historyData = readHistory(profile.directory, workspaceId); }
    catch { warnings.push('Chrome history could not be read. Close Chrome and try again.'); }
  }
  if (bookmarkData.truncated) warnings.push(`Only the first ${MAX_IMPORTED_BOOKMARKS.toLocaleString()} bookmarks were accepted for safety.`);
  return {
    bookmarks: bookmarkData.bookmarks,
    history: historyData.history,
    result: {
      imported: { bookmarks: 0, history: 0, passwords: 0 },
      skipped: { bookmarks: bookmarkData.skipped, history: historyData.skipped, passwords: 0 },
      warnings,
    },
  };
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

export function parseChromePasswordCsv(content: string): { items: VaultItemInput[]; skipped: number } {
  const rows = parseCsvRows(content.replace(/^\uFEFF/, ''));
  const headers = rows.shift()?.map((value) => value.trim().toLowerCase()) ?? [];
  const indexOf = (names: string[]) => headers.findIndex((header) => names.includes(header));
  const nameIndex = indexOf(['name']);
  const urlIndex = indexOf(['url']);
  const usernameIndex = indexOf(['username']);
  const passwordIndex = indexOf(['password']);
  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) throw new Error('This is not a Chrome password CSV export');
  let skipped = 0;
  const items = rows.flatMap((row) => {
    const url = row[urlIndex]?.trim();
    const username = row[usernameIndex]?.trim();
    const password = row[passwordIndex] ?? '';
    if (!url || !username || !password || !isAllowedRemoteUrl(url) || url.length > 2000 || username.length > 500 || password.length > 5000) {
      skipped += 1;
      return [] as VaultItemInput[];
    }
    return [{ label: (row[nameIndex]?.trim() || new URL(url).hostname).slice(0, 200), url, username, password }];
  });
  return { items: items.slice(0, 5000), skipped: skipped + Math.max(0, items.length - 5000) };
}
