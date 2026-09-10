import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { UpdateServiceInput } from './types.js';

const MAX_BOOTSTRAP_BYTES = 4_096;

export function readUpdateBootstrap(filePath: string): UpdateServiceInput | undefined {
  if (!existsSync(filePath)) return undefined;
  const raw = readFileSync(filePath);
  if (raw.byteLength > MAX_BOOTSTRAP_BYTES) throw new Error('The bundled update configuration is too large');

  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('The bundled update configuration is invalid');
  }
  if (!value || typeof value !== 'object') throw new Error('The bundled update configuration is invalid');
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || typeof input.endpoint !== 'string' || typeof input.accessToken !== 'string') {
    throw new Error('The bundled update configuration is invalid');
  }
  return { endpoint: input.endpoint, accessToken: input.accessToken };
}

export function removeUpdateBootstrap(filePath: string): boolean {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}
