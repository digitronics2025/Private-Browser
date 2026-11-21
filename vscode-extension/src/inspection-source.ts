import { stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import { inspectionSourcePath } from '@private-browser/bridge-protocol';
import { resolveInsideWorkspace } from './security.js';

export async function resolveInspectionSource(root: string, pathname: string): Promise<{ file: string; relativePath: string } | undefined> {
  const path = inspectionSourcePath(pathname);
  if (!path) return undefined;
  try {
    const file = await resolveInsideWorkspace(root, path);
    const relativePath = relative(await resolveInsideWorkspace(root, '.'), file).split(sep).join('/');
    if (!inspectionSourcePath('/' + relativePath) || !(await stat(file)).isFile()) return undefined;
    return { file, relativePath };
  } catch {
    return undefined;
  }
}
