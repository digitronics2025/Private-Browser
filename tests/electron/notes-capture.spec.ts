import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const notesFixture = process.env.PRIVATE_BROWSER_E2E_NOTES_WORKER_URL;
const service = notesFixture ? new URL(notesFixture) : undefined;
test.skip(!service || service.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(service.hostname),
  'Requires an isolated local Easy Copy Notes Worker');

test('the native selection review opens an unsaved draft in the local Notes app', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'private-browser-notes-clip-'));
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Research clip fixture</title><p id="excerpt">Reference selected for Notes.</p>');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const address = fixture.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind to loopback');
  const source = 'http://127.0.0.1:' + address.port;
  const inherited = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete inherited.ELECTRON_RUN_AS_NODE;
  const env = {
    ...inherited,
    PRIVATE_BROWSER_E2E_USER_DATA: profile,
    PRIVATE_BROWSER_E2E_NOTES_URL: service!.origin + '/?surface=browser',
    LOCALAPPDATA: join(profile, 'local'),
  };
  try {
    const app = await electron.launch({ args: [join(process.cwd(), 'dist-electron/main.js'), '--no-proxy-server'], env });
    try {
      const shell = await app.firstWindow();
      await expect(shell.getByRole('main', { name: 'New Tab' })).toBeVisible();
      await shell.evaluate((url) => window.privateBrowser.navigate(url), source + '/research');
      const pages = () => app.context().pages();
      await expect.poll(() => pages().some((page) => page.url() === source + '/research')).toBe(true);
      const original = pages().find((page) => page.url() === source + '/research')!;
      await app.evaluate(({ Menu }) => {
        const original = Menu.buildFromTemplate;
        Menu.buildFromTemplate = (template) => {
          const menu = original(template);
          const command = template.find((item) => item.label?.startsWith('Save selected text to Notes'));
          if (command) {
            menu.popup = (options) => {
              const action = menu.items.find((item) => item.label.startsWith('Save selected text to Notes'));
              if (action) command.click?.(action, options?.window, {} as Electron.KeyboardEvent);
            };
          }
          return menu;
        };
      });
      await original.locator('#excerpt').evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
      });
      await original.locator('#excerpt').click({ button: 'right' });
      const review = shell.getByRole('dialog', { name: 'Review text for Notes' });
      await expect(review.getByRole('textbox', { name: 'Selected text' })).toHaveValue('Reference selected for Notes.');
      await review.getByRole('textbox', { name: 'Title' }).fill('Native reviewed Notes fixture');
      await review.getByRole('textbox', { name: 'Selected text' }).fill('Edited local reference.');
      await expect.poll(() => pages().some((page) => page.url().startsWith(service!.origin))).toBe(false);
      await review.getByRole('button', { name: 'Open Notes draft' }).click();
      await expect(review).toHaveCount(0);
      await expect.poll(() => pages().some((page) => page.url().startsWith(service!.origin))).toBe(true);
      const note = pages().find((page) => page.url().startsWith(service!.origin))!;
      await expect(note.getByLabel('Variant content')).toHaveValue('Edited local reference.\n\nSource: ' + source);
      await expect(note.getByRole('article').filter({ hasText: 'Native reviewed Notes fixture' })).toHaveCount(0);
      await note.getByRole('button', { name: 'Create Snippet', exact: true }).click();
      await expect(note.getByRole('article').filter({ hasText: 'Native reviewed Notes fixture' })).toHaveCount(1);
      await expect.poll(() => shell.evaluate(() => window.privateBrowser.notesPanelCommand('status').then((value) => value?.mode))).toBe('personal');
    } finally { await app.close(); }
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    if (existsSync(profile)) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
