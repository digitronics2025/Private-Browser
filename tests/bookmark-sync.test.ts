import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BookmarkSyncManager } from '../electron/bookmark-sync';
import { bookmarkReplica, canSyncBookmark, type BookmarkReplica, type ReplicaBookmark } from '../electron/bookmark-replica';
import { readBookmarkPairing, writeBookmarkPairing } from '../electron/bookmark-pairing-file';
import { GoogleDriveBookmarkTransport, type BookmarkReplicaTransport } from '../electron/google-backup-transport';
import type { GoogleTokenBroker } from '../electron/google-token-broker';
import type { AccountSpaceId } from '../electron/types';

const scope = (id: string) => ({ id: id as AccountSpaceId, workspaceId: 'personal' as const, subject: 'fixture-owner' });
const first = scope('00000000-0000-4000-8000-000000000001');
const second = scope('00000000-0000-4000-8000-000000000002');
const fileId = 'drive-fixture-library';
const bookmark = (id: string, title = id): ReplicaBookmark => ({ id, title, url: `https://bookmarks.example.test/${id}`,
  createdAt: '2026-11-20T12:00:00Z', folderPath: ['Research'], location: 'bar', order: 0, orderPath: [0, 0] });
const data = (...bookmarks: ReplicaBookmark[]) => bookmarkReplica('personal', bookmarks, [{ path: ['Research'], location: 'bar', orderPath: [0] }]);

it('pairs two isolated devices, resumes setup after lost acknowledgement and reviews conflict with deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'private-browser-bookmark-sync-fixture-'));
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value).reverse(),
    decryptString: (value: Buffer) => Buffer.from(value).reverse().toString(),
  };
  let bytes: Buffer | undefined;
  let revision = 1;
  let reservations = 0;
  let creations = 0;
  const transport: BookmarkReplicaTransport = {
    reserve: async () => { reservations++; return fileId; },
    read: async (_account, id) => id === fileId && bytes ? { bytes: Buffer.from(bytes), fileId, etag: `"${revision}"` } : undefined,
    create: async (_account, id, data) => {
      expect(id).toBe(fileId);
      bytes = Buffer.from(data);
      creations++;
      throw new Error('Acknowledgement lost');
    },
    save: async (_account, id, etag, data) => {
      expect(id).toBe(fileId);
      if (etag !== `"${revision}"`) throw new Error('stale fixture');
      bytes = Buffer.from(data);
      revision++;
    },
  };
  const signal = new AbortController().signal;
  const primary = new BookmarkSyncManager(join(root, 'primary'), storage, transport);
  const other = new BookmarkSyncManager(join(root, 'other'), storage, transport);
  let one: BookmarkReplica = data(bookmark('one'));
  let two: BookmarkReplica = data(bookmark('two'));
  try {
    await expect(primary.start(first, one, signal)).rejects.toThrow('Acknowledgement lost');
    expect(primary.status(first)).toEqual({ enabled: false, initializing: true, lastSyncedAt: undefined });
    await primary.start(first, one, signal);
    expect(reservations).toBe(1);
    expect(creations).toBe(1);
    expect(bytes!.toString()).not.toContain('bookmarks.example.test');
    const pair = primary.exportPair(first);
    const path = join(root, 'pairing.pbpair');
    const passphrase = 'Long separate bookmark fixture passphrase';
    await writeBookmarkPairing(path, pair, passphrase, () => undefined);
    expect(readFileSync(path, 'utf8')).not.toContain(fileId);
    await expect(readBookmarkPairing(path, 'Wrong pairing fixture passphrase')).rejects.toThrow(/could not be verified/);
    await other.importPair(second, await readBookmarkPairing(path, passphrase), signal);
    let review = await other.prepare(second, two, 0, signal);
    expect(review.conflicts).toEqual([]);
    await other.apply(second, review.id, undefined, () => two, (value) => { two = value; }, signal);
    expect(two.bookmarks.map(({ id }) => id)).toEqual(['one', 'two']);
    expect(other.status(second).lastSyncedAt).toBeTruthy();
    one = data();
    review = await primary.prepare(first, one, 0, signal);
    expect(review.removedHere).toBe(1);
    await primary.apply(first, review.id, undefined, () => one, (value) => { one = value; }, signal);
    expect(one.bookmarks.map(({ id }) => id)).toEqual(['two']);
    two = data(bookmark('one', 'Edited while offline'), bookmark('two'));
    review = await other.prepare(second, two, 1, signal);
    expect(review).toMatchObject({ removedInPair: 1, deviceOnlyBookmarks: 1, conflicts: [{ local: 'Edited while offline · Research', remote: undefined }] });
    await other.apply(second, review.id, 'remote', () => two, (value) => { two = value; }, signal);
    expect(two.bookmarks.map(({ id }) => id)).toEqual(['two']);
    review = await other.prepare(second, two, 0, signal);
    revision++;
    await expect(other.apply(second, review.id, undefined, () => two, () => { throw new Error('Unexpected write'); }, signal)).rejects.toThrow(/changed after review/);
    expect(canSyncBookmark('https://example.com/?access_token=fixture')).toBe(false);
    expect(canSyncBookmark('https://example.com/#access_token=fixture')).toBe(false);
    expect(canSyncBookmark('https://example.com/?q=fixture')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('addresses the exact Drive app-data file and conditions its write on the reviewed revision', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url.pathname.endsWith('/generateIds')) return Response.json({ ids: [fileId] });
    if (url.searchParams.get('alt') === 'media') return new Response('ciphertext', { headers: { etag: '"fixture-version"' } });
    return new Response(null, { status: 200 });
  };
  const tokens = { getAccessToken: async () => 'drive-fixture-authorization' } as unknown as GoogleTokenBroker;
  const transport = new GoogleDriveBookmarkTransport(tokens, request);
  expect(await transport.reserve(first.id)).toBe(fileId);
  expect(calls[0].url.searchParams.get('space')).toBe('appDataFolder');
  await transport.create(first.id, fileId, Buffer.from('ciphertext'));
  expect(calls[1].init?.method).toBe('POST');
  expect(String(calls[1].init?.body)).toContain(`"id":"${fileId}"`);
  const remote = await transport.read(first.id, fileId);
  expect(remote?.etag).toBe('"fixture-version"');
  expect(calls[2].url.pathname).toBe('/drive/v3/files/' + fileId);
  await transport.save(first.id, fileId, remote!.etag, Buffer.from('next ciphertext'));
  expect(calls[3].url.pathname).toBe('/upload/drive/v3/files/' + fileId);
  expect(calls[3].init?.method).toBe('PATCH');
  expect(new Headers(calls[3].init?.headers).get('if-match')).toBe('"fixture-version"');
});
