import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/packaged',
  timeout: 90_000,
  expect: { timeout: 8_000 },
  retries: 0,
  workers: 1,
  reporter: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ? [['list', { printSteps: true }], ['json']] : [['list', { printSteps: true }]],
});
