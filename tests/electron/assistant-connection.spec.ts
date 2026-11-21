import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

type Fixture = { mode: 'ok' | 'quota' | 'oversize'; bodies: string[] };

test('checks the saved provider with only a built-in sample and bounds its response', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'private-browser-ai-check-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.PRIVATE_BROWSER_E2E_USER_DATA = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('dist-electron/main.js')], env });
  try {
    await app.evaluate(() => {
      const root = globalThis as typeof globalThis & { __pbAiConnection?: Fixture };
      const fixture: Fixture = { mode: 'ok', bodies: [] };
      root.__pbAiConnection = fixture;
      const fetchOriginal = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input) !== 'https://ai-fixture.example.com/v1/chat/completions') return fetchOriginal(input, init);
        fixture.bodies.push(String(init?.body ?? ''));
        if (fixture.mode === 'quota') return new Response('provider details', { status: 429 });
        if (fixture.mode === 'oversize') return new Response('x'.repeat(256 * 1024 + 1));
        return Response.json({ choices: [{ message: { content: 'Two.' } }] });
      };
    });
    const page = await app.firstWindow();
    const configure = (model: string) => page.evaluate((value) => window.privateBrowser.configureAiProvider({
      endpoint: 'https://ai-fixture.example.com/v1', model: value, apiKey: '',
    }), model);
    await expect(configure('wrong model name')).rejects.toThrow(/model ID without spaces/i);
    await expect(configure('fixture/model:latest')).resolves.toMatchObject({ mode: 'cloud', configured: true });
    const check = () => page.evaluate(() => window.privateBrowser.checkAiProvider());
    await expect(check()).resolves.toEqual({ state: 'ready' });
    const bodies = await app.evaluate(() => (globalThis as typeof globalThis & { __pbAiConnection?: Fixture }).__pbAiConnection!.bodies);
    expect(bodies).toHaveLength(1);
    const messages = JSON.parse(bodies[0]).messages as Array<{ role: string; content: string }>;
    expect(messages[1].content).toBe('Page: Private Browser test sample\nURL: Built-in sample\n\nApproved context:\nThe fictional shop has two test pages.\n\nQuestion: How many test pages are in the sample?');
    for (const [mode, state] of [['quota', 'rate-limit'], ['oversize', 'invalid-response']] as const) {
      await app.evaluate((_electron, value) => { (globalThis as typeof globalThis & { __pbAiConnection?: Fixture }).__pbAiConnection!.mode = value; }, mode);
      await expect(check()).resolves.toEqual({ state });
    }
    await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
    await expect(check()).rejects.toThrow(/unavailable in this Account Space/i);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  }
});
