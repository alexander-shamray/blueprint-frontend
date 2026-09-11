import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // No retries. A flaky smoke against a real stack is a fact about the stack,
  // and hiding it behind a retry is how a broken platform passes CI.
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
