import type { BrowserContext, Page } from '@playwright/test';

type Action = { kind: 'click' | 'check' | 'uncheck'; id: string };
export interface RecordedFlow { actions: Action[]; outcome: string; skipped: number }

const binding = '__privateBrowserFinishFixtureRecording';
const maxSteps = 24;
const testId = /^[a-z][a-z0-9_-]{0,47}$/i;
const testSelector = (id: string) => '[data-testid="' + id + '"]';

export function recordingTarget(url: URL): boolean {
  return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    && !url.username && !url.password && !url.search && !url.hash;
}

export async function restrictRecording(context: BrowserContext, target: URL): Promise<void> {
  if (!recordingTarget(target)) throw new Error('Flow recording requires a local fixture route.');
  await context.routeWebSocket('**/*', (route) => { void route.close(); });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== target.origin || !['GET', 'HEAD'].includes(request.method())
      || (request.isNavigationRequest() && url.href !== target.href)) {
      await route.abort();
      return;
    }
    const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
    if (response.status() >= 300 && response.status() < 400) await route.abort();
    else await route.fulfill({ response });
  });
}

export async function replayRecordedFlow(page: Page, target: URL, flow: RecordedFlow): Promise<void> {
  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  for (const { kind, id } of flow.actions) await page.locator(testSelector(id))[kind]({ timeout: 3_000 });
  await page.locator(testSelector(flow.outcome)).waitFor({ state: 'visible', timeout: 3_000 });
}

function validateFlow(value: unknown): RecordedFlow | undefined {
  if (!value || typeof value !== 'object') return;
  const { actions, outcome, skipped } = value as Partial<RecordedFlow>;
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > maxSteps
    || !actions.every((step) => step && ['click', 'check', 'uncheck'].includes(step.kind) && typeof step.id === 'string' && testId.test(step.id))
    || typeof outcome !== 'string' || !testId.test(outcome) || typeof skipped !== 'number' || !Number.isSafeInteger(skipped) || skipped < 0 || skipped > 1000) return;
  return { actions: actions.map(({ kind, id }) => ({ kind, id })), outcome, skipped };
}

/** The page capture accepts trusted pointer or keyboard actions on labelled fixture controls. */
export async function startFlowRecorder(page: Page, url: URL, limitMs = 180_000): Promise<{ result: Promise<RecordedFlow | undefined> }> {
  if (!recordingTarget(url) || page.url() !== url.href) throw new Error('Open the approved loopback fixture before recording.');
  let done!: (flow?: RecordedFlow) => void;
  const result = new Promise<RecordedFlow | undefined>((resolve) => { done = resolve; });
  await page.exposeBinding(binding, async ({ frame }, value: unknown) => {
    if (frame !== page.mainFrame() || page.url() !== url.href) return false;
    const flow = validateFlow(value);
    if (!flow) return false;
    const outcome = page.locator(testSelector(flow.outcome));
    if (await outcome.count() !== 1 || !await outcome.isVisible()) return false;
    done(flow);
    return true;
  });
  await page.evaluate(({ bridge, maxSteps }) => {
    const steps: Action[] = [];
    let skipped = 0;
    let choosingOutcome = false;
    let outcome = '';
    const container = document.createElement('aside');
    container.setAttribute('aria-label', 'Private Browser fixture recorder');
    Object.assign(container.style, {
      position: 'fixed', inset: 'auto 16px 16px auto', maxWidth: 'calc(100vw - 32px)', zIndex: '2147483647',
    });
    const shadow = container.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host { color-scheme: light; font: 14px system-ui; color: #1d293b; } div { background: #fff; border: 1px solid #a7b4c5; border-radius: 10px; padding: 12px; box-shadow: 0 4px 20px #17263737; } p { margin: 0 0 8px; } button { font: inherit; margin: 0 5px 0 0; padding: 5px 9px; }';
    const controls = document.createElement('div');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const choose = document.createElement('button');
    choose.textContent = 'Pick expected result';
    const finish = document.createElement('button');
    finish.textContent = 'Finish recording';
    finish.disabled = true;
    controls.append(status, choose, finish);
    shadow.append(style, controls);
    document.body.append(container);
    const labelled = (element: Element | null) => {
      const id = element?.getAttribute('data-testid');
      return id && /^[a-z][a-z0-9_-]{0,47}$/i.test(id) && document.querySelectorAll('[data-testid="' + id + '"]').length === 1 ? id : '';
    };
    const render = () => {
      status.textContent = choosingOutcome ? 'Click a visible result labelled with a unique test ID.'
        : steps.length + ' recorded · ' + skipped + ' skipped' + (outcome ? ' · Result: ' + outcome : ' · Pick a result to finish.');
      finish.disabled = !steps.length || !outcome || choosingOutcome;
    };
    const skip = () => { skipped = Math.min(1000, skipped + 1); render(); };
    const add = (step: Action) => {
      if (steps.length >= maxSteps) { skip(); return; }
      steps.push(step);
      render();
    };
    choose.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      choosingOutcome = !choosingOutcome;
      render();
    });
    finish.addEventListener('click', async (event) => {
      if (!event.isTrusted || finish.disabled) return;
      finish.disabled = true;
      const submit = (window as unknown as Record<string, (value: RecordedFlow) => Promise<boolean>>)[bridge];
      if (await submit({ actions: steps, outcome, skipped })) container.remove();
      else { outcome = ''; render(); }
    });
    document.addEventListener('click', (event) => {
      if (!event.isTrusted || event.composedPath().includes(container) || !(event.target instanceof Element)) return;
      const element = event.target;
      if (choosingOutcome) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const id = labelled(element.closest('[data-testid]'));
        if (id) { outcome = id; choosingOutcome = false; render(); }
        else skip();
        return;
      }
      if (element.closest('input[type="checkbox"]')) return;
      if (element.closest('input, textarea, select, [contenteditable]')) return;
      const control = element.closest('button, a, [role="button"], [role="link"]');
      const id = labelled(control);
      if (id) add({ kind: 'click', id });
      else skip();
    }, true);
    document.addEventListener('change', (event) => {
      if (!event.isTrusted || !(event.target instanceof HTMLElement)) return;
      const control = event.target;
      if (control instanceof HTMLInputElement && control.type === 'checkbox') {
        const id = labelled(control);
        if (id) add({ kind: control.checked ? 'check' : 'uncheck', id });
        else skip();
      } else skip();
    }, true);
    document.addEventListener('focusout', (event) => {
      if (event.isTrusted && event.target instanceof HTMLElement && event.target.matches('[contenteditable="true"]')) skip();
    }, true);
    render();
  }, { bridge: binding, maxSteps });
  const close = () => done();
  const timer = setTimeout(close, limitMs);
  page.once('close', close);
  const cleanup = () => { clearTimeout(timer); page.off('close', close); };
  return { result: result.finally(cleanup) };
}

export function recordedFlowPreview(flow: RecordedFlow): string {
  return [...flow.actions.map(({ kind, id }, index) => (index + 1) + '. ' + kind + ' ' + id), 'Expected visible result: ' + flow.outcome].join('\n');
}

export function recordedFlowScript(target: URL, flow: RecordedFlow): string {
  if (!recordingTarget(target) || !validateFlow(flow)) throw new Error('The recorded flow is outside the approved fixture scope.');
  const json = JSON.stringify;
  const actions = flow.actions.map(({ id, kind }) => '    await page.locator(' + json(testSelector(id)) + ').' + kind + '();');
  return [
    "import { expect, test } from '@playwright/test';", '',
    "test('recorded Private Browser fixture flow', async ({ browser }) => {",
    '  const target = new URL(' + json(target.href) + ');',
    "  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });",
    '  try {',
    "    await context.routeWebSocket('**/*', (route) => { void route.close(); });",
    "    await context.route('**/*', async (route) => {",
    '      const request = route.request();',
    '      const url = new URL(request.url());',
    "      if (url.origin !== target.origin || !['GET', 'HEAD'].includes(request.method())",
    '        || (request.isNavigationRequest() && url.href !== target.href)) {',
    '        await route.abort();',
    '        return;',
    '      }',
    '      const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });',
    '      if (response.status() >= 300 && response.status() < 400) await route.abort();',
    '      else await route.fulfill({ response });',
    '    });',
    '    const page = await context.newPage();',
    "    await page.goto(target.href, { waitUntil: 'domcontentloaded' });",
    ...actions,
    '    await expect(page.locator(' + json(testSelector(flow.outcome)) + ')).toBeVisible();',
    '  } finally {',
    '    await context.close();',
    '  }',
    '});', '',
  ].join('\n');
}
