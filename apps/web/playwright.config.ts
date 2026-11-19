import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the full local stack with mock providers:
 *   docker compose up -d && pnpm db:deploy && pnpm db:seed && pnpm dev
 * OTPs (email and mirrored dev SMS) are read from Mailpit.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: process.env.WEB_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
  ],
});
