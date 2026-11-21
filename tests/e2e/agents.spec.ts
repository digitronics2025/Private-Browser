import axe from 'axe-core';
import { expect, test, type Page } from '@playwright/test';

async function verifyAccessibility(page: Page, selector: string): Promise<void> {
  const issues = await page.evaluate(async (selector) => {
    const scanner = (window as unknown as { axe: typeof axe }).axe;
    return (await scanner.run(selector)).violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  }, selector);
  expect(issues).toEqual([]);
}

for (const width of [1280, 375]) {
  test(`shows Agent setup and confirmation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/?preview=agent-settings');
    await page.getByRole('button', { name: 'Browser menu' }).click();
    await page.getByRole('menu', { name: 'Browser menu' }).getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Open Agents' }).click();
    const allow = page.getByRole('checkbox', { name: 'Allow coding agents' });
    await expect(allow).not.toBeChecked();
    await allow.check();
    const agentSettings = page.locator('.agents-panel');
    await agentSettings.getByRole('button', { name: 'Limits for Claude Code' }).click();
    const duration = agentSettings.getByRole('spinbutton', { name: 'Session duration (hours)' });
    await expect(duration).toHaveValue('8');
    await expect(duration).toHaveAttribute('max', '12');
    await agentSettings.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Generate pairing code' }).click();
    await expect(page.getByText('12345678')).toBeVisible();
    await page.screenshot({ path: info.outputPath('agents-panel.png') });

    await page.goto('/?preview=agent-action#agent-workspace');
    const card = page.getByRole('alertdialog', { name: 'Approve agent action' });
    await expect(card).toBeVisible();
    await expect(card.getByText('http://localhost:3000/save')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Always allow on this site' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('agent-confirmation.png') });
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText('Codex is controlling this tab')).toBeVisible();
    await page.screenshot({ path: info.outputPath('agent-banner.png') });
    await page.goto('/?preview=agent-site-approval#agent-workspace');
    await expect(card.getByRole('button', { name: 'Allow navigation for this session on this origin' })).toBeVisible();
    await card.getByRole('button', { name: 'Always allow on this site' }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByText('No agent is driving')).toBeVisible();
  });
}


for (const [width, height] of [[1440, 900], [375, 812]]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test('Agent policy screens at ' + width + ' in ' + colorScheme, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.addInitScript({ content: axe.source });
      await page.goto('/?preview=agent-settings');
      await page.getByRole('button', { name: 'Browser menu' }).click();
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Open Agents' }).click();
      await page.getByRole('checkbox', { name: 'Allow coding agents' }).check();
      await verifyAccessibility(page, '.agents-panel');
      await page.getByRole('button', { name: 'Edit Work' }).click();
      const settings = page.locator('.agents-panel');
      const origin = settings.getByRole('textbox', { name: 'Add an origin' });
      await origin.fill('https://app.example.com/path');
      await expect(origin).toHaveAttribute('aria-invalid', 'true');
      await expect(settings.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
      await origin.fill('HTTPS://*.App.Example.com:443');
      await expect(settings.getByText('https://*.app.example.com')).toBeVisible();
      await expect(settings.getByText('This includes every subdomain.')).toBeVisible();
      await origin.press('Enter');
      await expect(settings.getByRole('button', { name: 'Remove https://*.app.example.com' })).toBeVisible();
      await page.screenshot({ path: info.outputPath('space-settings.png') });

      await verifyAccessibility(page, '.agents-panel');

      await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
      await settings.getByRole('button', { name: 'Edit Open Web' }).click();
      await verifyAccessibility(page, '.agents-panel');
      await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
      await settings.getByRole('button', { name: 'Limits for Claude Code' }).click();
      await expect(settings.getByRole('spinbutton', { name: 'Open agent tabs' })).toHaveValue('8');
      await verifyAccessibility(page, '.agents-panel');
      await settings.getByRole('button', { name: 'Review renewal' }).click();
      const renewal = page.getByRole('dialog', { name: 'Renew Claude Code session' });
      await expect(renewal.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await verifyAccessibility(page, '.agent-owner-dialog');
      await page.keyboard.press('Tab');
      await expect(renewal.getByRole('button', { name: 'Renew for 8 hours' })).toBeFocused();
      await page.screenshot({ path: info.outputPath('session-renewal.png') });
      await page.keyboard.press('Escape');
      await expect(settings.getByRole('button', { name: 'Review renewal' })).toBeFocused();
      await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
      await settings.getByRole('button', { name: 'Audit log', exact: true }).click();
      await expect(settings.getByText('No actions recorded in this view.')).toBeVisible();
      await verifyAccessibility(page, '.agents-panel');
    });
  }
}

for (const [width, height] of [[1440, 900], [375, 812]]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test('Open Web warning at ' + width + ' in ' + colorScheme, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
      await page.addInitScript({ content: axe.source });
      await page.goto('/?preview=agent-warning#agent-workspace');
      const warning = page.getByRole('dialog', { name: 'Possible sign-in in Open Web' });
      await expect(warning.getByRole('button', { name: 'Keep paused' })).toBeFocused();
      await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
      await verifyAccessibility(page, '.agent-owner-dialog');
      await page.screenshot({ path: info.outputPath('sign-in-warning.png') });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Review sign-in warning' })).toBeVisible();
      await page.getByRole('button', { name: 'Review sign-in warning' }).click();
      await expect(warning).toBeVisible();
    });
  }
}
