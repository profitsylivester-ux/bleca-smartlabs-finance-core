import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright (E2E).
 *
 * Runs against a real dev server and a real database, because the flows worth
 * testing here are exactly the ones a mock would invalidate: cookie handling,
 * redirects, MFA gating, and the fact that a denied request is actually refused
 * by the server rather than hidden by the interface.
 */
export default defineConfig({
  testDir: './e2e/specs',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /**
   * A dedicated dev server on its own port, so E2E never fights the developer
   * for port 3000 and never rebuilds .next in a state the developer is using.
   */
  webServer: {
    command: 'npm run dev -- --port 3100',
    url: 'http://localhost:3100/login',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { NODE_ENV: 'development' },
  },
});
