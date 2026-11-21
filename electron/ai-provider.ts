import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import { isSafeAiEndpoint } from './security.js';
import { OllamaLocal } from './ollama-local.js';
import { AI_SYSTEM_PROMPT, aiUserPrompt } from './ai-prompt.js';
import type { AiProviderCheckResult, AiProviderCheckState, AiProviderInput, AiProviderStatus, LocalAiModels } from './types.js';

type StoredProvider = AiProviderInput & { version: 1 };
const maxCloudResponse = 256 * 1024;

class AiResponseError extends Error {
  constructor(readonly state: AiProviderCheckState, message: string) { super(message); }
}

function failedCloudResponse(status: number): AiResponseError {
  if (status === 401 || status === 403) return new AiResponseError('authentication', 'The AI provider refused access. Check authentication and model access.');
  if (status === 400 || status === 404 || status === 422) return new AiResponseError('model', 'The AI provider rejected the request. Check the model ID and endpoint.');
  if (status === 429) return new AiResponseError('rate-limit', 'The AI provider is limiting requests. Try again later.');
  return new AiResponseError('unavailable', 'The AI provider is unavailable. Try again later.');
}

async function readCloudAnswer(response: Response): Promise<string> {
  const stream = response.body;
  if (!stream || Number(response.headers.get('content-length') ?? 0) > maxCloudResponse) {
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
      if (length > maxCloudResponse) {
        await reader.cancel().catch(() => undefined);
        throw new AiResponseError('invalid-response', 'The AI provider response exceeded its size limit.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let parsed: { choices?: Array<{ message?: { content?: unknown } }> };
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AiResponseError('invalid-response', 'The AI provider returned an unreadable response.'); }
  const answer = parsed?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new AiResponseError('invalid-response', 'The AI provider returned an empty response.');
  return answer.trim().slice(0, 30_000);
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
        'How many test pages are in the sample?', checkWorkspace);
      return { state: 'ready' };
    } catch (error) {
      return { state: error instanceof AiResponseError ? error.state : 'mode' in provider ? 'local-setup' : 'unavailable' };
    }
  }

  async ask(context: { title: string; url: string; text: string; dom?: string; screenshotDataUrl?: string }, question: string, checkSource: () => void, cancellation?: AbortSignal): Promise<string> {
    const provider = this.config;
    if (!provider) throw new Error('Configure an AI provider first');
    const prompt = aiUserPrompt(context, question);
    if ('mode' in provider) {
      if (context.screenshotDataUrl) throw new Error('The local assistant uses text previews');
      return this.local.ask(provider.model, AI_SYSTEM_PROMPT, prompt, () => {
        if (this.config !== provider) throw new Error('The AI provider changed; approve the context again');
        checkSource();
      }, cancellation);
    }
    const content = context.screenshotDataUrl
      ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: context.screenshotDataUrl } }]
      : prompt;
    checkSource();
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(`${provider.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      }),
      redirect: 'error',
      signal: cancellation ? AbortSignal.any([cancellation, timeout]) : timeout,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw failedCloudResponse(response.status);
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
