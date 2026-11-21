import { expect, test } from '@playwright/test';

test('finds exact passages in the local preview without a model, then clears them when changing spaces', async ({ page }) => {
  await page.goto('/?localAi=sample');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Read page locally' }).click();
  const keywords = panel.getByLabel('Page keywords');
  await keywords.fill('cafe ceramic');
  await keywords.press('Enter');
  await expect(panel.getByRole('listitem')).toHaveText('The café stocks ceramic mugs.');
  await keywords.fill('الشاي');
  await keywords.press('Enter');
  await expect(panel.getByRole('listitem')).toHaveText('الشاي متوفر اليوم.');
  await keywords.fill('coffee');
  await keywords.press('Enter');
  await expect(panel.getByText('No matching passages in this page preview.')).toBeVisible();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('development'));
  await expect(panel.getByRole('button', { name: 'Read page locally' })).toBeVisible();
  await expect(keywords).toHaveCount(0);
});

test('checks installed local models and labels the saved provider without a key field', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 800 });
  await page.goto('/?localAi=sample');
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(panel.getByLabel('Provider type')).toHaveValue('local');
  await expect(panel.getByPlaceholder('API key (encrypted)')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Save local model' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Check installed models' }).click();
  await expect(panel.getByText('Ollama is running with cloud features disabled.')).toBeVisible();
  await panel.getByLabel('Local model').selectOption('preview-small:latest');
  await panel.getByRole('button', { name: 'Save local model' }).click();
  await expect(panel.getByText('Local · Ollama')).toBeVisible();
  await expect(panel.getByText('preview-small:latest', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Test connection' }).click();
  await expect(panel.getByText('The selected model answered the built-in sample.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Read page locally' })).toBeVisible();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('banking'));
  await expect(page.evaluate(() => window.privateBrowser.getLocalAiModels())).rejects.toThrow(/workspace/);
});

test('reviews edited selection, destination and redacted question before approval', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?localAi=sample');
  await page.evaluate(() => window.privateBrowser.configureAiProvider({ mode: 'local', model: 'preview-small:latest' }));
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Read selection locally' }).click();
  await expect(panel.getByLabel('Page text')).toHaveValue('A brass kettle sits on the shelf.');
  await panel.getByLabel('Page text').fill('A brass kettle');
  await panel.getByRole('textbox', { name: 'Question', exact: true }).fill('What is listed? token=fixture-only');
  await panel.getByRole('button', { name: 'Review request' }).click();
  const review = panel.getByRole('region', { name: 'Request review' });
  await expect(review).toContainText('http://127.0.0.1:11434/api/chat');
  await expect(review).toContainText('1 redacted');
  await expect(review).toContainText('Question: What is listed? [REDACTED]');
  await expect(review).not.toContainText('fixture-only');
  await expect(review).not.toContainText('sits on the shelf');
  await panel.getByRole('textbox', { name: 'Question', exact: true }).fill('What item is mentioned?');
  await expect(review).toHaveCount(0);
  await panel.getByRole('button', { name: 'Review request' }).click();
  await expect(review).toContainText('Question: What item is mentioned?');
  await review.getByRole('button', { name: 'Approve and ask once' }).click();
  await expect(panel.getByText('The sample shows a brass kettle on the shelf.')).toBeVisible();
  await expect(review).toHaveCount(0);
});

test('uses all four presets, saves edits in the current space and copies an answer on demand', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async (text: string) => { document.documentElement.dataset.copiedAnswer = text; },
    } });
  });
  await page.goto('/?localAi=sample');
  await page.evaluate(() => window.privateBrowser.configureAiProvider({ mode: 'local', model: 'preview-small:latest' }));
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Read selection locally' }).click();
  const selector = panel.getByRole('combobox', { name: 'Prompt preset', exact: true });
  const question = panel.getByRole('textbox', { name: 'Question', exact: true });
  for (const [option, word] of [['Short Darija reply', 'Darija'], ['French rewrite', 'French'], ['Product specifications', 'specifications'], ['Product comparison', 'Compare']] as const) {
    await selector.selectOption({ label: option });
    await expect(question).toHaveValue(new RegExp(word));
  }
  await question.fill('Compare only the materials mentioned.');
  await panel.getByRole('button', { name: 'Save preset' }).click();
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then((state) => state.settings.assistantPrompts?.comparison))).toBe('Compare only the materials mentioned.');
  await selector.selectOption({ label: 'French rewrite' });
  await selector.selectOption({ label: 'Product comparison' });
  await expect(question).toHaveValue('Compare only the materials mentioned.');
  await panel.getByRole('button', { name: 'Review request' }).click();
  await panel.getByRole('button', { name: 'Approve and ask once' }).click();
  const copy = panel.getByRole('button', { name: 'Copy answer' });
  await expect(copy).toBeVisible();
  await expect(panel.getByRole('blockquote', { name: 'Source passage' })).toHaveText('A brass kettle sits on the shelf.');
  await expect(page.locator('html')).not.toHaveAttribute('data-copied-answer', /./);
  await copy.click();
  await expect(page.locator('html')).toHaveAttribute('data-copied-answer', 'The sample shows a brass kettle on the shelf.');
  await page.evaluate(() => window.privateBrowser.switchWorkspace('tenten'));
  await expect.poll(() => page.evaluate(() => window.privateBrowser.getState().then((state) => state.settings.assistantPrompts))).toBeUndefined();
});

test('reports insufficient information when the reply quotes text outside the approved selection', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?localAi=sample&aiSources=unverified');
  await page.evaluate(() => window.privateBrowser.configureAiProvider({ mode: 'local', model: 'preview-small:latest' }));
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Read selection locally' }).click();
  await panel.getByRole('combobox', { name: 'Prompt preset' }).selectOption('specs');
  await expect(panel.getByRole('checkbox', { name: 'Include source passages' })).toBeChecked();
  await panel.getByRole('button', { name: 'Review request' }).click();
  await panel.getByRole('button', { name: 'Approve and ask once' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'Insufficient page information' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Copy answer' })).toHaveCount(0);
});

test('requires another review and approval after a timeout', async ({ page }) => {
  await page.goto('/?localAi=sample&aiRequest=timeout-once');
  await page.evaluate(() => window.privateBrowser.configureAiProvider({ mode: 'local', model: 'preview-small:latest' }));
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Read selection locally' }).click();
  await expect(panel.getByText(/of 12,000 page characters/)).toBeVisible();
  await expect(panel.getByText(/of 2,000 question characters/)).toBeVisible();
  await panel.getByRole('button', { name: 'Review request' }).click();
  await panel.getByRole('button', { name: 'Approve and ask once' }).click();
  await expect(panel.getByText(/The provider timed out/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Approve and ask once' })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Review retry' }).click();
  await panel.getByRole('button', { name: 'Approve and ask once' }).click();
  await expect(panel.getByText('The sample shows a brass kettle on the shelf.')).toBeVisible();
});

test('estimates cloud price locally and cancels a pending request on demand', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?localAi=sample&aiRequest=waiting');
  await page.evaluate(() => window.privateBrowser.configureAiProvider({ endpoint: 'https://ai-fixture.example.com/v1', model: 'fixture', apiKey: '' }));
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Read selection locally' }).click();
  await panel.getByRole('button', { name: 'Review request' }).click();
  await panel.getByText('Estimate cost locally', { exact: true }).click();
  await panel.getByRole('spinbutton', { name: 'Input price per million' }).fill('2');
  await panel.getByRole('spinbutton', { name: 'Output price per million' }).fill('5');
  await expect(panel.getByText(/Estimated cost: \$0\.00/)).toBeVisible();
  await panel.getByRole('button', { name: 'Approve and ask once' }).click();
  await expect(panel.getByText('Waiting for the cloud provider…')).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel request' }).click();
  await expect(panel.getByText('Request cancelled.')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Approve and ask once' })).toHaveCount(0);
});

test('shows cloud settings and receipts for only the current Account Space', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?localAi=sample');
  await page.evaluate(() => window.privateBrowser.configureAiProvider({ endpoint: 'https://ai-fixture.example.com/v1', model: 'fixture', apiKey: '' }));
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  const allowCloud = panel.getByRole('checkbox', { name: 'Allow cloud AI in this Account Space' });
  await expect(allowCloud).toBeChecked();
  await panel.getByRole('button', { name: 'Test connection' }).click();
  await panel.getByText('Recent Assistant requests', { exact: true }).click();
  const receipts = panel.locator('details').filter({ hasText: 'Recent Assistant requests' });
  await expect(receipts).toContainText('https://ai-fixture.example.com');
  await expect(receipts).not.toContainText('/v1');
  await allowCloud.uncheck();
  await expect(panel.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Read selection locally' }).click();
  await expect(panel.getByRole('button', { name: 'Cloud AI is disabled here' })).toBeDisabled();
  await page.evaluate(() => window.privateBrowser.switchWorkspace('tenten'));
  await expect(allowCloud).toBeChecked();
  await panel.getByText('Recent Assistant requests', { exact: true }).click();
  await expect(receipts).toContainText('No requests recorded in this Account Space.');
});

test('reviews several selected sources and lets the user remove each excerpt before sending', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 820 });
  await page.goto('/?localAi=sample');
  await page.evaluate(async () => {
    const api = window.privateBrowser;
    await api.configureAiProvider({ mode: 'local', model: 'preview-small:latest' });
    await api.newTab();
    await api.navigate('https://reference.example.test/product?internal=fixture');
    await api.newTab();
    await api.navigate('https://example.test/article');
  });
  await page.getByRole('button', { name: 'Side panel', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Side panel' });
  await panel.getByRole('button', { name: 'Read selection locally' }).click();
  await panel.getByText('Add a source from another tab', { exact: true }).click();
  await panel.getByRole('combobox', { name: 'Source tab' }).selectOption({ label: 'reference.example.test' });
  await panel.getByRole('button', { name: 'Add selected text' }).click();
  await expect(panel.getByRole('textbox', { name: 'Excerpt from reference.example.test' })).toHaveValue('The additional catalogue lists a ceramic mug.');
  await panel.getByRole('button', { name: 'Review request' }).click();
  const review = panel.getByRole('region', { name: 'Request review' });
  await expect(review).toContainText('The additional catalogue lists a ceramic mug.');
  await expect(review).toContainText('https://reference.example.test');
  await expect(review).not.toContainText('internal=fixture');
  await panel.getByRole('button', { name: 'Remove current excerpt' }).click();
  await expect(review).toHaveCount(0);
  await panel.getByRole('button', { name: 'Review request' }).click();
  await expect(review).not.toContainText('A brass kettle sits on the shelf.');
  await expect(review).toContainText('The additional catalogue lists a ceramic mug.');
  await panel.getByRole('button', { name: 'Restore current excerpt' }).click();
  await panel.getByRole('button', { name: 'Remove source reference.example.test' }).click();
  await panel.getByRole('button', { name: 'Review request' }).click();
  await expect(review).toContainText('A brass kettle sits on the shelf.');
  await expect(review).not.toContainText('reference.example.test');
});
