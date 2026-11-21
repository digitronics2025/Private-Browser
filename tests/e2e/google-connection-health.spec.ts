import { expect, test } from '@playwright/test';

test('keeps website sign-in independent and lets a pending space resume with identity only', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/');
  await page.evaluate(() => {
    const api = window.privateBrowser;
    const connect = api.connectGoogleAccount;
    let first = true;
    api.openInAccountSpace = async (id, url) => {
      document.documentElement.dataset.openWebsite = JSON.stringify({ id, url });
    };
    api.connectGoogleAccount = async (id, modules, browser) => {
      document.documentElement.dataset.connectTools = JSON.stringify({ id, modules });
      if (first) {
        first = false;
        return { ok: false, error: { code: 'GOOGLE_CANCELLED', message: 'Cancelled', requestId: 'fixture' } };
      }
      return connect(id, modules, browser);
    };
  });
  const openManager = async () => {
    await page.getByRole('button', { name: /^Account Space:/ }).click();
    await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
    return page.getByRole('dialog', { name: 'Account Spaces' });
  };
  const manager = await openManager();
  await manager.getByRole('textbox', { name: 'New Account Space label' }).fill('Research setup');
  await manager.getByRole('button', { name: 'Add for Google tools' }).click();
  await expect(manager.getByRole('button', { name: 'Research setup Google setup pending' })).toBeVisible();
  await expect(manager.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  const id = await page.evaluate(async () => (await window.privateBrowser.getState()).activeAccountSpaceId);
  const root = page.locator('html');
  await manager.getByRole('button', { name: 'Open Google sign-in' }).click();
  await expect(root).toHaveAttribute('data-open-website', JSON.stringify({ id, url: 'https://accounts.google.com/' }));
  await expect(root).not.toHaveAttribute('data-connect-tools', /./);
  await expect(manager).toBeHidden();
  await openManager();
  await manager.getByRole('button', { name: 'Resume Google setup' }).click();
  await expect(page.getByText('Google setup paused. Resume it from this Account Space.')).toBeVisible();
  await expect(root).toHaveAttribute('data-connect-tools', JSON.stringify({ id, modules: ['identity'] }));
  await manager.getByRole('button', { name: 'Resume Google setup' }).click();
  await expect(manager.getByRole('button', { name: 'Enable Gmail overview', exact: true })).toBeVisible();
  await manager.getByRole('button', { name: 'Enable Gmail overview', exact: true }).click();
  await expect(root).toHaveAttribute('data-connect-tools', JSON.stringify({ id, modules: ['identity', 'gmail-metadata'] }));
  await expect(manager.getByRole('button', { name: 'Turn off Gmail overview', exact: true })).toBeVisible();
});

test('shows last success and quota delay for the selected account', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/?googleHealth=quota');
  await page.getByRole('button', { name: 'Account Space: Operations' }).click();
  await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
  const manager = page.getByRole('dialog', { name: 'Account Spaces' });
  const health = manager.getByRole('status').filter({ hasText: 'Google quota delay' });
  await expect(health.getByText('Selected Account Space · Operations')).toBeVisible();
  await expect(health.locator('time')).toHaveAttribute('datetime', '2026-11-21T12:00:00Z');
  await expect(health.getByText(/Try again after/)).toBeVisible();
  await manager.getByRole('button', { name: 'Personal Local only' }).click();
  await expect(manager.getByRole('status').filter({ hasText: 'Google tools are disconnected' })).toContainText('Selected Account Space · Personal');
  await expect(health).toHaveCount(0);
});

test('reviews Google tools and website data actions for the selected Account Space', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  const confirmations: string[] = [];
  page.on('dialog', (dialog) => { confirmations.push(dialog.message()); void dialog.accept(); });
  const openOverview = async () => {
    await page.goto('/?googleHealth=quota');
    await page.getByRole('button', { name: 'Account Space: Operations' }).click();
    await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
    const overview = page.getByRole('region', { name: 'Account access overview' });
    await overview.getByText('Manage access and website data', { exact: true }).click();
    return overview;
  };
  const overview = await openOverview();
  await expect(overview).toContainText('Session data present');
  await expect(overview).toContainText('Profile identity, Gmail overview, Drive app files, Calendar read');
  await expect(overview).toContainText('Encrypted backup');
  await overview.getByRole('button', { name: 'Clear website data and history' }).click();
  await expect(overview).toContainText('Not visited');
  await expect(overview).toContainText('Gmail overview');
  await overview.getByRole('button', { name: 'Disconnect Google tools on this PC' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-preview-google-access', 'disconnect');
  await expect(overview.getByText('None', { exact: true })).toBeVisible();

  const refreshed = await openOverview();
  await refreshed.getByRole('button', { name: 'Revoke Google access' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-preview-google-access', 'revoke');
  await expect(refreshed).toContainText('Session data present');
  expect(confirmations).toHaveLength(3);
  expect(confirmations[0]).toContain('Operations');
  expect(confirmations[1]).toContain('operations@example.com');
  expect(confirmations[2]).toContain('operations@example.com');
});
