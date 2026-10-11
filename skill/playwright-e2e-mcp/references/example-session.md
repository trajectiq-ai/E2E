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
   `locator('#pay-now').click()`. The DOM snapshot at failure has no `#pay-now`,
   but it does have a `Pay now` button. No network requests failed and the console
   is clean, so the app itself looks healthy.

3. The failure kind is `timeout`, but the cause is a locator that no longer
   matches, so the agent calls `suggest-fix` with `{ "index": 1 }`:

   ```
   ### Proposed locator fix — confidence **high**
   The button's accessible name matches "pay", and
   `getByRole('button', { name: 'Pay now' })` is proven to resolve to exactly
   that element.
   -  await page.locator('#pay-now').click();
   +  await page.getByRole('button', { name: 'Pay now' }).click();
   ```

4. Confidence is high, so the agent calls `suggest-fix` with
   `{ "index": 1, "apply": true }`. The server writes the change, re-runs the test
   with retries off, and reports `✅ Verified — the test passes with the fix`.
   Had the test still failed, the server would have restored the original file.

5. Agent calls `run-test` with `{ "lastFailed": true }` to confirm, then
   `{ "testFiles": ["tests/checkout.spec.ts"] }` for the whole file: 3 passed.

**Agent's reply:**

> All 3 checkout tests pass now. "pays with card" failed because the redesign
> removed the `#pay-now` id from the pay button. I changed the locator at
> `tests/checkout.spec.ts:18` to `getByRole('button', { name: 'Pay now' })`,
> which matches exactly one element, and the server re-ran the test to confirm
> the fix.

## When suggest-fix refuses

If `suggest-fix` says the element is most likely missing, do not weaken the test.
Read `get-failure` again for failed network requests and console errors, check the
page with `inspect-page` (with `storageState` if it needs a login), and report it
to the user as a probable app bug with that evidence.
