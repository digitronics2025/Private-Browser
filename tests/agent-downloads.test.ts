import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AgentDownloads } from '../electron/agent-downloads';

let root: string;
const bytes = 1024 * 1024;
const work = { id: 'work-fixture', downloadQuotaMb: 1 };

class DownloadFixture extends EventEmitter {
  path = '';
  received = 0;
  cancelled = false;

  constructor(private readonly name: string, private readonly expected: number) { super(); }
  getFilename() { return this.name; }
  getTotalBytes() { return this.expected; }
  getReceivedBytes() { return this.received; }
  setSavePath(value: string) { this.path = value; }
  cancel() { this.cancelled = true; this.emit('done', undefined, 'cancelled'); }
  item() { return this as unknown as Electron.DownloadItem; }
}

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'agent-quota-fixture-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('cleans up completed files oldest first and isolates quota by space', async () => {
  const store = new AgentDownloads(root);
  const signal = new AbortController().signal;
  const one = new DownloadFixture('older.txt', bytes / 2);
  expect(store.start(work, one.item(), signal)).toBe(true);
  await writeFile(one.path, Buffer.alloc(bytes / 2));
  one.received = bytes / 2;
  one.emit('done', undefined, 'completed');
  const another = new DownloadFixture('retained.txt', bytes / 2);
  expect(store.start({ ...work, id: 'other-fixture' }, another.item(), signal)).toBe(true);
  await writeFile(another.path, Buffer.alloc(bytes / 2));
  another.received = bytes / 2;
  another.emit('done', undefined, 'completed');

  const two = new DownloadFixture('newer.txt', bytes);
  expect(store.start(work, two.item(), signal)).toBe(true);
  expect(store.list(work.id)).toEqual([]);
  expect(store.list('other-fixture').map(({ name }) => name)).toEqual(['retained.txt']);
  await writeFile(two.path, Buffer.alloc(bytes));
  two.received = bytes;
  two.emit('done', undefined, 'completed');
  expect(store.list(work.id)).toEqual([{ name: 'newer.txt', bytes }]);
});

it('reserves space across transfers and cancels unknown-length files at the cap', async () => {
  const store = new AgentDownloads(root);
  const signal = new AbortController().signal;
  const one = new DownloadFixture('stream.txt', 0);
  expect(store.start(work, one.item(), signal)).toBe(true);
  expect(store.start(work, new DownloadFixture('concurrent.txt', 10).item(), signal)).toBe(false);
  one.received = bytes + 1;
  one.emit('updated');
  expect(one.cancelled).toBe(true);
  expect(store.start(work, new DownloadFixture('too-large.txt', bytes + 1).item(), signal)).toBe(false);
  expect(store.start(work, new DownloadFixture('program.exe', 10).item(), signal)).toBe(false);
  expect(store.start(work, new DownloadFixture('ordinary.txt', 10).item(), signal)).toBe(true);
});

it('keeps unrelated files in the download directory', async () => {
  const store = new AgentDownloads(root);
  await mkdir(join(root, work.id));
  await writeFile(join(root, work.id, 'owner-kept.txt'), 'fixture');
  expect(store.list(work.id)).toEqual([]);
});
