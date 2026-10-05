import { expect, test } from '@playwright/test';

/**
 * The broken path: the page logs a console error and fetches a URL that 404s,
 * then looks for an element that does not exist. The harness asserts that
 * get-failure surfaces all three facts (console message, failed 404 request,
 * missing save-btn) from the retained trace.
 */
test('checkout save button surfaces cart errors', async ({ page }) => {
  await page.goto('/');

  await page.evaluate(() => {
    console.error('fixture-console-error: cart service unreachable');
    void fetch('/missing.json').catch(() => undefined);
  });

  // Deliberately missing test id — this test must always fail.
  await expect(page.getByTestId('save-btn')).toBeVisible();
});
