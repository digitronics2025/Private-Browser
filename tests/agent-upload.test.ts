import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageAgentUpload, verifyUploadFolder } from '../electron/agent-upload';

let root: string;
let folder: string;
let data: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'private-browser-upload-'));
  folder = join(root, 'fixtures');
  data = join(root, 'account-store', 'agent-mode');
  await mkdir(folder);
  await mkdir(data, { recursive: true });
  await writeFile(join(folder, 'fixture.txt'), 'ordinary fixture');
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('Agent upload paths', () => {
  it('copies an ordinary granted file to tab-owned staging', async () => {
    const granted = await verifyUploadFolder(folder, data);
    const staged = await stageAgentUpload(granted, 'fixture.txt', data);
    expect(staged.path).toContain(join(data, 'uploads'));
    expect(await readFile(staged.path, 'utf8')).toBe('ordinary fixture');
    await staged.clean();
    await expect(readFile(staged.path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal, streams, secret names, profile grants, and links leaving the folder', async () => {
    const granted = await verifyUploadFolder(folder, data);
    const outside = join(root, 'other');
    await mkdir(outside);
    await writeFile(join(outside, 'fixture.txt'), 'other fixture');
    await symlink(outside, join(folder, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of ['../other/fixture.txt', 'fixture.txt:stream', '.env.example', 'linked/fixture.txt', join(outside, 'fixture.txt')]) {
      await expect(stageAgentUpload(granted, path, data)).rejects.toThrow();
    }
    await expect(verifyUploadFolder(root, data)).rejects.toThrow();
    await expect(verifyUploadFolder(data, data)).rejects.toThrow();
  });
});
