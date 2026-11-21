import { request } from 'node:http';
import type { LocalAiModels } from './types.js';

type Path = '/api/status' | '/api/tags' | '/api/show' | '/api/chat';
type Transport = (path: Path, value?: unknown, cancellation?: AbortSignal) => Promise<unknown>;
const MAX_BYTES = 512 * 1024;

function ollamaRequest(path: Path, value?: unknown, cancellation?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = value === undefined ? undefined : JSON.stringify(value);
    const timeout = AbortSignal.timeout(path === '/api/chat' ? 120_000 : 4_000);
    const connection = request({
      hostname: '127.0.0.1', port: 11434, path, method: body === undefined ? 'GET' : 'POST',
      agent: false, signal: cancellation ? AbortSignal.any([cancellation, timeout]) : timeout,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error(`Ollama returned HTTP ${response.statusCode ?? 0}`));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) response.destroy(new Error('Ollama response exceeded its size limit'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Ollama returned an unreadable response')); }
      });
    });
    connection.on('error', reject);
    connection.end(body);
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function remote(model: Record<string, unknown>): boolean {
  return Boolean(model.remote_host || model.remote_model);
}

export class OllamaLocal {
  constructor(private readonly transport: Transport = ollamaRequest) {}

  async models(cancellation?: AbortSignal): Promise<LocalAiModels> {
    try {
      const localOnly = record(record(await this.transport('/api/status', undefined, cancellation))?.cloud)?.disabled;
      if (typeof localOnly !== 'boolean') return { state: 'unavailable', models: [] };
      if (!localOnly) return { state: 'cloud-enabled', models: [] };
      const response = record(await this.transport('/api/tags', undefined, cancellation));
      if (!Array.isArray(response?.models)) return { state: 'unavailable', models: [] };
      const names = new Set<string>();
      for (const entry of response.models) {
        const item = record(entry);
        const name = item?.name;
        if (!item || typeof name !== 'string' || !/^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?$/i.test(name)
          || name.length > 200 || /(?:-cloud|:cloud)(?:$|[.:_-])/i.test(name) || remote(item)
          || !Number.isSafeInteger(item.size) || Number(item.size) <= 0
          || typeof item.digest !== 'string' || !/^[0-9a-f]{64}$/i.test(item.digest)) continue;
        if (Array.isArray(item.capabilities) && !item.capabilities.includes('completion')) continue;
        names.add(name);
        if (names.size >= 100) break;
      }
      return { state: 'ready', models: [...names].sort() };
    } catch {
      cancellation?.throwIfAborted();
      return { state: 'unavailable', models: [] };
    }
  }

  async requireInstalledModel(model: string, cancellation?: AbortSignal): Promise<void> {
    const readiness = await this.models(cancellation);
    if (readiness.state === 'cloud-enabled') throw new Error('Turn off Ollama cloud features and check again.');
    if (readiness.state !== 'ready') throw new Error('Start a version of Ollama that reports local-only status on this device.');
    if (!readiness.models.includes(model)) throw new Error('Choose an installed local chat model.');
    const details = record(await this.transport('/api/show', { model }, cancellation));
    if (!details || remote(details) || !record(details.model_info)
      || (Array.isArray(details.capabilities) && !details.capabilities.includes('completion'))) {
      throw new Error('Ollama did not confirm an installed local chat model.');
    }
  }

  async ask(model: string, system: string, prompt: string, beforeSend: () => void, cancellation?: AbortSignal): Promise<string> {
    await this.requireInstalledModel(model, cancellation);
    cancellation?.throwIfAborted();
    beforeSend();
    cancellation?.throwIfAborted();
    const result = record(await this.transport('/api/chat', {
      model, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }, cancellation));
    const answer = record(result?.message)?.content;
    if (!result || remote(result) || typeof answer !== 'string' || !answer.trim()) throw new Error('Ollama did not return a local answer.');
    return answer.trim().slice(0, 30_000);
  }
}
