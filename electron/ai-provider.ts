import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import { redactSensitiveText, isSafeAiEndpoint } from './security.js';
import { OllamaLocal } from './ollama-local.js';
import { AI_SYSTEM_PROMPT, aiUserPrompt } from './ai-prompt.js';
import type { AssistantMetadata, AiProviderCheckResult, AiProviderCheckState, AiProviderInput, AiProviderStatus, LocalAiModels } from './types.js';

type StoredProvider = AiProviderInput & { version: 1 };
export const CLOUD_AI_TIMEOUT_MS = 60_000;
const CONNECTION_TIMEOUT_MS = 20_000;
const maxCloudResponse = 256 * 1024;

class AiResponseError extends Error {
  constructor(readonly state: AiProviderCheckState, message: string, readonly reason?: string) { super(reason ? message + ' ' + reason : message); }
}

async function failedCloudResponse(response: Response, key: string): Promise<AiResponseError> {
  let reason = '';
  try {
    const data = JSON.parse(await readBody(response, 4096));
    if (typeof data?.error?.message === 'string') {
      const message = key ? data.error.message.split(key).join('[REDACTED]') : data.error.message;
      reason = redactSensitiveText(message.replace(/\bsk-[\w-]+/gi, '[REDACTED]')).text
        .replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim().slice(0, 300);
    }
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw error;
  }
  const status = response.status;
  if (status === 402 || /credit balance|billing|insufficient.quota/i.test(reason)) return new AiResponseError('insufficient-credit', 'Check provider credit or billing.', reason);
  if (status === 401 || status === 403) return new AiResponseError('authentication', 'The provider refused access.', reason);
  if (status === 404) return new AiResponseError('model-not-found', 'Check the model ID and endpoint.', reason);
  if (/context.{0,24}(length|long|limit|window)|too many tokens/i.test(reason)) return new AiResponseError('context-too-long', 'Reduce the approved context.', reason);
  if (status === 400 || status === 422) return new AiResponseError('bad-request', 'The provider rejected the request.', reason);
  if (status === 429) return new AiResponseError('rate-limit', 'The provider is limiting requests.', reason);
  return new AiResponseError('unavailable', 'The provider is unavailable.', reason);
}

async function readBody(response: Response, limit: number): Promise<string> {
  const stream = response.body;
  if (!stream || Number(response.headers.get('content-length') ?? 0) > limit) {
    await stream?.cancel().catch(() => undefined);
    throw new AiResponseError('invalid-response', 'The AI provider returned an empty or oversized response.');
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw new AiResponseError('invalid-response', 'The AI provider response exceeded its size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function readCloudAnswer(response: Response): Promise<{ text: string } & AssistantMetadata> {
  const body = await readBody(response, maxCloudResponse);
  let parsed: { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
  try { parsed = JSON.parse(body); }
  catch { throw new AiResponseError('invalid-response', 'The AI provider returned an unreadable response.'); }
  const answer = parsed?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new AiResponseError('invalid-response', 'The AI provider returned an empty response.');
  const usage = parsed.usage;
  const valid = (count: number) => Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000_000;
  return { text: answer.trim().slice(0, 30_000),
    ...(parsed.choices?.[0]?.finish_reason === 'length' || answer.trim().length > 30_000 ? { truncated: true } : {}),
    ...(usage && valid(usage.prompt_tokens) && valid(usage.completion_tokens)
      ? { usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } } : {}) };
}

export class AiProviderStore {
  private config?: StoredProvider;
  private corrupt = false;
  private configurationRequest = 0;
  private readonly local = new OllamaLocal();

  constructor(private readonly filePath: string) {
    this.config = this.load();
  }

  status(): AiProviderStatus {
    if (this.corrupt) return { configured: false, error: 'provider-corrupt' };
    if (!safeStorage.isEncryptionAvailable()) return { configured: false, error: 'os-encryption-unavailable' };
    if (!this.config) return { configured: false };
    return 'mode' in this.config
      ? { configured: true, mode: 'local', model: this.config.model }
      : { configured: true, mode: 'cloud', endpoint: this.config.endpoint, model: this.config.model };
  }

  localModels(): Promise<LocalAiModels> { return this.local.models(); }

  async configure(input: AiProviderInput, beforeSave: () => void): Promise<AiProviderStatus> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
    if (this.corrupt) throw new Error('The AI provider file is corrupt; clear it before configuring again');
    const model = input.model.trim();
    if (!model || model.length > 200 || /[\s\p{Cc}]/u.test(model)) throw new Error('Enter a provider model ID without spaces.');
    const request = ++this.configurationRequest;
    let next: StoredProvider;
    if ('mode' in input) {
      await this.local.requireInstalledModel(model);
      next = { version: 1, mode: 'local', model };
    } else {
      const endpoint = input.endpoint.trim().replace(/\/$/, '');
      if (!isSafeAiEndpoint(endpoint)) throw new Error('Use a public HTTPS AI endpoint without embedded credentials');
      if (input.apiKey.length > 1000) throw new Error('Invalid provider configuration');
      next = { version: 1, endpoint, model, apiKey: input.apiKey.trim() };
    }
    if (request !== this.configurationRequest) throw new Error('The AI provider setting changed; check the current setting.');
    beforeSave();
    this.save(next);
    this.config = next;
    return this.status();
  }

  clear(): AiProviderStatus {
    this.configurationRequest += 1;
    if (existsSync(this.filePath)) unlinkSync(this.filePath);
    this.config = undefined;
    this.corrupt = false;
    return this.status();
  }

  async checkConnection(checkWorkspace: () => void): Promise<AiProviderCheckResult> {
    const provider = this.config;
    if (!provider || !this.status().configured) return { state: 'not-configured' };
    try {
      await this.ask({ title: 'Private Browser test sample', url: 'Built-in sample', text: 'The fictional shop has two test pages.' },
        'How many test pages are in the sample?', checkWorkspace, undefined, CONNECTION_TIMEOUT_MS);
      return { state: 'ready' };
    } catch (error) {
      return error instanceof AiResponseError ? { state: error.state, ...(error.reason && { reason: error.reason }) } : { state: 'mode' in provider ? 'local-setup' : 'unavailable' };
    }
  }

  async ask(context: { title: string; url: string; text: string; dom?: string; screenshotDataUrl?: string }, question: string, checkSource: () => void, cancellation?: AbortSignal, timeoutMs = CLOUD_AI_TIMEOUT_MS): Promise<{ text: string } & AssistantMetadata> {
    const provider = this.config;
    if (!provider) throw new Error('Configure an AI provider first');
    const prompt = aiUserPrompt(context, question);
    if ('mode' in provider) {
      if (context.screenshotDataUrl) throw new Error('The local assistant uses text previews');
      return { text: await this.local.ask(provider.model, AI_SYSTEM_PROMPT, prompt, () => {
        if (this.config !== provider) throw new Error('The AI provider changed; approve the context again');
        checkSource();
      }, cancellation) };
    }
    const content = context.screenshotDataUrl
      ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: context.screenshotDataUrl } }]
      : prompt;
    checkSource();
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
      redirect: 'error',
      signal: cancellation ? AbortSignal.any([cancellation, timeout]) : timeout,
    });
    if (!response.ok) {
      throw await failedCloudResponse(response, provider.apiKey);
    }
    return readCloudAnswer(response);
  }

  private load(): StoredProvider | undefined {
    try {
      if (!safeStorage.isEncryptionAvailable() || !existsSync(this.filePath)) return undefined;
      const encrypted = Buffer.from(readFileSync(this.filePath, 'utf8'), 'base64');
      const parsed = JSON.parse(safeStorage.decryptString(encrypted)) as StoredProvider;
      if (parsed.version !== 1 || typeof parsed.model !== 'string' || !parsed.model || parsed.model.length > 200) throw new Error('Invalid provider');
      if ('mode' in parsed ? parsed.mode !== 'local' : !isSafeAiEndpoint(parsed.endpoint) || typeof parsed.apiKey !== 'string') throw new Error('Invalid provider');
      return parsed;
    } catch {
      this.corrupt = true;
      return undefined;
    }
  }

  private save(config: StoredProvider): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(config));
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, encrypted.toString('base64'), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
