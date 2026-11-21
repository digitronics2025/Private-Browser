import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';

type Fixture = { mode: 'ok' | 'quota' | 'oversize' | 'evidence' | 'waiting' | 'timeout'; bodies: string[] };

test('checks the provider with a built-in sample and sends only the separately approved page request', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'private-browser-ai-check-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  env.PRIVATE_BROWSER_E2E_USER_DATA = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({ args: [resolve('dist-electron/main.js')], env });
  let app = await launch();
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
        if (fixture.mode === 'timeout') throw new DOMException('Fixture timed out', 'TimeoutError');
        if (fixture.mode === 'waiting') {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          });
        }
        if (fixture.mode === 'evidence') return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [
          { claim: 'The catalogue lists a brass kettle.', quote: 'A brass kettle sits on the shelf.' },
          { claim: 'It also lists other items.', quote: 'Other catalogue items.' },
        ] }) } }] });
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
    await expect(send(review.id)).resolves.toEqual({ kind: 'answer', text: 'Two.' });
    await expect(send(review.id)).rejects.toThrow(/review the request/i);
    const sent = await readBodies();
    expect(sent).toHaveLength(4);
    expect(JSON.parse(sent[3]).messages).toEqual([
      { role: 'system', content: review.systemPrompt }, { role: 'user', content: review.userPrompt },
    ]);
    await app.evaluate(() => { (globalThis as typeof globalThis & { __pbAiConnection?: Fixture }).__pbAiConnection!.mode = 'evidence'; });
    const evidencePreview = await page.evaluate(() => window.privateBrowser.prepareAiPreview('selection'));
    const evidence = await page.evaluate(({ id, text }) => window.privateBrowser.reviewAssistantRequest(id, text, 'What is listed?', true), evidencePreview);
    expect(evidence.userPrompt).toContain('Use this JSON format');
    await expect(send(evidence.id)).resolves.toEqual({ kind: 'sources', items: [
      { claim: 'The catalogue lists a brass kettle.', quote: 'A brass kettle sits on the shelf.' },
    ] });

    const retryPreview = await page.evaluate(() => window.privateBrowser.prepareAiPreview('selection'));
    const makeReview = () => page.evaluate(({ id, text }) => window.privateBrowser.reviewAssistantRequest(id, text, 'What is listed?'), retryPreview);
    await app.evaluate(() => { (globalThis as typeof globalThis & { __pbAiConnection?: Fixture }).__pbAiConnection!.mode = 'timeout'; });
    const firstAttempt = await makeReview();
    await expect(send(firstAttempt.id)).resolves.toEqual({ kind: 'timeout' });
    await expect(send(firstAttempt.id)).rejects.toThrow(/review the request/i);
    await app.evaluate(() => { (globalThis as typeof globalThis & { __pbAiConnection?: Fixture }).__pbAiConnection!.mode = 'waiting'; });
    const retry = await makeReview();
    expect(retry.id).not.toBe(firstAttempt.id);
    const pending = send(retry.id);
    await expect.poll(async () => (await readBodies()).length).toBe(7);
    await page.evaluate((id) => window.privateBrowser.cancelReviewedAssistant(id), retry.id);
    await expect(pending).resolves.toEqual({ kind: 'cancelled' });

    const initial = await page.evaluate(() => window.privateBrowser.getState());
    const receipts = initial.assistantPolicy.receipts;
    expect(receipts.map((item) => item.purpose)).toEqual([
      'page-request', 'page-request', 'page-request', 'page-request', 'connection-test', 'connection-test', 'connection-test',
    ]);
    expect(receipts.every((item) => item.destination === 'https://ai-fixture.example.com' && Number.isFinite(Date.parse(item.at)))).toBe(true);
    expect(receipts.every((item) => Object.keys(item).sort().join(',') === 'at,destination,mode,purpose')).toBe(true);
    await page.evaluate((id) => window.privateBrowser.setAssistantCloudAllowed(id, false), initial.activeAccountSpaceId);
    await expect(check()).rejects.toThrow(/cloud AI is disabled/i);
    await expect(makeReview()).rejects.toThrow(/cloud AI is disabled/i);
    expect(await readBodies()).toHaveLength(7);
    await page.evaluate((fromTenten) => window.privateBrowser.switchWorkspace(fromTenten ? 'personal' : 'tenten'), initial.activeWorkspaceId === 'tenten');
    await expect(page.evaluate(() => window.privateBrowser.getState().then((state) => state.assistantPolicy))).resolves.toEqual({ cloud: 'allowed', receipts: [] });
    await expect(page.evaluate((id) => window.privateBrowser.setAssistantCloudAllowed(id, true), initial.activeAccountSpaceId)).rejects.toThrow(/unavailable in this Account Space/i);
    await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
    await expect(check()).rejects.toThrow(/unavailable in this Account Space/i);
    await expect(page.evaluate(() => window.privateBrowser.getState().then((state) => state.assistantPolicy))).resolves.toEqual({ cloud: 'unavailable', receipts: [] });

    await test.step('restore the encrypted Account Space settings after restart', async () => {
      await page.evaluate((id) => window.privateBrowser.switchWorkspace(id), initial.activeWorkspaceId);
      await page.evaluate(() => window.privateBrowser.newTab());
      await app.close();
      app = await launch();
      const restoredPage = await app.firstWindow();
      await expect.poll(() => restoredPage.evaluate(() => window.privateBrowser.getState().then((state) => state.assistantPolicy)))
        .toEqual({ cloud: 'disabled', receipts });
    });
  } finally {
    await app.close();
    await new Promise<void>((closed) => {
      server.close(() => closed());
      server.closeAllConnections();
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  }
});
