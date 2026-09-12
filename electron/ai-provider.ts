import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import { isSafeAiEndpoint } from './security.js';
import type { AiProviderInput, AiProviderStatus } from './types.js';

interface StoredProvider extends AiProviderInput {
  version: 1;
}

export class AiProviderStore {
  private config?: StoredProvider;
  private corrupt = false;

  constructor(private readonly filePath: string) {
    this.config = this.load();
  }

  status(): AiProviderStatus {
    if (this.corrupt) return { configured: false, error: 'provider-corrupt' };
    if (!safeStorage.isEncryptionAvailable()) return { configured: false, error: 'os-encryption-unavailable' };
    return this.config
      ? { configured: true, endpoint: this.config.endpoint, model: this.config.model }
      : { configured: false };
  }

  configure(input: AiProviderInput): AiProviderStatus {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
    if (this.corrupt) throw new Error('The AI provider file is corrupt; clear it before configuring again');
    const endpoint = input.endpoint.trim().replace(/\/$/, '');
    const model = input.model.trim();
    if (!isSafeAiEndpoint(endpoint)) throw new Error('Use a public HTTPS AI endpoint without embedded credentials');
    if (!model || model.length > 200 || input.apiKey.length > 1000) throw new Error('Invalid provider configuration');
    this.config = { version: 1, endpoint, model, apiKey: input.apiKey.trim() };
    this.save();
    return this.status();
  }

  clear(): AiProviderStatus {
    this.config = undefined;
    this.corrupt = false;
    if (existsSync(this.filePath)) unlinkSync(this.filePath);
    return this.status();
  }

  async ask(context: { title: string; url: string; text: string; dom?: string; screenshotDataUrl?: string }, question: string): Promise<string> {
    if (!this.config) throw new Error('Configure a cloud AI provider first');
    const prompt = `Page: ${context.title}\nURL: ${context.url}\n\nApproved context:\n${context.text}${context.dom ? `\n\nApproved structural DOM (no text or values):\n${context.dom}` : ''}\n\nQuestion: ${question}`;
    const content = context.screenshotDataUrl
      ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: context.screenshotDataUrl } }]
      : prompt;
    const response = await fetch(`${this.config.endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.config.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'Answer only from the user-approved webpage context. Clearly say when the context is insufficient. Never request or expose credentials.' },
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
      if (parsed.version !== 1 || !isSafeAiEndpoint(parsed.endpoint) || !parsed.model) throw new Error('Invalid provider');
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
