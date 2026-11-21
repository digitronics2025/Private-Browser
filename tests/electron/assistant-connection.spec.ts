import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

type Fixture = { mode: 'ok' | 'quota' | 'oversize'; bodies: string[] };

test('checks the provider with a built-in sample and sends only the separately approved page request', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'private-browser-ai-check-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.PRIVATE_BROWSER_E2E_USER_DATA = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ args: [resolve('dist-electron/main.js')], env });
  const server = createServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Reading sample</title><p id="selection">A brass kettle sits on the shelf.</p><p>Other catalogue items.</p>');
  });
  try {
    await new Promise<void>((ready) => { server.listen(0, '127.0.0.1', ready); });
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
    await app.evaluate(() => { (globalThis as typeof globalThis & { __pbAiConnection?: Fixture }).__pbAiConnection!.mode = 'ok'; });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await page.evaluate((url) => window.privateBrowser.navigate(url), `${origin}/article?view=full`);
    await expect(page.getByRole('tab', { name: /Reading sample/ })).toBeVisible();
    await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find((child) => child.getVisible()) as Electron.WebContentsView;
      await view.webContents.executeJavaScript("const range = document.createRange(); range.selectNodeContents(document.querySelector('#selection')); getSelection().addRange(range);");
    });
    const preview = await page.evaluate(() => window.privateBrowser.prepareAiPreview('selection'));
    expect(preview.text).toBe('A brass kettle sits on the shelf.');
    const review = await page.evaluate((id) => window.privateBrowser.reviewAssistantRequest(id, 'A brass kettle', 'What is listed? token=fixture-only'), preview.id);
    expect(review.destination).toBe('https://ai-fixture.example.com/v1/chat/completions');
    expect(review.redactions).toBe(1);
    expect(review.userPrompt).toBe(`Page: Reading sample\nURL: ${origin}\n\nApproved context:\nA brass kettle\n\nQuestion: What is listed? [REDACTED]`);
    const readBodies = () => app.evaluate(() => (globalThis as typeof globalThis & { __pbAiConnection?: Fixture }).__pbAiConnection!.bodies);
    expect(await readBodies()).toHaveLength(3);
    const send = (id: string) => page.evaluate((value) => window.privateBrowser.sendReviewedAssistant(value), id);
    await expect(send(review.id)).resolves.toBe('Two.');
    await expect(send(review.id)).rejects.toThrow(/review the request/i);
    const sent = await readBodies();
    expect(sent).toHaveLength(4);
    expect(JSON.parse(sent[3]).messages).toEqual([
      { role: 'system', content: review.systemPrompt }, { role: 'user', content: review.userPrompt },
    ]);
    await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
    await expect(check()).rejects.toThrow(/unavailable in this Account Space/i);
  } finally {
    await app.close();
    await new Promise<void>((closed) => server.close(() => closed()));
    await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  }
});
