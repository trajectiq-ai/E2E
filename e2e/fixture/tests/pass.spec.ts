import { expect, test } from '@playwright/test';

/**
 * The healthy path: the fixture app renders and the CTA button reacts.
 * The harness asserts "✅ PASSED" with stats | 1 | 0 | 0 | 0 |.
 */
test('CTA button is visible and toggles color on click', async ({ page }) => {
  await page.goto('/');

  const cta = page.getByTestId('cta-button');
  await expect(cta).toBeVisible();
  await expect(cta).toHaveText('Buy now');

  const before = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);
  await cta.click();
  const after = await cta.evaluate((el) => getComputedStyle(el).backgroundColor);

  expect(after).not.toBe(before);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Freebuff Demo Shop');
});
