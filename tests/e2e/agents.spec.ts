import { expect, test } from '@playwright/test';

for (const width of [1280, 375]) {
  test(`shows Agent setup and confirmation at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Browser menu' }).click();
    await page.getByRole('menu', { name: 'Browser menu' }).getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Open Agents' }).click();
    const allow = page.getByRole('checkbox', { name: 'Allow coding agents' });
    await expect(allow).not.toBeChecked();
    await allow.check();
    await page.getByRole('button', { name: 'Generate pairing code' }).click();
    await expect(page.getByText('12345678')).toBeVisible();
    await page.screenshot({ path: info.outputPath('agents-panel.png') });

    await page.goto('/?preview=agent-action#agent-workspace');
    const card = page.getByRole('alertdialog', { name: 'Approve agent action' });
    await expect(card).toBeVisible();
    await expect(card.getByText('http://localhost:3000/save')).toBeVisible();
    await page.screenshot({ path: info.outputPath('agent-confirmation.png') });
    await card.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText('Codex is controlling this tab')).toBeVisible();
    await page.screenshot({ path: info.outputPath('agent-banner.png') });
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByText('No agent is driving')).toBeVisible();
  });
}
