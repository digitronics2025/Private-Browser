import { expect, test, type Page } from '@playwright/test';

async function openOverview(page: Page, scenario: 'sample' | 'uncertain') {
  await page.goto(`/?googleActions=${scenario}`);
  await page.getByRole('button', { name: 'Account Space: Operations' }).click();
  await page.getByRole('menuitem', { name: /Manage Account Spaces/ }).click();
  const overview = page.getByRole('region', { name: 'Google overview', exact: true });
  await overview.getByRole('button', { name: 'Show Google overview' }).click();
  return overview;
}

test('reviews the exact Gmail, Drive and Calendar changes at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  const overview = await openOverview(page, 'sample');
  const reply = overview.getByRole('region', { name: 'Draft a reply' });
  const compose = async () => {
    await overview.getByRole('button', { name: 'Reply to New stock update' }).click();
    await reply.getByLabel('Reply', { exact: true }).fill('Thanks. I reviewed the numbers.');
    await expect(reply.getByRole('button', { name: 'Send reply' })).toHaveCount(0);
    await reply.getByRole('button', { name: 'Review action' }).click();
    await expect(reply.getByText('stocks@example.test')).toBeVisible();
    await expect(reply.getByText('operations@example.com')).toBeVisible();
    await expect(reply.getByText('Thanks. I reviewed the numbers.')).toBeVisible();
    await reply.getByRole('button', { name: 'Send reply' }).click();
    await expect(reply.getByRole('status')).toContainText('Google confirmed this action');
  };
  await compose();
  const firstReceipt = await reply.getByRole('status').getByText(/Receipt/).textContent();
  await reply.getByRole('button', { name: 'Close receipt' }).click();
  await compose();
  await expect(reply.getByRole('status').getByText(/Receipt/)).toHaveText(firstReceipt!);
  await reply.getByRole('button', { name: 'Close receipt' }).click();

  await overview.getByRole('button', { name: 'Drive', exact: true }).click();
  await overview.getByRole('button', { name: 'Share Stock worksheet' }).click();
  const share = overview.getByRole('region', { name: 'Share a Drive file' });
  await share.getByLabel('Recipient email').fill('supplier@example.test');
  await share.getByLabel('Access').selectOption('writer');
  await share.getByRole('button', { name: 'Review action' }).click();
  await expect(share.getByText('Stock worksheet')).toBeVisible();
  await expect(share.getByText('supplier@example.test')).toBeVisible();
  await expect(share.getByText('Editor', { exact: true })).toBeVisible();
  await share.getByRole('button', { name: 'Grant access and notify' }).click();
  await expect(share.getByRole('status')).toContainText('Google confirmed this action');
  await share.getByRole('button', { name: 'Close receipt' }).click();

  await overview.getByRole('button', { name: 'Schedule a meeting' }).click();
  const meeting = overview.getByRole('region', { name: 'Schedule a meeting' });
  await meeting.getByLabel('Meeting title').fill('Shipment planning');
  await meeting.getByLabel('Starts').fill('2026-12-02T09:15');
  await meeting.getByLabel('Ends').fill('2026-12-02T09:45');
  await meeting.getByLabel('Invitees').fill('supplier@example.test,team@example.test');
  await meeting.getByLabel('Add Google Meet').check();
  await meeting.getByRole('button', { name: 'Review action' }).click();
  await expect(meeting.getByText('Shipment planning')).toBeVisible();
  await expect(meeting.getByText('supplier@example.test, team@example.test')).toBeVisible();
  await expect(meeting.getByText('Add a meeting link')).toBeVisible();
  await meeting.getByRole('button', { name: 'Create event and invite' }).click();
  await expect(meeting.getByRole('status')).toContainText('Google confirmed this action');
});

test('keeps an unconfirmed action visible with a receipt and offers no retry button', async ({ page }) => {
  const overview = await openOverview(page, 'uncertain');
  await overview.getByRole('button', { name: 'Reply to New stock update' }).click();
  const reply = overview.getByRole('region', { name: 'Draft a reply' });
  await reply.getByLabel('Reply', { exact: true }).fill('I received the shipment report.');
  await reply.getByRole('button', { name: 'Review action' }).click();
  await reply.getByRole('button', { name: 'Send reply' }).click();
  await expect(reply.getByRole('status')).toContainText('Result unconfirmed');
  await expect(reply.getByRole('status')).toContainText(/Check the original Google app/);
  await expect(reply.getByRole('button', { name: /Retry|Send reply/ })).toHaveCount(0);
});
