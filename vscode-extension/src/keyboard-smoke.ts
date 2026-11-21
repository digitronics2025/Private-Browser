import type { expect as expectType, Page } from '@playwright/test';
import type { KeyboardSmokeCheck } from './test-scenario.js';

export async function runKeyboardSmoke(page: Page, expect: typeof expectType, target: string, check: KeyboardSmokeCheck) {
  const samples: number[] = [];
  const runs: number[] = [];
  for (let repeat = 0; repeat < check.repeats; repeat++) {
    let stepNumber = 0;
    try {
      const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 6_000 });
      if (!response?.ok() || page.url() !== target) return { samples, runs, issue: `Repeat ${repeat + 1} could not load the exact fixture route.` };
      const started = performance.now();
      for (const step of check.steps) {
        stepNumber++;
        const before = performance.now();
        if (before - started >= check.budgetMs) return { samples, runs, issue: `Repeat ${repeat + 1} ran out of time before step ${stepNumber}.` };
        await page.keyboard.press(step.key);
        const remaining = check.budgetMs - (performance.now() - started);
        if (remaining <= 0) return { samples, runs, issue: `Repeat ${repeat + 1} exceeded its budget at step ${stepNumber}.` };
        const locator = page.getByRole(step.expect.role, { name: step.expect.name, exact: true });
        const timeout = Math.max(1, Math.floor(remaining));
        if (step.expect.state === 'focused') await expect(locator).toBeFocused({ timeout });
        else await expect(locator).toBeVisible({ timeout });
        if (page.url() !== target) return { samples, runs, issue: `Repeat ${repeat + 1}, step ${stepNumber} left the reviewed route.` };
        samples.push(performance.now() - before);
      }
      const elapsed = performance.now() - started;
      if (elapsed > check.budgetMs) return { samples, runs, issue: `Repeat ${repeat + 1} exceeded its time budget.` };
      runs.push(elapsed);
    } catch {
      const step = check.steps[stepNumber - 1];
      return { samples, runs, issue: step
        ? `Repeat ${repeat + 1}, step ${stepNumber} (${step.key}) missed its ${step.expect.state} check.`
        : `Repeat ${repeat + 1} could not load the exact fixture route.` };
    }
  }
  return { samples, runs, issue: undefined };
}

export function smokeLatency(samples: readonly number[]): { median: number; p90: number } | undefined {
  if (!samples.length) return undefined;
  const ordered = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  return { median: Math.round(median), p90: Math.round(ordered[Math.ceil(ordered.length * .9) - 1]) };
}
