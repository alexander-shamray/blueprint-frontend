import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // No retries. A flaky smoke against a real stack is a fact about the stack,
  // and hiding it behind a retry is how a broken platform passes CI.
  retries: 0,
  // One worker, so the three projects below run one after another. The smoke
  // places an order and publishes products on a real stack that has no delete
  // endpoint, and three projects in parallel would share one `demo` user's
  // session state.
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  // Every spec runs in every project; nothing is narrowed per project, because
  // a path that only one project walks is a path the others silently stop
  // covering. Chromium at desktop width is what the suite always was; WebKit is
  // the engine of the iOS WebView; the phone is a Chromium descriptor, which is
  // the Android WebView's engine, at a phone's viewport and touch input.
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run start',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
