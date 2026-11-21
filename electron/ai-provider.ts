import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import { isSafeAiEndpoint } from './security.js';
import { OllamaLocal } from './ollama-local.js';
import type { AiProviderInput, AiProviderStatus, LocalAiModels } from './types.js';

type StoredProvider = AiProviderInput & { version: 1 };
const systemPrompt = 'Answer only from the user-approved webpage context. Clearly say when the context is insufficient. Never request or expose credentials.';

export class AiProviderStore {
  private config?: StoredProvider;
  private corrupt = false;
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

  async configure(input: AiProviderInput): Promise<AiProviderStatus> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
    if (this.corrupt) throw new Error('The AI provider file is corrupt; clear it before configuring again');
    const model = input.model.trim();
    if (!model || model.length > 200) throw new Error('Invalid provider model');
    if ('mode' in input) {
      await this.local.requireInstalledModel(model);
      this.config = { version: 1, mode: 'local', model };
    } else {
      const endpoint = input.endpoint.trim().replace(/\/$/, '');
      if (!isSafeAiEndpoint(endpoint)) throw new Error('Use a public HTTPS AI endpoint without embedded credentials');
      if (input.apiKey.length > 1000) throw new Error('Invalid provider configuration');
      this.config = { version: 1, endpoint, model, apiKey: input.apiKey.trim() };
    }
    this.save();
    return this.status();
  }

  clear(): AiProviderStatus {
    this.config = undefined;
    this.corrupt = false;
    if (existsSync(this.filePath)) unlinkSync(this.filePath);
    return this.status();
  }

  async ask(context: { title: string; url: string; text: string; dom?: string; screenshotDataUrl?: string }, question: string, checkSource: () => void): Promise<string> {
    const provider = this.config;
    if (!provider) throw new Error('Configure an AI provider first');
    const prompt = `Page: ${context.title}\nURL: ${context.url}\n\nApproved context:\n${context.text}${context.dom ? `\n\nApproved structural DOM (no text or values):\n${context.dom}` : ''}\n\nQuestion: ${question}`;
    if ('mode' in provider) {
      if (context.screenshotDataUrl) throw new Error('The local assistant uses text previews');
      return this.local.ask(provider.model, systemPrompt, prompt, () => {
        if (this.config !== provider) throw new Error('The AI provider changed; approve the context again');
        checkSource();
      });
    }
    const content = context.screenshotDataUrl
      ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: context.screenshotDataUrl } }]
      : prompt;
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
          { role: 'system', content: systemPrompt },
          { role: 'user', content },
        ],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`AI provider returned ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 256 * 1024) throw new Error('AI provider response exceeded its size limit');
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > 256 * 1024) throw new Error('AI provider response exceeded its size limit');
    const data = JSON.parse(body) as { choices?: Array<{ message?: { content?: string } }> };
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) throw new Error('AI provider returned an empty response');
    return answer.slice(0, 30_000);
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

  private save(): void {
    if (!this.config) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const encrypted = safeStorage.encryptString(JSON.stringify(this.config));
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, encrypted.toString('base64'), { mode: 0o600 });
    renameSync(temporaryPath, this.filePath);
  }
}
