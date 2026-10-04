import { test, expect } from '@playwright/test';

/**
 * Sample test for playwright-e2e-mcp.
 *
 * Run it through the MCP server (tool: `run-test`) or directly:
 *   npx playwright test examples/sample-test.spec.ts
 *
 * It targets https://example.com — a stable public page — so you can
 * verify the whole installation (browsers, network, reporting) before
 * pointing the tools at your own app.
 */
test.describe('example.com', () => {
  test('loads with the expected title', async ({ page }) => {
    const response = await page.goto('https://example.com/');

    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/Example Domain/);
  });

  test('explains what the domain is for', async ({ page }) => {
    await page.goto('https://example.com/');

    await expect(
      page.getByText(/this domain is for use in documentation examples/i),
    ).toBeVisible();
  });

  test('renders a content paragraph inside the body', async ({ page }) => {
    await page.goto('https://example.com/');

    await expect(page.locator('body')).toBeVisible();
    const paragraph = page.locator('body p').first();
    await expect(paragraph).toBeVisible();
    await expect(paragraph).toHaveText(/.{40,}/);
  });

  test('renders without console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto('https://example.com/');
    await expect(page.locator('body')).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
