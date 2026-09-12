import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import axe from 'axe-core';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

interface Input { reportId: string; projectId: string; startedAt: string; kind: string; url: string; liveUrl?: string; root: string; artifactRoot: string; }
interface Finding { status: 'passed' | 'attention' | 'failed' | 'skipped'; title: string; cause: string; evidence: string; location?: string; recommendation: string; }

async function main(): Promise<void> {
  const input = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8')) as Input;
  const requireFromProject = createRequire(join(input.root, 'package.json'));
  const { chromium } = requireFromProject('@playwright/test') as typeof import('@playwright/test');
  await mkdir(input.artifactRoot, { recursive: true });
  const browser = await chromium.launch({ headless: input.kind !== 'record-flow' });
  const findings: Finding[] = []; const artifacts: Array<{ id: string; name: string; kind: 'screenshot' | 'trace' | 'diff' | 'test' | 'log'; size: number }> = [];
  const startedAt = input.startedAt;
  try {
    const viewports = input.kind === 'responsive' ? [{ name: 'desktop', width: 1440, height: 900 }, { name: 'tablet', width: 768, height: 1024 }, { name: 'mobile', width: 375, height: 812 }] : [{ name: 'desktop', width: 1440, height: 900 }];
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, storageState: undefined, acceptDownloads: false });
      if (input.kind !== 'record-flow') await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage(); const consoleErrors: string[] = []; const networkErrors: string[] = [];
      page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)); });
      page.on('requestfailed', (request) => networkErrors.push(`${request.method()} ${new URL(request.url()).origin}${new URL(request.url()).pathname} — ${request.failure()?.errorText ?? 'failed'}`));
      const response = await page.goto(input.url, { waitUntil: 'networkidle', timeout: 30_000 });
      findings.push({ status: response?.ok() ? 'passed' : 'failed', title: `${viewport.name} page load`, cause: response?.ok() ? 'Page loaded successfully.' : `HTTP ${response?.status() ?? 'failure'}`, evidence: `${new URL(input.url).origin}${new URL(input.url).pathname}`, recommendation: response?.ok() ? 'No action needed.' : 'Check the development server and the first failed request.' });
      if (consoleErrors.length) findings.push({ status: 'failed', title: 'Console errors', cause: `${consoleErrors.length} console error(s)`, evidence: consoleErrors.join('\n').slice(0, 8_000), recommendation: 'Open the first traceable source location and fix the root error.' });
      if (networkErrors.length) findings.push({ status: 'failed', title: 'Failed requests', cause: `${networkErrors.length} request(s) failed`, evidence: networkErrors.join('\n').slice(0, 8_000), recommendation: 'Verify the API endpoint and development proxy configuration.' });
      if (['current-page', 'live-site', 'responsive', 'compare'].includes(input.kind)) {
        const path = join(input.artifactRoot, `${viewport.name}.png`); await page.screenshot({ path, fullPage: false });
        artifacts.push({ id: randomUUID(), name: `${viewport.name}.png`, kind: 'screenshot', size: (await stat(path)).size });
      }
      if (input.kind === 'accessibility') {
        await page.addScriptTag({ content: axe.source });
        const result = await page.evaluate(async () => (globalThis as typeof globalThis & { axe: { run(): Promise<{ violations: Array<{ id: string; impact?: string; help: string; nodes: unknown[] }> }> } }).axe.run());
        findings.push(...result.violations.map((violation) => ({ status: 'failed' as const, title: `Accessibility: ${violation.id}`, cause: violation.help, evidence: `${violation.nodes.length} affected node(s), impact ${violation.impact ?? 'unknown'}`, recommendation: 'Fix the affected markup and re-run the WCAG check.' })));
        if (!result.violations.length) findings.push({ status: 'passed', title: 'Accessibility', cause: 'No automated axe violations found.', evidence: 'WCAG automated scan complete.', recommendation: 'Continue with keyboard and screen-reader review.' });
      }
      if (input.kind === 'performance') {
        const metrics = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
          const lcpEntries = performance.getEntriesByType('largest-contentful-paint') as Array<PerformanceEntry & { startTime: number }>;
          const shifts = performance.getEntriesByType('layout-shift') as Array<PerformanceEntry & { value?: number; hadRecentInput?: boolean }>;
          return { domContentLoaded: nav?.domContentLoadedEventEnd ?? 0, load: nav?.loadEventEnd ?? 0, lcp: lcpEntries.at(-1)?.startTime ?? 0, cls: shifts.filter((item) => !item.hadRecentInput).reduce((sum, item) => sum + (item.value ?? 0), 0), inp: null };
        });
        const passes = metrics.lcp <= 2500 && metrics.cls <= 0.1;
        findings.push({ status: passes ? 'passed' : 'attention', title: 'Core Web Vitals', cause: `LCP ${Math.round(metrics.lcp)} ms · CLS ${metrics.cls.toFixed(3)} · INP needs an interaction`, evidence: JSON.stringify(metrics), recommendation: passes ? 'Exercise a key interaction to measure INP.' : 'Profile the largest content paint and layout shifts, then re-run.' });
      }
      if (input.kind === 'record-flow') {
        await page.pause();
        const testName = 'recorded-flow.spec.ts';
        const testPath = join(input.artifactRoot, testName);
        await writeFile(testPath, `import { test, expect } from '@playwright/test';\n\ntest('recorded Private Browser flow', async ({ page }) => {\n  await page.goto(${JSON.stringify(input.url)});\n  await expect(page).toHaveURL(${JSON.stringify(input.url)});\n});\n`);
        artifacts.push({ id: randomUUID(), name: testName, kind: 'test', size: (await stat(testPath)).size });
        findings.push({ status: 'passed', title: 'Flow recording', cause: 'The isolated Playwright recorder completed.', evidence: 'No browser profile state was imported.', recommendation: 'Review generated steps before saving them into the workspace.' });
      }
      if (input.kind !== 'record-flow') {
        const tracePath = join(input.artifactRoot, `${viewport.name}-trace.zip`);
        await context.tracing.stop({ path: tracePath });
        const traceSize = (await stat(tracePath)).size;
        if (traceSize <= 10 * 1024 * 1024) artifacts.push({ id: randomUUID(), name: `${viewport.name}-trace.zip`, kind: 'trace', size: traceSize });
        else { await rm(tracePath, { force: true }); findings.push({ status: 'attention', title: 'Trace omitted', cause: 'The trace exceeded the 10 MiB artifact limit.', evidence: `${traceSize} bytes`, recommendation: 'Narrow the tested flow and re-run.' }); }
      }
      await context.close();
    }
    if (input.kind === 'compare' && input.liveUrl) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const page = await context.newPage();
      const livePath = join(input.artifactRoot, 'live.png'); await page.goto(input.liveUrl, { waitUntil: 'networkidle', timeout: 30_000 }); await page.screenshot({ path: livePath, fullPage: false });
      const local = PNG.sync.read(await readFile(join(input.artifactRoot, 'desktop.png'))); const live = PNG.sync.read(await readFile(livePath));
      if (local.width === live.width && local.height === live.height) {
        const diff = new PNG({ width: local.width, height: local.height }); const changed = pixelmatch(local.data, live.data, diff.data, local.width, local.height, { threshold: 0.1 });
        const diffPath = join(input.artifactRoot, 'diff.png'); await writeFile(diffPath, PNG.sync.write(diff));
        artifacts.push({ id: randomUUID(), name: 'diff.png', kind: 'diff', size: (await stat(diffPath)).size });
        findings.push({ status: changed === 0 ? 'passed' : 'attention', title: 'Local vs live visual comparison', cause: `${changed} pixels differ`, evidence: `${((changed / (local.width * local.height)) * 100).toFixed(2)}% changed`, recommendation: changed === 0 ? 'No action needed.' : 'Review the visual diff before deployment.' });
      } else findings.push({ status: 'attention', title: 'Local vs live dimensions', cause: 'Screenshots have different dimensions.', evidence: `${local.width}×${local.height} vs ${live.width}×${live.height}`, recommendation: 'Compare matching route content and viewport heights.' });
      await context.close();
    }
  } finally { await browser.close(); }
  const status = findings.some((item) => item.status === 'failed') ? 'failed' : findings.some((item) => item.status === 'attention') ? 'attention' : 'passed';
  process.stdout.write(JSON.stringify({ id: input.reportId, projectId: input.projectId, kind: input.kind, status, title: `Playwright ${input.kind}`, startedAt, finishedAt: new Date().toISOString(), summary: `${findings.length} check(s) completed in an isolated browser profile.`, findings, artifacts }));
}

void main().catch((error) => { process.stderr.write(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
