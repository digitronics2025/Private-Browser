import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { validateBookmarkFolders } from './bookmark-tree.js';
import { isAllowedRemoteUrl } from './security.js';
import type { AccountSpaceBookmark, BookmarkFolder, WorkspaceId } from './types.js';

export type ReplicaBookmark = Omit<AccountSpaceBookmark, 'workspaceId' | 'accountSpaceId'>;
export interface BookmarkReplica {
  workspaceId: WorkspaceId;
  bookmarks: ReplicaBookmark[];
  folders: BookmarkFolder[];
}

type Entry = { key: string; kind: 'bookmark'; bookmark: ReplicaBookmark } | { key: string; kind: 'folder'; folder: BookmarkFolder };
export interface BookmarkConflict {
  id: string;
  kind: Entry['kind'];
  local?: string;
  remote?: string;
}

const format = 'private-browser-bookmark-replica-v1';
const maxBytes = 3_500_000;
const maxBookmarks = 25_000;

export function canSyncBookmark(value: string): boolean {
  if (typeof value !== 'string' || value.length > 4096 || !isAllowedRemoteUrl(value)) return false;
  const url = new URL(value);
  const fragment = new URLSearchParams(url.hash.slice(1).split('?').at(-1));
  const names = [...url.searchParams.keys(), ...fragment.keys()];
  return !url.username && !url.password && !names.some((name) => /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|code|password|secret|signature|sig|api[_-]?key|x-amz-.*)$/i.test(name));
}

function orderNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= 20 && value.every((part) => Number.isSafeInteger(part) && part >= 0);
}

function cleanBookmark(value: ReplicaBookmark): ReplicaBookmark {
  if (!value || typeof value.id !== 'string' || !value.id || value.id.length > 200 || typeof value.title !== 'string' || value.title.length > 500
    || !canSyncBookmark(value.url) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || (value.location !== 'bar' && value.location !== 'other') || !Number.isSafeInteger(value.order) || value.order < 0
    || !Array.isArray(value.folderPath) || value.folderPath.length > 20 || value.folderPath.some((part) => typeof part !== 'string' || !part || part.length > 200)
    || !orderNumbers(value.orderPath)) throw new Error('A bookmark in this library is invalid for sync.');
  return { id: value.id, title: value.title, url: value.url, createdAt: value.createdAt, location: value.location,
    folderPath: [...value.folderPath], order: value.order, orderPath: [...value.orderPath] };
}

export function bookmarkReplica(workspaceId: WorkspaceId, bookmarks: ReplicaBookmark[], folders: BookmarkFolder[]): BookmarkReplica {
  if (bookmarks.length > maxBookmarks) throw new Error('This bookmark library exceeds the sync limit.');
  const clean = bookmarks.map(cleanBookmark).sort((left, right) => left.id < right.id ? -1 : Number(left.id !== right.id));
  if (new Set(clean.map(({ id }) => id)).size !== clean.length) throw new Error('This bookmark library contains duplicate identifiers.');
  const checkedFolders = validateBookmarkFolders(folders);
  if (checkedFolders.length !== folders.length) throw new Error('A bookmark folder in this library is invalid for sync.');
  checkedFolders.sort((left, right) => {
    const a = JSON.stringify([left.location, left.path]);
    const b = JSON.stringify([right.location, right.path]);
    return a < b ? -1 : Number(a !== b);
  });
  return { workspaceId, bookmarks: clean, folders: checkedFolders };
}

export function replicaDigest(replica: BookmarkReplica): string {
  return createHash('sha256').update(JSON.stringify(replica)).digest('hex');
}

function entries(replica?: BookmarkReplica): Map<string, Entry> {
  const result = new Map<string, Entry>();
  for (const bookmark of replica?.bookmarks ?? []) {
    const key = 'bookmark:' + bookmark.id;
    result.set(key, { key, kind: 'bookmark', bookmark });
  }
  for (const folder of replica?.folders ?? []) {
    const key = 'folder:' + JSON.stringify([folder.location, folder.path]);
    result.set(key, { key, kind: 'folder', folder });
  }
  return result;
}

const equal = (left?: Entry, right?: Entry): boolean => JSON.stringify(left) === JSON.stringify(right);
const describe = (entry?: Entry): string | undefined => entry?.kind === 'bookmark'
  ? `${entry.bookmark.title} · ${entry.bookmark.folderPath.join(' / ') || (entry.bookmark.location === 'bar' ? 'Bookmarks bar' : 'Other bookmarks')}`
  : entry?.folder.path.join(' / ');

/** Shared keys are stable across devices. An absent entry is a deletion only after an agreed baseline. */
export function planBookmarkMerge(base: BookmarkReplica | undefined, local: BookmarkReplica, remote: BookmarkReplica) {
  if ((base && base.workspaceId !== local.workspaceId) || remote.workspaceId !== local.workspaceId) throw new Error('Pair a device using the same workspace.');
  const prior = entries(base);
  const ours = entries(local);
  const theirs = entries(remote);
  const conflicts = new Map<string, { item: BookmarkConflict; local?: Entry; remote?: Entry }>();
  const merged: Entry[] = [];
  for (const key of new Set([...prior.keys(), ...ours.keys(), ...theirs.keys()])) {
    const localEntry = ours.get(key);
    const remoteEntry = theirs.get(key);
    const old = prior.get(key);
    if (equal(localEntry, remoteEntry) || equal(remoteEntry, old)) {
      if (localEntry) merged.push(localEntry);
    } else if (equal(localEntry, old)) {
      if (remoteEntry) merged.push(remoteEntry);
    } else {
      const id = createHash('sha256').update(key).digest('hex').slice(0, 32);
      conflicts.set(id, { item: { id, kind: (localEntry ?? remoteEntry)!.kind, local: describe(localEntry), remote: describe(remoteEntry) }, local: localEntry, remote: remoteEntry });
    }
  }
  return { merged, conflicts };
}

export function resolveBookmarkMerge(workspaceId: WorkspaceId, plan: ReturnType<typeof planBookmarkMerge>, choice?: 'local' | 'remote'): BookmarkReplica {
  if (plan.conflicts.size && !choice) throw new Error('Choose how to resolve the reported bookmark differences.');
  const result = [...plan.merged];
  for (const conflict of plan.conflicts.values()) {
    const selected = choice === 'local' ? conflict.local : conflict.remote;
    if (selected) result.push(selected);
  }
  return bookmarkReplica(workspaceId, result.flatMap((entry) => entry.kind === 'bookmark' ? [entry.bookmark] : []),
    result.flatMap((entry) => entry.kind === 'folder' ? [entry.folder] : []));
}

export function encryptBookmarkReplica(replica: BookmarkReplica, key: Buffer): Buffer {
  const clear = Buffer.from(JSON.stringify(replica));
  try {
    if (clear.byteLength > maxBytes) throw new Error('This bookmark library exceeds the encrypted sync size limit.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(format));
    const body = Buffer.concat([cipher.update(clear), cipher.final()]);
    return Buffer.from(JSON.stringify({ format, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') }));
  } finally { clear.fill(0); }
}

export function decryptBookmarkReplica(bytes: Uint8Array, key: Buffer, workspaceId: WorkspaceId): BookmarkReplica {
  if (bytes.byteLength > Math.ceil(maxBytes / 3) * 4 + 512) throw new Error('The encrypted bookmark library is too large.');
  try {
    const data = JSON.parse(Buffer.from(bytes).toString('utf8')) as { format: string; iv: string; tag: string; body: string };
    if (data.format !== format) throw new Error('Invalid sync format');
    const iv = Buffer.from(data.iv, 'base64');
    const tag = Buffer.from(data.tag, 'base64');
    if (iv.byteLength !== 12 || tag.byteLength !== 16) throw new Error('Invalid sync format');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(format));
    decipher.setAuthTag(tag);
    const pending = decipher.update(Buffer.from(data.body, 'base64'));
    try {
      const clear = Buffer.concat([pending, decipher.final()]);
      try {
        const replica = JSON.parse(clear.toString('utf8')) as BookmarkReplica;
        if (replica.workspaceId !== workspaceId || !Array.isArray(replica.bookmarks) || !Array.isArray(replica.folders)) throw new Error('Invalid sync scope');
        return bookmarkReplica(workspaceId, replica.bookmarks, replica.folders);
      } finally { clear.fill(0); }
    } finally { pending.fill(0); }
  } catch { throw new Error('The paired bookmark library could not be authenticated in this workspace.'); }
}
