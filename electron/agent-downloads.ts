import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { downloadRisk } from './security.js';

const transferCap = 100 * 1024 * 1024;
const ownedName = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}-[a-z0-9._-]+$/iu;
export interface AgentDownload { name: string; bytes: number }

export class AgentDownloads {
  private readonly active = new Map<string, Map<string, number>>();

  constructor(private readonly root: string) {}

  start(space: { id: string; downloadQuotaMb: number }, item: Electron.DownloadItem, signal: AbortSignal): boolean {
    const name = basename(item.getFilename()).slice(0, 120);
    if (!name || downloadRisk(name) !== 'ordinary' || signal.aborted) return false;
    const quota = space.downloadQuotaMb * 1024 * 1024;
    const expected = item.getTotalBytes();
    const reserved = expected > 0 ? expected : Math.min(transferCap, quota);
    if (reserved > transferCap || reserved > quota) return false;
    let path: string;
    try {
      const directory = this.directory(space.id);
      path = join(directory, randomUUID() + '-' + name.replace(/[^a-z0-9._-]/giu, '_'));
      const active = this.active.get(space.id) ?? new Map<string, number>();
      const inProgress = [...active.values()].reduce((sum, bytes) => sum + bytes, 0);
      if (inProgress + reserved > quota) return false;
      const finished = this.completed(directory, active);
      let used = inProgress + finished.reduce((sum, file) => sum + file.bytes, 0);
      for (const file of finished.sort((left, right) => left.updated - right.updated)) {
        if (used + reserved <= quota) break;
        unlinkSync(file.path);
        used -= file.bytes;
      }
      item.setSavePath(path);
      active.set(path, reserved);
      this.active.set(space.id, active);
    } catch { return false; }

    const abort = () => item.cancel();
    signal.addEventListener('abort', abort, { once: true });
    item.on('updated', () => { if (item.getReceivedBytes() > reserved) item.cancel(); });
    item.once('done', (_event, state) => {
      signal.removeEventListener('abort', abort);
      const active = this.active.get(space.id);
      active?.delete(path);
      if (active?.size === 0) this.active.delete(space.id);
      if (state !== 'completed' || item.getReceivedBytes() > reserved) this.removePartial(path);
    });
    return true;
  }

  list(spaceId: string): AgentDownload[] {
    try {
      return this.completed(this.directory(spaceId), this.active.get(spaceId))
        .sort((left, right) => right.updated - left.updated)
        .slice(0, 100)
        .map(({ name, bytes }) => ({ name, bytes }));
    } catch { return []; }
  }

  private directory(id: string): string {
    const directory = resolve(this.root, id);
    if (relative(this.root, directory) !== id) throw new Error('Invalid download space');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (relative(directory, realpathSync(directory)) !== '' || !lstatSync(directory).isDirectory()) throw new Error('Invalid download space');
    return directory;
  }

  private completed(directory: string, active?: ReadonlyMap<string, number>) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith('.crdownload') && ownedName.test(entry.name.slice(0, -11))) {
        if (!active?.has(path.slice(0, -11))) this.removePartial(path);
        return [];
      }
      if (!entry.isFile() || !ownedName.test(entry.name) || active?.has(path)) return [];
      const stat = lstatSync(path);
      return stat.isFile() ? [{ path, name: entry.name.slice(37), bytes: stat.size, updated: stat.mtimeMs }] : [];
    });
  }

  private removePartial(path: string): void {
    for (const target of [path, path + '.crdownload']) {
      try { unlinkSync(target); } catch { /* Chromium may have removed it. */ }
    }
  }
}
