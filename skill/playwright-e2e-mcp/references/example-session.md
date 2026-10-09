# Example session: fixing a failing checkout test

**User:** The checkout test started failing after the redesign. Can you fix it?

1. Agent calls `run-test` with `{ "testFiles": ["tests/checkout.spec.ts"] }`.

   ```
   ## Playwright run — ❌ FAILED
   | passed | failed | flaky | skipped |
   | 2 | 1 | 0 | 0 |
   ### 1 of 1. checkout.spec.ts › pays with card
   File: checkout.spec.ts:18 | failed · timeout
   ```

2. Agent calls `get-failure` with `{ "index": 1 }`. The failed action is
   `locator('#pay-now').click()`, and the DOM snapshot at failure shows a
   `<button data-testid="checkout-submit">Pay now</button>` and no `#pay-now`.
   No network requests failed.

3. The failure kind is `timeout`, but the cause is a selector that no longer
   matches, so the agent follows the selector loop. It calls `inspect-page` with
   `{ "url": "http://localhost:3000/checkout", "selector": "form button" }` and
   confirms the button's attributes.

4. Agent calls `validate-selector` with
   `{ "url": "http://localhost:3000/checkout", "selector": "[data-testid=\"checkout-submit\"]" }`
   and gets `✅ VALID — 1 match`.

5. Agent edits `tests/checkout.spec.ts:18` to
   `await page.getByTestId('checkout-submit').click();`.

6. Agent calls `run-test` with `{ "lastFailed": true }` and gets `✅ PASSED`.

**Agent's reply:**

> All 3 checkout tests pass now. The "pays with card" test failed because the
> redesign renamed the pay button: `#pay-now` became
> `data-testid="checkout-submit"`. I updated the locator at
> `tests/checkout.spec.ts:18` to `getByTestId('checkout-submit')`, checked it
> matches exactly one element on the live page, and re-ran the test.
