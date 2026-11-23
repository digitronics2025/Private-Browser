import { expect, test, type Page } from '@playwright/test';

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return () => expect(errors, 'console and page errors').toEqual([]);
}

const tabList = (page: Page) => page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab');
const sidePanel = (page: Page) => page.getByRole('complementary', { name: 'Side panel' });

test('finds keyboard commands and keeps the page beside the compact panel on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
  const panel = sidePanel(page);
  const search = panel.getByRole('searchbox', { name: 'Search shortcuts' });
  await expect(search).toBeFocused();
  await search.fill('workspace');
  await expect(panel.getByText('Switch workspace or Account Space', { exact: true })).toBeVisible();
  await expect(panel.getByText('Ctrl+Shift+U', { exact: true })).toBeVisible();
  await expect(panel.getByText('Close tab', { exact: true })).toHaveCount(0);
  const compact = panel.getByRole('button', { name: 'Compact side panel' });
  await compact.click();
  await expect(compact).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await panel.boundingBox())?.width).toBe(230);
  await expect.poll(async () => JSON.parse(await page.locator('html').getAttribute('data-preview-layout') ?? '{}').right).toBe(230);

  await page.keyboard.press('Control+Shift+u');
  const menu = page.getByRole('menu', { name: 'Account Spaces' });
  const banking = menu.getByRole('menuitemradio', { name: 'Switch to Banking' });
  await banking.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(async () => (await window.privateBrowser.getState()).activeWorkspaceId)).toBe('banking');
  await panel.getByRole('button', { name: 'Close side panel' }).click();
  await page.keyboard.press('Control+Shift+k');
  await expect(search).toBeFocused();
});

test('tab strip creates, closes, switches, middle-click closes and searches tabs', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  const tabs = tabList(page);
  await expect(tabs).toHaveCount(5);
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(tabs).toHaveCount(6);
  await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  await tabs.last().getByRole('button', { name: /^Close/ }).click();
  await expect(tabs).toHaveCount(5);
  await tabs.nth(3).click({ button: 'middle' });
  await expect(tabs).toHaveCount(4);
  await page.keyboard.press('Control+2');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Search tabs' }).click();
  const search = page.getByRole('dialog', { name: 'Search tabs' });
  await search.getByRole('textbox', { name: 'Search open tabs' }).fill('team update');
  await expect(search.getByRole('menuitemradio')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(search).toHaveCount(0);
  await expect(page.getByRole('tab', { name: /Team update video/ })).toHaveAttribute('aria-selected', 'true');
  noErrors();
});

test('address bar keeps security warnings visible and Ctrl+L focuses it', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /Legacy intranet dashboard/ }).click();
  await expect(page.locator('.security-chip')).toHaveText('Not secure');
  await page.getByRole('button', { name: /View site information: connection warning/ }).click();
  const info = page.getByRole('dialog', { name: 'Site information' });
  await expect(info.getByText('Connection is not secure')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(info).toHaveCount(0);
  await page.keyboard.press('Control+L');
  await expect(page.getByRole('combobox', { name: 'Address and search bar' })).toBeFocused();

  // A local plain-HTTP page has no chip, but must never be described as encrypted.
  await page.getByRole('tab', { name: /Local dev server/ }).click();
  await expect(page.locator('.security-chip')).toHaveCount(0);
  await page.getByRole('button', { name: 'View site information', exact: true }).click();
  const localInfo = page.getByRole('dialog', { name: 'Site information' });
  await expect(localInfo.getByText('Local development page')).toBeVisible();
  await expect(localInfo.getByText('Connection is secure')).toHaveCount(0);
  noErrors();
});

test('checks a pasted address locally on a narrow screen without opening it', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  const noErrors = watchErrors(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /Local dev server/ }).click();
  await page.getByRole('button', { name: 'View site information', exact: true }).click();
  const info = page.getByRole('dialog', { name: 'Site information' });
  await expect(info.getByText('localhost:4173', { exact: true })).toBeVisible();
  await expect(info.getByText('http://localhost:4173/', { exact: true })).toBeVisible();
  const target = 'https://xn--caf-dma.example.test:8443/stock?q=9';
  let attempted = false;
  await page.route('https://xn--caf-dma.example.test:8443/**', async (route) => { attempted = true; await route.abort(); });
  const summary = info.getByText('Check this address', { exact: true });
  await summary.focus();
  await page.keyboard.press('Enter');
  const input = info.getByRole('textbox', { name: 'Address to check' });
  await input.fill('https://café.example.test:8443/stock?q=9');
  await input.press('Enter');
  const result = info.getByRole('status');
  await expect(result).toContainText(target);
  await expect(result).toContainText('international characters');
  await expect(result).toContainText('non-default port');
  await expect(page.getByRole('tab', { name: /Local dev server/ })).toHaveAttribute('aria-selected', 'true');
  expect(attempted).toBe(false);
  await input.fill('file:///example');
  await input.press('Enter');
  await expect(result).toContainText('Enter an HTTP or HTTPS website address.');
  noErrors();
});

// F-35: a page changing its own URL must not overwrite what the user is typing.
test('a page URL change does not replace an address the user is typing', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  const address = page.getByRole('combobox', { name: 'Address and search bar' });
  await page.getByRole('tab', { name: /Legacy intranet dashboard/ }).click();
  await address.click();
  await address.fill('mybank.example');
  await page.evaluate(() => window.privateBrowser.navigate('https://page-chosen.example/'));
  await expect.poll(async () => (await page.evaluate(() => window.privateBrowser.getState())).tabs.some((tab) => tab.url.startsWith('https://page-chosen.example'))).toBe(true);
  await expect(address).toHaveValue('mybank.example');
  noErrors();
});

test('browser menu is keyboard navigable, closes cleanly and lists only working actions', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Browser menu' });
  await button.click();
  const menu = page.getByRole('menu', { name: 'Browser menu' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /New tab/ })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'New temporary browsing window', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Account Spaces', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const submenu = page.getByRole('menu', { name: 'Account Spaces' });
  await expect(submenu).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(submenu).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Account Spaces', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();

  await button.click();
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  for (const name of ['New window', 'New private window', 'Extensions', 'Tab groups']) {
    await expect(page.getByRole('menuitem', { name, exact: true })).toHaveCount(0);
  }
  await page.mouse.click(300, 600);
  await expect(menu).toHaveCount(0);

  await page.keyboard.press('Alt+F');
  await expect(menu).toBeVisible();
  noErrors();
});

test('profile menu shows the current space and switches workspaces', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  const profile = page.getByRole('button', { name: 'Account Space: Operations' });
  await expect(profile).toHaveAccessibleDescription('Workspace: Personal');
  await expect(profile.getByText('Personal', { exact: true })).toBeVisible();
  await expect(profile.getByText('Operations', { exact: true })).toBeVisible();
  await profile.click();
  const menu = page.getByRole('menu', { name: 'Account Spaces' });
  await expect(menu.getByText('Google connected')).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Switch to Personal' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'Switch to TenTen' }).click();
  await expect(page.getByRole('button', { name: 'Account Space: TenTen' })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'Switch to TenTen' })).toHaveAttribute('aria-checked', 'true');
  noErrors();
});

test('keeps Banking visible at narrow widths and preserves address-bar access', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 810 });
  await page.goto('/');
  const profile = page.getByRole('button', { name: 'Account Space: Operations' });
  await expect(profile.getByText('Operations', { exact: true })).toBeHidden();
  await profile.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitemradio', { name: 'Switch to Banking' }).click();
  const banking = page.getByRole('button', { name: 'Account Space: Banking' });
  await expect(banking).toHaveAccessibleDescription('Workspace: Banking, protected');
  await expect(banking.getByText('Banking', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('combobox', { name: 'Address and search bar' })).toBeVisible();
});

test('bookmarks bar has folders, nested menus, overflow, context actions and Ctrl+Shift+B', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  const bar = page.getByRole('navigation', { name: 'Bookmarks bar' });
  await expect(bar.getByRole('button', { name: 'Google Drive' })).toBeVisible();
  await expect(bar.getByText(/import bookmarks/i)).toHaveCount(0);
  await bar.getByRole('button', { name: 'Finance', exact: true }).click();
  const finance = page.getByRole('menu', { name: 'Finance' });
  await expect(finance.getByRole('menuitem', { name: 'Invoices' })).toBeVisible();
  await finance.getByRole('menuitem', { name: 'Reports' }).hover();
  await expect(page.getByRole('menu', { name: 'Reports' }).getByRole('menuitem', { name: 'Annual reports' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(finance).toHaveCount(0);
  await expect(bar.getByRole('button', { name: /more bookmarks/ })).toBeVisible();

  await bar.getByRole('button', { name: 'Google Drive' }).click({ button: 'right' });
  const context = page.getByRole('menu', { name: 'Google Drive actions' });
  await expect(context.getByRole('menuitem', { name: 'Edit name…' })).toBeVisible();
  await context.getByRole('menuitem', { name: 'Edit name…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit bookmark name' });
  await dialog.getByLabel('Name').fill('Team Drive');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(bar.getByRole('button', { name: 'Team Drive' })).toBeVisible();

  await page.keyboard.press('Control+Shift+B');
  await expect(bar).toHaveCount(0);
  await page.keyboard.press('Control+Shift+B');
  await expect(bar).toBeVisible();
  noErrors();
});

test('previews a folder and opens only selected bookmarks behind the current tab', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 770 });
  await page.goto('/');
  const read = () => page.evaluate(() => window.privateBrowser.getState());
  const account = (await read()).activeAccountSpaceId;
  await page.evaluate(() => window.privateBrowser.navigate('https://billing.example.com/invoices'));
  const focused = (await read()).activeTabId;
  await page.getByRole('button', { name: 'Finance', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Open bookmarks… (3)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open bookmarks in background' });
  await expect(dialog.getByRole('checkbox', { name: /Invoices.*Already open/ })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /Annual reports/ }).uncheck();
  await dialog.getByRole('button', { name: 'Open selected (1)' }).click();
  await expect(dialog).toHaveCount(0);
  const after = await read();
  expect(after.activeTabId).toBe(focused);
  expect(after.tabs.filter((tab) => tab.url === 'https://billing.example.com/invoices')).toHaveLength(1);
  expect(after.tabs.filter((tab) => tab.url === 'https://billing.example.com/payments')).toMatchObject([{ accountSpaceId: account }]);
  expect(after.tabs.some((tab) => tab.url === 'https://reports.example.com/')).toBe(false);
});

test('side panel opens from the toolbar, switches tools, resizes and keeps its choice', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await expect(sidePanel(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = sidePanel(page);
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('tab', { name: 'AI assistant' })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Private by default')).toBeVisible();
  await panel.getByRole('tab', { name: 'Privacy log' }).click();
  await expect(panel.getByRole('heading', { name: 'Privacy log' })).toBeVisible();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(400);
  // Regression: the bookmark measuring row once overflowed the page, so a click could scroll the frame sideways.
  expect(await page.evaluate(() => ({
    rootScrollLeft: document.getElementById('root')!.scrollLeft,
    shellOverflow: document.querySelector('.app-shell')!.scrollWidth - window.innerWidth,
  }))).toEqual({ rootScrollLeft: 0, shellOverflow: 0 });

  const handle = panel.getByRole('separator', { name: 'Resize side panel' });
  const grip = (await handle.boundingBox())!;
  const pointer = { x: Math.round(grip.x + grip.width / 2), y: Math.round(grip.y + 200) };
  // Diagnose rather than guess if this ever fails: which element is under the pointer?
  const underPointer = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element ? `${element.tagName.toLowerCase()}.${String(element.className)}` : 'nothing';
  }, pointer);
  expect(underPointer, `element under the resize grip at ${pointer.x},${pointer.y}`).toContain('side-panel-resize');
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  await expect(panel, 'pressing the grip starts a resize').toHaveClass(/resizing/);
  await page.mouse.move(pointer.x - 40, pointer.y, { steps: 10 });
  await page.mouse.move(pointer.x - 84, pointer.y, { steps: 10 });
  await page.mouse.up();
  await expect(panel).not.toHaveClass(/resizing/);
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(484);
  await handle.focus();
  await page.keyboard.press('End');
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(320);

  await panel.getByRole('button', { name: 'Close side panel' }).click();
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await expect(panel.getByRole('tab', { name: 'Privacy log' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(320);
  noErrors();
});

test('reported page insets match the visible chrome in every combination', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  const aligned = async () => {
    const reported = JSON.parse(await page.locator('html').getAttribute('data-preview-layout') ?? '{}');
    const visible = await page.evaluate(() => ({
      bottom: Math.round(Math.max(...['.tab-strip', '.toolbar', '.bookmark-bar', '.find-bar'].map((selector) => document.querySelector(selector)?.getBoundingClientRect().bottom ?? 0))),
      right: Math.round(document.querySelector('.side-panel-shell')?.getBoundingClientRect().width ?? 0),
    }));
    return reported.top === visible.bottom && reported.right === visible.right && reported.left === 0 && reported.bottom === 0;
  };
  await expect.poll(aligned).toBe(true);
  await page.getByRole('tab', { name: /Quarterly operations review/ }).click();
  await expect.poll(aligned).toBe(true);
  await page.keyboard.press('Control+F');
  await expect(page.getByRole('search', { name: 'Find in page' })).toBeVisible();
  await expect.poll(aligned).toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+B');
  await expect.poll(aligned).toBe(true);
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  await expect.poll(aligned).toBe(true);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(aligned).toBe(true);
});

test('switches between dark and light themes', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Appearance' }).click();
  await page.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => page.locator('.toolbar').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(255, 255, 255)');
  noErrors();
});

test('New Tab page searches, adds a shortcut and keeps privacy detail behind the shield', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  const ntp = page.getByRole('main', { name: 'New Tab' });
  await expect(ntp.getByRole('heading', { name: 'Private Browser' })).toBeVisible();
  await expect(ntp.getByRole('button', { name: 'Gmail', exact: true })).toBeVisible();
  await expect(page.getByText('Local protection active')).toHaveCount(0);
  await ntp.getByRole('button', { name: 'Add shortcut' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add shortcut' });
  await dialog.getByLabel('Name').fill('Status page');
  await dialog.getByLabel('URL').fill('status.example.com');
  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(ntp.getByRole('button', { name: 'Status page', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Private Browser protection status' }).click();
  const shield = page.getByRole('dialog', { name: 'Protection status' });
  await expect(shield.getByText('Tracker blocking is on')).toBeVisible();
  await expect(shield.getByText('Local protection active')).toBeVisible();
  noErrors();
});

test('pins the current page, reorders a shortcut and hides recent visits on New Tab', async ({ page }) => {
  await page.setViewportSize({ width: 520, height: 760 });
  await page.goto('/');
  await page.evaluate(() => window.privateBrowser.navigate('https://status.example.test/service'));
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menuitem', { name: 'Bookmarks', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Pin current page to New Tab' }).click();
  const pinDialog = page.getByRole('dialog', { name: 'Pin current page to New Tab' });
  await expect(pinDialog.getByLabel('URL')).toHaveValue('https://status.example.test/service');
  await pinDialog.getByLabel('Name').fill('Service status');
  await pinDialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(pinDialog).toHaveCount(0);
  await page.evaluate(() => window.privateBrowser.newTab());

  const ntp = page.getByRole('main', { name: 'New Tab' });
  const shortcutMenu = ntp.getByRole('button', { name: 'Edit shortcut Gmail' });
  await expect(ntp.getByRole('button', { name: 'Service status', exact: true })).toBeVisible();
  await shortcutMenu.press('Enter');
  await page.getByRole('menuitem', { name: 'Move later' }).press('Enter');
  const shortcuts = ntp.getByRole('region', { name: 'Shortcuts' }).getByRole('button', { name: /Edit shortcut/ });
  await expect(shortcuts.nth(1)).toHaveAccessibleName('Edit shortcut Gmail');

  await expect(ntp.getByRole('heading', { name: 'Recently visited' })).toBeVisible();
  await ntp.getByRole('button', { name: 'Customize' }).click();
  const show = page.getByRole('menuitemcheckbox', { name: 'Show recently visited pages' });
  await expect(show).toHaveAttribute('aria-checked', 'true');
  await show.click();
  await expect(show).toHaveAttribute('aria-checked', 'false');
  await expect(ntp.getByRole('heading', { name: 'Recently visited' })).toHaveCount(0);
  await expect(ntp.getByRole('heading', { name: 'Bookmarks' })).toBeVisible();
});

// Ctrl+T and Ctrl+W are reserved by desktop Chrome itself, so they are exercised
// in the real Electron window (tests/electron/chrome-layout.spec.ts) instead.
test('chrome keyboard shortcuts open tools and menus', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  // Shortcuts act on the browser state, so wait until the first snapshot has rendered.
  await expect(tabList(page).first()).toBeVisible();
  await page.keyboard.press('Control+Shift+O');
  await expect(sidePanel(page).getByRole('heading', { name: 'Bookmarks' })).toBeVisible();
  await page.keyboard.press('Control+H');
  await expect(sidePanel(page).getByRole('heading', { name: 'History' })).toBeVisible();
  await page.keyboard.press('Control+Shift+A');
  await expect(page.getByRole('dialog', { name: 'Search tabs' })).toBeVisible();
  noErrors();
});

async function openSettingsPanel(page: Page) {
  await page.getByRole('button', { name: 'Browser menu' }).click();
  await page.getByRole('menu', { name: 'Browser menu' }).getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(sidePanel(page).getByText('Search engine', { exact: true })).toBeVisible();
}

test('search engine setting changes what the address bar and New Tab page search', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  const ntp = page.getByRole('main', { name: 'New Tab' });
  await expect(ntp.getByRole('textbox', { name: 'Search DuckDuckGo or enter address' })).toBeVisible();
  await openSettingsPanel(page);
  await sidePanel(page).getByLabel('Search engine').selectOption('bing');
  await expect(ntp.getByRole('textbox', { name: 'Search Bing or enter address' })).toBeVisible();
  const address = page.getByRole('combobox', { name: 'Address and search bar' });
  await expect(address).toHaveAttribute('placeholder', 'Search Bing or enter address');
  await address.fill('weather');
  await address.press('Enter');
  await expect(address).toHaveValue('https://www.bing.com/search?q=weather');

  await sidePanel(page).getByLabel('Search engine').selectOption('custom');
  const custom = sidePanel(page).getByRole('textbox', { name: 'Custom search address' });
  await custom.fill('http://search.example.com/?q=%s');
  await sidePanel(page).getByRole('button', { name: 'Save search address' }).click();
  await expect(page.getByRole('status')).toContainText('https://');
  await expect(custom).toHaveValue('http://search.example.com/?q=%s');
  await custom.fill('https://search.example.com/find?q=%s');
  await sidePanel(page).getByRole('button', { name: 'Save search address' }).click();
  await expect(page.getByRole('status')).toContainText('Search engine saved');
  await address.fill('tv stands');
  await address.press('Enter');
  await expect(address).toHaveValue('https://search.example.com/find?q=tv%20stands');
  await expect(address).toHaveAttribute('placeholder', 'Search the web or enter address');
  noErrors();
});

test('full Settings search finds a control and jumps to its section', async ({ page }) => {
  await page.goto('/');
  await openSettingsPanel(page);
  await sidePanel(page).getByRole('button', { name: 'Open full settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Private Browser settings' });
  await expect(settings).toBeVisible();
  const search = settings.getByRole('searchbox', { name: 'Search settings' });
  await search.fill('theme');
  const result = settings.getByRole('button', { name: 'Theme and appearance' });
  await expect(result).toBeVisible();
  await result.click();
  await expect(settings.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
});

test('home page setting decides where Home goes and refuses text that is not an address', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/');
  const address = page.getByRole('combobox', { name: 'Address and search bar' });
  await openSettingsPanel(page);
  const home = sidePanel(page).getByRole('radiogroup', { name: 'Home page' });
  await expect(home.getByRole('radio', { name: 'New Tab page' })).toHaveAttribute('aria-checked', 'true');
  await home.getByRole('radio', { name: 'Web address' }).click();
  const field = sidePanel(page).getByRole('textbox', { name: 'Home page address' });
  await field.fill('just some words');
  await sidePanel(page).getByRole('button', { name: 'Save Home page' }).click();
  await expect(page.getByRole('status')).toContainText('Enter a web address');
  await field.fill('tenten.ma');
  await sidePanel(page).getByRole('button', { name: 'Save Home page' }).click();
  await expect(page.getByRole('status')).toContainText('Home page saved');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(address).toHaveValue('https://tenten.ma/');
  await sidePanel(page).getByRole('button', { name: 'Use current page' }).click();
  await expect(page.getByRole('status')).toContainText('Home page saved');

  await home.getByRole('radio', { name: 'New Tab page' }).click();
  await expect(field).toHaveCount(0);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('main', { name: 'New Tab' })).toBeVisible();

  const startup = sidePanel(page);
  const alsoOpenHome = startup.getByLabel('Also open Home after the startup decision');
  await alsoOpenHome.check();
  await expect(alsoOpenHome).toBeChecked();
  noErrors();
});

// F-64 / F-70: a site's permission prompt cannot be clicked through as it
// appears, keeps focus inside it, and Escape denies.
test('permission prompt arms its Allow buttons late, traps focus and denies on Escape', async ({ page }) => {
  const noErrors = watchErrors(page);
  await page.goto('/?permission=prompt');
  const dialog = page.getByRole('alertdialog', { name: /Allow notifications/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Always here' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Deny' })).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Always here' })).toBeEnabled();
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.dataset.previewPermission)).toBe('deny');
  noErrors();
});
