import { randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import type { AgentAuditRow } from './agent-types.js';

const visibleLimit = 200;
const segmentLimit = 10 * 1024 * 1024;
const segments = 5;
const tailLimit = 256 * 1024;

export function agentStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}

export function readAgentFile<T>(path: string, limit = 1024 * 1024): T | undefined {
  let contents: Buffer;
  try { contents = readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!agentStorageAvailable() || contents.byteLength > limit) throw new Error('Agent data is unavailable.');
  return JSON.parse(safeStorage.decryptString(contents)) as T;
}

export function writeAgentFile(path: string, value: unknown): void {
  if (!agentStorageAvailable()) throw new Error('Agent Mode needs operating-system encryption.');
  writeAgentBytes(path, safeStorage.encryptString(JSON.stringify(value)));
}

export function writeAgentBytes(path: string, contents: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 });
  try { renameSync(temp, path); } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

function remove(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

function readTail(path: string): AgentAuditRow[] {
  let file: number;
  try { file = openSync(path, 'r'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const size = fstatSync(file).size;
    if (size > segmentLimit) throw new Error('Agent audit segment is unavailable.');
    const tail = Buffer.alloc(Math.min(size, tailLimit));
    readSync(file, tail, { position: size - tail.length });
    const lines = tail.toString('ascii').split('\n');
    if (size > tail.length) lines.shift();
    return lines.filter(Boolean).slice(-visibleLimit)
      .map((line) => JSON.parse(safeStorage.decryptString(Buffer.from(line, 'base64'))) as AgentAuditRow);
  } finally { closeSync(file); }
}

export class AgentAudit {
  private rows: AgentAuditRow[];
  private readonly sizes = new Map<string, number>();
  private readonly known: Set<string>;

  constructor(private readonly oldFile: string, ids: string[]) {
    this.known = new Set(['general', 'lent', ...ids]);
    const legacy = readAgentFile<AgentAuditRow[]>(oldFile) ?? [];
    if (!Array.isArray(legacy) || legacy.length > visibleLimit) throw new Error('Agent audit is unavailable.');
    const retained = [...this.known].flatMap((id) => [...readTail(this.path(id, 1)), ...readTail(this.path(id, 0))]);
    this.rows = [...legacy, ...retained].sort((a, b) => b.at.localeCompare(a.at)).slice(0, visibleLimit);
  }

  addSpace(id: string): void { this.known.add(id); }

  add(row: AgentAuditRow): void {
    const space = row.spaceId ?? 'general';
    if (!this.known.has(space)) throw new Error('Unrecognized audit space.');
    const path = this.path(space, 0);
    const encoded = safeStorage.encryptString(JSON.stringify(row)).toString('base64') + '\n';
    let size = this.sizes.get(space);
    if (size === undefined) {
      size = existsSync(path) ? this.size(path) : 0;
      this.sizes.set(space, size);
    }
    if (size + encoded.length > segmentLimit) {
      remove(this.path(space, segments - 1));
      for (let index = segments - 2; index >= 0; index -= 1) {
        const previous = this.path(space, index);
        if (existsSync(previous)) renameSync(previous, this.path(space, index + 1));
      }
      size = 0;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    appendFileSync(path, encoded, { encoding: 'ascii', mode: 0o600, flush: true });
    this.sizes.set(space, size + encoded.length);
    this.rows = [row, ...this.rows].slice(0, visibleLimit);
  }

  list(): AgentAuditRow[] { return [...this.rows]; }

  clear(): void {
    remove(this.oldFile);
    for (const space of this.known) for (let index = 0; index < segments; index += 1) remove(this.path(space, index));
    this.sizes.clear();
    this.rows = [];
  }

  private size(path: string): number {
    const file = openSync(path, 'r');
    try { return fstatSync(file).size; } finally { closeSync(file); }
  }

  private path(space: string, index: number): string {
    return join(dirname(this.oldFile), 'audit', space, 'actions.' + index + '.enc');
  }
}
