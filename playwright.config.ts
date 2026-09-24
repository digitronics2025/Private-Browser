import { defineConfig, devices } from '@playwright/test';

// A port of its own, never reused: `npm run dev` and other checkouts use 5173,
// and reusing whatever server held it made these tests run against another
// copy of the app. If 5174 is taken, the run fails instead of testing the wrong code.
const E2E_ORIGIN = 'http://127.0.0.1:5174';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  timeout: 60_000,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  // A retry still records a trace, but a test that only passes on retry fails
  // the run: CI gates the installer, and a flake is usually a real race (F-54).
  failOnFlakyTests: !!process.env.CI,
  reporter: process.env.CI ? 'blob' : 'html',
  use: { baseURL: E2E_ORIGIN, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev:preview -- --port 5174 --strictPort', url: E2E_ORIGIN, reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
