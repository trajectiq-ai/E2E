import { defineConfig, devices } from '@playwright/test';

/**
 * Fixture config for playwright-e2e-mcp's integration suite (`npm run e2e`).
 * The harness starts a local HTTP app, exports FIXTURE_PORT, and drives the
 * MCP server against this project — do not add `retries > 0` here: the suite
 * asserts the server's own auto-retry-once behaviour.
 */
const port = process.env.FIXTURE_PORT ?? '4173';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  // The flaky fixture coordinates itself through a marker file; serial runs
  // keep the first-run-fails → passes-on-retry story deterministic.
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
