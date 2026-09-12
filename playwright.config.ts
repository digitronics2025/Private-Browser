import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 60_000,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'blob' : 'html',
  use: { baseURL: 'http://127.0.0.1:5173', trace: 'on-first-retry', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev:preview', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
