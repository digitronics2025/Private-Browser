import { describe, expect, it, vi } from 'vitest';
import { OllamaLocal } from '../electron/ollama-local';

const name = 'local-fixture:latest';
const digest = 'a'.repeat(64);

function mockRuntime(cloudDisabled: boolean, details: unknown = { model_info: {}, capabilities: ['completion'] }) {
  const transport = vi.fn(async (path: string, _body?: unknown) => {
    if (path === '/api/status') return { cloud: { disabled: cloudDisabled } };
    if (path === '/api/tags') return { models: [
      { name, size: 100, digest },
      { name: 'tagged-cloud:latest', size: 100, digest },
      { name: 'proxy:latest', size: 100, digest, remote_model: 'remote' },
      { name: 'external:latest', size: 100, digest, remote_host: 'https://example.test/' },
      { name: 'embedding:latest', size: 100, digest, capabilities: ['embedding'] },
    ] };
    if (path === '/api/show') return details;
    return { message: { content: 'Fixture response' } };
  });
  return { transport, runtime: new OllamaLocal(transport) };
}

describe('local Ollama', () => {
  it('lists installed local chat models and sends only the approved text', async () => {
    const { transport, runtime } = mockRuntime(true);
    await expect(runtime.models()).resolves.toEqual({ state: 'ready', models: [name] });
    const checkSource = vi.fn();
    const cancellation = new AbortController();
    await expect(runtime.ask(name, 'system', 'Approved fixture', checkSource, cancellation.signal)).resolves.toBe('Fixture response');
    expect(checkSource).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenLastCalledWith('/api/chat', {
      model: name, stream: false, messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'Approved fixture' }],
    }, cancellation.signal);
  });

  it('sends no prompt if Ollama can use the cloud, the selected model is remote, or consent is stale', async () => {
    const enabled = mockRuntime(false);
    await expect(enabled.runtime.ask(name, 'system', 'Private fixture', vi.fn())).rejects.toThrow(/Turn off Ollama cloud/);
    expect(enabled.transport).toHaveBeenCalledTimes(1);
    const remote = mockRuntime(true, { model_info: {}, remote_host: 'https://example.test/' });
    await expect(remote.runtime.ask(name, 'system', 'Private fixture', vi.fn())).rejects.toThrow(/did not confirm/);
    expect(remote.transport.mock.calls.some(([path]) => path === '/api/chat')).toBe(false);
    const stale = mockRuntime(true);
    await expect(stale.runtime.ask(name, 'system', 'Private fixture', () => { throw new Error('Page changed'); })).rejects.toThrow('Page changed');
    expect(stale.transport.mock.calls.some(([path]) => path === '/api/chat')).toBe(false);

    const cancelled = mockRuntime(true);
    const cancellation = new AbortController();
    await expect(cancelled.runtime.ask(name, 'system', 'Private fixture', () => cancellation.abort(), cancellation.signal)).rejects.toThrow(/abort/i);
    expect(cancelled.transport.mock.calls.some(([path]) => path === '/api/chat')).toBe(false);
  });

  it('reports an unavailable local runtime without attempting another provider', async () => {
    const transport = vi.fn(async () => { throw new Error('Connection failed'); });
    const runtime = new OllamaLocal(transport);
    await expect(runtime.models()).resolves.toEqual({ state: 'unavailable', models: [] });
    expect(transport).toHaveBeenCalledExactlyOnceWith('/api/status', undefined, undefined);

    const olderRuntime = new OllamaLocal(async () => ({}));
    await expect(olderRuntime.models()).resolves.toEqual({ state: 'unavailable', models: [] });
  });
});
