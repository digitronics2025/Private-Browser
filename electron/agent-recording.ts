import { clean, cleanUrl } from './agent-driver.js';
import type { TargetDetails } from './agent-driver.js';

const roleLocators = new Set(['button', 'link', 'checkbox', 'radio', 'combobox', 'listbox', 'textbox', 'slider', 'heading']);
const literal = (value: string) => JSON.stringify(value).replace(/[\u2028\u2029]/g, (char) => char === '\u2028' ? '\\u2028' : '\\u2029');

export class AgentRecording {
  private readonly steps: string[] = [];
  private fields = 0;

  constructor(url?: string) { if (url) this.navigate(url); }

  navigate(url: string): void { this.add(`await page.goto(${literal(cleanUrl(url))});`); }

  action(method: string, target: TargetDetails, input: { text?: string; submit?: boolean; value?: string; checked?: boolean }): void {
    if (!target.name || target.private) return;
    const name = clean(target.name);
    const locator = roleLocators.has(target.role)
      ? `page.getByRole(${literal(target.role)}, { name: ${literal(name)}, exact: true })`
      : `page.getByText(${literal(name)}, { exact: true })`;
    if (method === 'click' || method === 'hover') this.add(`await ${locator}.${method}();`);
    if (method === 'type') {
      const value = input.text ?? '';
      const field = clean(value, 4_000) === value ? literal(value) : `process.env.PRIVATE_BROWSER_TEST_VALUE_${++this.fields} ?? ''`;
      this.add(`await ${locator}.fill(${field});`);
      if (input.submit) this.add(`await ${locator}.press('Enter');`);
    }
    if (method === 'check') this.add(`await ${locator}.setChecked(${input.checked});`);
    if (method === 'select_option') this.add(`await ${locator}.selectOption(${literal(clean(input.value ?? ''))});`);
  }

  step(command: 'goBack' | 'goForward' | 'reload'): void { this.add(`await page.${command}();`); }

  finish(): string {
    return [
      "import { test } from '@playwright/test';", '', "test('recorded Private Browser flow', async ({ page }) => {",
      ...this.steps.map((step) => `  ${step}`), '});', '',
    ].join('\n');
  }

  private add(step: string): void {
    if (this.steps.length < 70) this.steps.push(step);
  }
}
