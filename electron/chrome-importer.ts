import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AccountSpaceId, Bookmark, ChromeImportResult, ChromePasswordIssue, ChromePasswordSkipReason, ChromeProfileSource, HistoryEntry, VaultItemInput, WorkspaceId } from './types.js';
import { isAllowedRemoteUrl } from './security.js';
import type { BrowserSettingsPatch } from './browser-settings.js';
import type { ChromeSettingChoice, ChromeSettingsSelection } from './types.js';
import { selectedChromeSettings } from './chrome-profile-preferences.js';

const MAX_BOOKMARK_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CHROME_PREFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_IMPORTED_BOOKMARKS = 25_000;
const MAX_BOOKMARK_DEPTH = 20;
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
  settingsPatch?: BrowserSettingsPatch;
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
        hasPreferences: existsSync(join(directory, 'Preferences')),
        directory,
      };
    })
    .filter((profile) => profile.hasBookmarks || profile.hasHistory || profile.hasPreferences)
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

export function parseChromeBookmarks(content: string, workspaceId: WorkspaceId, accountSpaceId: AccountSpaceId): { bookmarks: Bookmark[]; skipped: number; truncated: boolean } {
  const parsed = JSON.parse(content) as ChromeBookmarksFile;
  const bookmarks: Bookmark[] = [];
  let skipped = 0;
  let truncated = false;

  const visit = (node: ChromeNode, location: Bookmark['location'], folderPath: string[], orderPath: number[]): void => {
    if (bookmarks.length >= MAX_IMPORTED_BOOKMARKS) { truncated = true; return; }
    // Each leaf copies its whole path, so depth is bounded as well as count; the
    // saved state keeps at most this many levels anyway (F-81).
    if (orderPath.length > MAX_BOOKMARK_DEPTH) { skipped += 1; return; }
    if (node.type === 'url') {
      if (!node.url || !isAllowedRemoteUrl(node.url)) { skipped += 1; return; }
      bookmarks.push({
        id: randomUUID(),
        // A nameless Chrome bookmark stays nameless, so it keeps showing as an icon alone.
        title: (node.name ?? '').trim().slice(0, 500),
        url: node.url,
        workspaceId,
        accountSpaceId,
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

function readBookmarks(directory: string, workspaceId: WorkspaceId, accountSpaceId: AccountSpaceId) {
  const filePath = join(directory, 'Bookmarks');
  let descriptor: number;
  try {
    descriptor = openSync(filePath, 'r');
  } catch (error: unknown) {
    if (isMissingFile(error)) return { bookmarks: [] as Bookmark[], skipped: 0, truncated: false };
    throw error;
  }
  try {
    if (fstatSync(descriptor).size > MAX_BOOKMARK_FILE_BYTES) throw new Error('Chrome bookmarks file is unusually large');
    return parseChromeBookmarks(readFileSync(descriptor, 'utf8'), workspaceId, accountSpaceId);
  } finally {
    closeSync(descriptor);
  }
}

function readHistory(directory: string, workspaceId: WorkspaceId, accountSpaceId: AccountSpaceId): { history: HistoryEntry[]; skipped: number } {
  const source = join(directory, 'History');
  const scratch = join(tmpdir(), `private-browser-chrome-${randomUUID()}`);
  mkdirSync(scratch, { mode: 0o700 });
  const copy = join(scratch, 'History');
  try {
    try {
      copyFileSync(source, copy);
    } catch (error: unknown) {
      if (isMissingFile(error)) return { history: [], skipped: 0 };
      throw error;
    }
    copyIfPresent(`${source}-wal`, `${copy}-wal`);
    copyIfPresent(`${source}-shm`, `${copy}-shm`);
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      const rows = db.prepare('SELECT url, title, last_visit_time FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ?').all(MAX_IMPORTED_HISTORY) as Array<{ url: string; title: string; last_visit_time: number }>;
      let skipped = 0;
      const history = rows.flatMap((row) => {
        if (!isAllowedRemoteUrl(row.url)) { skipped += 1; return [] as HistoryEntry[]; }
        return [{ id: randomUUID(), title: String(row.title || row.url).slice(0, 500), url: row.url, workspaceId, accountSpaceId, visitedAt: chromeTime(row.last_visit_time) }];
      });
      return { history, skipped };
    } finally {
      db.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function copyIfPresent(source: string, destination: string): void {
  try {
    copyFileSync(source, destination);
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

const SETTING_LABELS: Record<ChromeSettingChoice, string> = { search: 'search engine', home: 'Home page', startup: 'startup settings' };

function readChromePreferences(directory: string): unknown {
  const descriptor = openSync(join(directory, 'Preferences'), 'r');
  try {
    if (fstatSync(descriptor).size > MAX_CHROME_PREFERENCE_BYTES) throw new Error('Chrome preferences file is unusually large');
    return JSON.parse(readFileSync(descriptor, 'utf8')) as unknown;
  } finally {
    closeSync(descriptor);
  }
}

export function readChromeProfile(profileId: string, workspaceId: WorkspaceId, accountSpaceId: AccountSpaceId, includeBookmarks: boolean, includeHistory: boolean,
  userDataDirectory?: string, choice: ChromeSettingsSelection = {}): ChromeProfileData {
  if (!['digitronics', 'tenten', 'development', 'personal'].includes(workspaceId)) throw new Error('Choose a non-banking workspace for imported Chrome data');
  const profile = detectProfileRecords(userDataDirectory).find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error('Chrome profile was not found');
  const includeSettings = Object.values(choice).some(Boolean);
  if (!includeBookmarks && !includeHistory && !includeSettings) throw new Error('Choose at least one data type or workspace setting');
  const warnings: string[] = [];
  let bookmarkData = { bookmarks: [] as Bookmark[], skipped: 0, truncated: false };
  let historyData = { history: [] as HistoryEntry[], skipped: 0 };
  if (includeBookmarks) {
    try { bookmarkData = readBookmarks(profile.directory, workspaceId, accountSpaceId); }
    catch { warnings.push('Chrome bookmarks could not be read. Close Chrome and try again.'); }
  }
  if (includeHistory) {
    try { historyData = readHistory(profile.directory, workspaceId, accountSpaceId); }
    catch { warnings.push('Chrome history could not be read. Close Chrome and try again.'); }
  }
  if (bookmarkData.truncated) warnings.push(`Only the first ${MAX_IMPORTED_BOOKMARKS.toLocaleString()} bookmarks were accepted for safety.`);
  let settings: ReturnType<typeof selectedChromeSettings> | undefined;
  if (includeSettings) {
    try {
      settings = selectedChromeSettings(readChromePreferences(profile.directory), choice);
      for (const key of settings.unavailable) warnings.push(`Chrome ${SETTING_LABELS[key]} could not be imported.`);
    } catch {
      warnings.push('Chrome workspace settings could not be read.');
    }
  }
  return {
    bookmarks: bookmarkData.bookmarks,
    history: historyData.history,
    settingsPatch: settings?.applied.length ? settings.patch : undefined,
    result: {
      imported: { bookmarks: 0, history: 0, passwords: 0 },
      skipped: { bookmarks: bookmarkData.skipped, history: historyData.skipped, passwords: 0 },
      warnings,
      appliedSettings: settings?.applied.length ? settings.applied : undefined,
    },
  };
}

function parseCsvRows(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRecord = () => {
    row.push(field.replace(/\r$/, ''));
    if (row.some(Boolean)) rows.push(row);
    if (rows.length > 100_000) throw new Error('This CSV has too many entries.');
    row = [];
    field = '';
  };
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quoted) {
      if (char === '"' && content[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      if (row.length >= 64) throw new Error('This CSV has too many columns.');
      field = '';
    } else if (char === '\n') endRecord();
    else field += char;
  }
  if (quoted) throw new Error('The CSV ends inside a quoted field.');
  if (field || row.length) endRecord();
  return rows;
}

export interface ChromePasswordRow extends VaultItemInput { note?: string }
export const MAX_PASSWORD_IMPORT_ISSUES = 100;

/**
 * The one parser for Chrome's password export, used by the live MyVault import.
 * Every field is bounded, a UTF-8 BOM is stripped, and rows that are not web
 * logins (`android://…` app entries, `chrome://`, unparsable URLs) are counted as
 * skipped rather than aborting the import. Passwords are never trimmed: that
 * would change the credential.
 */
export function describeChromePasswordCsv(content: string) {
  const rows = parseCsvRows(content.replace(/^\uFEFF/, ''));
  const headers = rows.shift()?.map((value) => value.trim().toLowerCase()) ?? [];
  const indexOf = (names: string[]) => headers.findIndex((header) => names.includes(header));
  const nameIndex = indexOf(['name']);
  const urlIndex = indexOf(['url']);
  const usernameIndex = indexOf(['username']);
  const passwordIndex = indexOf(['password']);
  const noteIndex = indexOf(['note']);
  if (urlIndex < 0 || usernameIndex < 0 || passwordIndex < 0) throw new Error('This is not a Chrome password CSV export');
  const items: Array<{ entry: number; login: ChromePasswordRow }> = [];
  const issues: ChromePasswordIssue[] = [];
  const skipped: Partial<Record<ChromePasswordSkipReason, number>> = {};
  let sourceCount = 0;
  for (const [index, row] of rows.entries()) {
    if (row.every((value) => !value)) continue;
    sourceCount += 1;
    const entry = index + 1;
    const url = row[urlIndex]?.trim();
    // A login with no username is legitimate (password-only sites).
    const username = row[usernameIndex]?.trim() ?? '';
    const password = row[passwordIndex] ?? '';
    const note = noteIndex >= 0 ? row[noteIndex] ?? '' : '';
    let reason: ChromePasswordSkipReason | undefined;
    if (!url || !isAllowedRemoteUrl(url)) reason = 'unsupported-site';
    else if (!password) reason = 'missing-password';
    else if (url.length > 2000 || username.length > 500 || password.length > 5000 || note.length > 10_000) reason = 'field-limit';
    else if (items.length >= 5000) reason = 'row-limit';
    if (reason || !url) {
      const key = reason ?? 'unsupported-site';
      skipped[key] = (skipped[key] ?? 0) + 1;
      if (issues.length < MAX_PASSWORD_IMPORT_ISSUES) issues.push({ entry, reason: key });
      continue;
    }
    items.push({ entry, login: { label: (row[nameIndex]?.trim() || new URL(url).hostname).slice(0, 200), url, username, password, ...(note ? { note } : {}) } });
  }
  return { items, sourceCount, skipped, issues };
}

export function parseChromePasswordCsv(content: string): { items: ChromePasswordRow[]; skipped: number } {
  const parsed = describeChromePasswordCsv(content);
  return { items: parsed.items.map(({ login }) => login), skipped: parsed.sourceCount - parsed.items.length };
}
