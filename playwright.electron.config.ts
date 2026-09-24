import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/electron',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // A retry still records a trace, but a test that only passes on retry fails
  // the run: CI gates the installer, and a flake is usually a real race (F-54).
  failOnFlakyTests: !!process.env.CI,
  reporter: process.env.CI ? 'blob' : 'list',
  use: { trace: 'on-first-retry', screenshot: 'only-on-failure' },
});
