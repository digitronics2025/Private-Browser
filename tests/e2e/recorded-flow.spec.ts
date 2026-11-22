import { expect, test } from '@playwright/test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import {
  recordedFlowPreview, recordedFlowScript, replayRecordedFlow, restrictRecording, startFlowRecorder,
} from '../../vscode-extension/src/recorded-flow';

test('records a synthetic checkout, omits typed text, and replays a user-selected result', async ({ browser }) => {
  let writeRequests = 0;
  const server = createServer((request, response) => {
    if (request.method === 'POST') { writeRequests++; response.writeHead(204).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><title>Checkout fixture</title>
      <label>Fixture input<input></label>
      <button data-testid="continue" onclick="document.querySelector('section').hidden = false">Continue</button>
      <section hidden><label><input type="checkbox" data-testid="confirm-policy"> Confirm</label>
      <button data-testid="place-order" onclick="if (document.querySelector('[type=checkbox]').checked) {
        void fetch('/write', { method: 'POST' }).catch(() => {}); document.querySelector('output').hidden = false;
      }">Place order</button></section><output data-testid="receipt" hidden>Sample receipt</output>`);
  });
  const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  const replay = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture cannot listen on loopback');
    const target = new URL('http://127.0.0.1:' + address.port + '/checkout');
    await restrictRecording(context, target);
    const page = await context.newPage();
    await page.goto(target.href);
    const recording = await startFlowRecorder(page, target, 15_000);
    const toolbar = page.getByRole('complementary', { name: 'Private Browser fixture recorder' });
    await expect(toolbar.getByRole('button', { name: 'Finish recording' })).toBeDisabled();
    await page.getByRole('textbox', { name: 'Fixture input' }).fill('synthetic-text-that-must-not-be-recorded');
    await page.getByTestId('continue').click();
    await page.getByTestId('confirm-policy').check();
    await page.getByTestId('place-order').click();
    await expect(page.getByTestId('receipt')).toBeVisible();
    await toolbar.getByRole('button', { name: 'Pick expected result' }).click();
    await page.getByTestId('receipt').click();
    await toolbar.getByRole('button', { name: 'Finish recording' }).click();
    const flow = await recording.result;
    expect(flow).toEqual({
      actions: [{ kind: 'click', id: 'continue' }, { kind: 'check', id: 'confirm-policy' }, { kind: 'click', id: 'place-order' }],
      outcome: 'receipt', skipped: 1,
    });
    const preview = recordedFlowPreview(flow!);
    expect(preview).toContain('3. click place-order');
    expect(preview).toContain('Expected visible result: receipt');
    const script = recordedFlowScript(target, flow!);
    expect(script).toContain('await page.locator(' + JSON.stringify('[data-testid="confirm-policy"]') + ').check()');
    expect(script).toContain('await expect(page.locator(' + JSON.stringify('[data-testid="receipt"]') + ')).toBeVisible()');
    expect(script).not.toContain('synthetic-text-that-must-not-be-recorded');
    await restrictRecording(replay, target);
    await replayRecordedFlow(await replay.newPage(), target, flow!);
    expect(writeRequests).toBe(0);
  } finally {
    await Promise.all([context.close(), replay.close()]);
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
