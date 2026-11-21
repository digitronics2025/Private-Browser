import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import type { AgentAuditRow } from './agent-types.js';

const AUDIT_LIMIT = 200;

export function agentStorageAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
    && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
}

export function readAgentFile<T>(path: string): T | undefined {
  let contents: Buffer;
  try { contents = readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!agentStorageAvailable() || contents.byteLength > 1024 * 1024) throw new Error('Agent data is unavailable.');
  return JSON.parse(safeStorage.decryptString(contents)) as T;
}

export function writeAgentFile(path: string, value: unknown): void {
  if (!agentStorageAvailable()) throw new Error('Agent Mode needs operating-system encryption.');
  writeAgentBytes(path, safeStorage.encryptString(JSON.stringify(value)));
}

export function writeAgentBytes(path: string, contents: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, contents, { flag: 'wx', mode: 0o600 });
  try { renameSync(temp, path); } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}

export class AgentAudit {
  private rows: AgentAuditRow[];

  constructor(private readonly path: string) {
    this.rows = readAgentFile<AgentAuditRow[]>(path) ?? [];
    if (!Array.isArray(this.rows) || this.rows.length > AUDIT_LIMIT) throw new Error('Agent audit is unavailable.');
  }

  add(row: AgentAuditRow): void {
    const next = [row, ...this.rows].slice(0, AUDIT_LIMIT);
    writeAgentFile(this.path, next);
    this.rows = next;
  }

  list(): AgentAuditRow[] { return [...this.rows]; }

  clear(): void {
    writeAgentFile(this.path, []);
    this.rows = [];
  }
}
