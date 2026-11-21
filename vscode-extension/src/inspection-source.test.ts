import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { resolveInspectionSource } from './inspection-source.js';

it('only confirms existing source files inside the granted project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'project-inspection-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'src', 'directory.html'));
  await writeFile(join(root, 'src', 'index.html'), '<p>Approved source</p>');
  expect(await resolveInspectionSource(root, '/src/index.html')).toMatchObject({ relativePath: 'src/index.html' });
  for (const path of ['/src/directory.html', '/src/missing.html', '/../outside.html', '/src/%2e%2e/other.ts',
    '/src/.env', '/src/index.html:stream', '/node_modules/file.js', '/@fs/abs/file.ts', '/src/index.html?query=ignored']) {
    expect(await resolveInspectionSource(root, path)).toBeUndefined();
  }
});
