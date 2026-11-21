import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { requireAccountSpaceId } from '../electron/account-space-validation.js';
import { DownloadFolderStore, finishStagedDownload, safeDownloadFilename, stageDownload } from '../electron/download-folder.js';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'private-browser-download-folder-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('download folder', () => {
  it('normalizes a website filename without permitting path traversal, reserved names or hidden extensions', () => {
    expect(safeDownloadFilename('..\\..\\invoice.pdf')).toBe('.._.._invoice.pdf');
    expect(safeDownloadFilename('COM1.pdf')).toBe('_COM1.pdf');
    expect(safeDownloadFilename('statement.pdf:alternate')).toBe('statement.pdf_alternate');
    expect(safeDownloadFilename('invoice\u202e.pdf.  ')).toBe('invoice_.pdf');
    expect(safeDownloadFilename('x'.repeat(300) + '.pdf')).toMatch(/^x{156}\.pdf$/);
  });

  it('uses exclusive placement to preserve preexisting and concurrent filenames', async () => {
    const name = 'invoice.pdf';
    writeFileSync(join(root, name), 'existing');
    const staged = ['first', 'second'].map((text) => {
      const path = stageDownload(root, name);
      writeFileSync(path, text);
      return path;
    });
    const results = await Promise.all(staged.map((path) => finishStagedDownload(path, root, name)));
    expect(results.sort()).toEqual([join(root, 'invoice (1).pdf'), join(root, 'invoice (2).pdf')].sort());
    expect(results.map((path) => readFileSync(path, 'utf8')).sort()).toEqual(['first', 'second']);
    expect(readFileSync(join(root, name), 'utf8')).toBe('existing');
  });

  it('keeps folder settings independent and shows only the folder name', () => {
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    };
    const store = new DownloadFolderStore(join(root, 'settings'), storage);
    const account = requireAccountSpaceId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    const other = requireAccountSpaceId('ffffffff-aaaa-4bbb-8ccc-dddddddddddd');
    store.choose(account, root);
    expect(store.status(account)).toMatchObject({ ask: true, available: true });
    store.setAsk(account, false);
    const reopened = new DownloadFolderStore(join(root, 'settings'), storage);
    expect(reopened.status(account)).toEqual({ ask: false, available: true, name: expect.stringMatching(/^private-browser-download-folder-/) });
    expect(reopened.status(other)).toEqual({ ask: true, available: true, name: undefined });
    reopened.forgetAccount(account);
    expect(reopened.get(account)).toBeNull();
  });
});
