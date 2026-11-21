import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DownloadHistoryStore, type RetainedDownload } from '../electron/download-history';
import type { AccountSpaceId } from '../electron/types';

const owner = 'f654bcf2-386a-45f5-9b98-5495ec516bc1' as AccountSpaceId;
const other = '5b66006b-af95-47e6-9255-c06c65be917d' as AccountSpaceId;
const storage = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};
let root: string;

afterEach(() => { if (root) rmSync(root, { force: true, recursive: true }); });

function setup() {
  root = mkdtempSync(join(tmpdir(), 'private-browser-download-history-'));
  const value: RetainedDownload = {
    entry: { id: 'fixture', accountSpaceId: owner, filename: 'report.pdf', state: 'completed', origin: 'https://reports.example.test/?private=fixture',
      finishedAt: '2026-11-21T17:00:00.000Z', risk: 'ordinary', totalBytes: 10, receivedBytes: 10 },
    file: { path: join(root, 'report.pdf'), stamp: '1:2:10:100:100' },
  };
  return { value, history: new DownloadHistoryStore(root, storage), persisted: join(root, owner + '.enc') };
}

describe('download history', () => {
  it('only retains opted-in records and strips origin query fields', () => {
    const { history, value } = setup();
    expect(history.status(owner)).toBe('off');
    expect(history.record(owner, value)).toBe(false);
    history.setEnabled(owner, true);
    history.setEnabled(other, true);
    expect(() => history.record(other, value)).toThrow();
    expect(history.record(owner, value)).toBe(true);
    const reopened = new DownloadHistoryStore(root, storage);
    expect(reopened.entries(other)).toEqual([]);
    expect(reopened.entries(owner)[0]).toMatchObject({ entry: { origin: 'https://reports.example.test', retained: true }, file: value.file });
    reopened.setEnabled(owner, false);
    expect(reopened.record(owner, value)).toBe(false);
    expect(reopened.entries(owner)).toHaveLength(1);
    reopened.remove(owner, value.entry.id);
    expect(new DownloadHistoryStore(root, storage).entries(owner)).toEqual([]);
  });

  it('preserves an unreadable history and refuses to store without OS protection', () => {
    const { history, persisted } = setup();
    history.setEnabled(owner, true);
    writeFileSync(persisted, 'unreadable fixture', 'utf8');
    const reopened = new DownloadHistoryStore(root, storage);
    expect(reopened.status(owner)).toBe('unavailable');
    expect(() => reopened.setEnabled(owner, true)).toThrow();
    expect(readFileSync(persisted, 'utf8')).toBe('unreadable fixture');
    const noProtection = new DownloadHistoryStore(root, { ...storage, isEncryptionAvailable: () => false });
    expect(noProtection.status(other)).toBe('unavailable');
  });
});
