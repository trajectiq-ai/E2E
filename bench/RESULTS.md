# Token benchmark: diagnosing one drifted locator

Run 2026-10-09 with playwright-e2e-mcp 0.1.4 and Playwright 1.63.0 (`playwright mcp`). Reproduce with `npm run build && node bench/token-benchmark.mjs`.

Scenario: a storefront page (navigation, search, 24 product cards, cart, footer) renamed its checkout button test id from `checkout-button` to `checkout-btn`; the spec still uses the old one. Tokens are estimated as characters ÷ 4 for both routes.

| Step | playwright-e2e-mcp | Playwright MCP + shell |
| --- | ---: | ---: |
| Tool definitions (sent with every request) | 4,565 | 4,726 |
| Run the failing test | 246 | 325 |
| Find the element / propose the fix | 260 | 2,286 |
| Apply + verify (re-run) | 257 | 34 |
| **Total for one fix** | 5,328 | 7,371 |

Fixed and verified by playwright-e2e-mcp without an edit by the agent: **yes**.

Route B is a lower bound: it assumes the agent reads one snapshot, writes the right locator first time and re-runs once. It also leaves the reasoning (matching `checkout-button` to "Proceed to checkout" among ~150 elements) to the model, which route A does in the server.

## What each route returned for the diagnosis step

<details><summary>playwright-e2e-mcp: suggest-fix</summary>

```markdown
## 🩹 Fix for failure 1 of 1 — checkout.spec.ts › cart proceeds to checkout

**File:** `tests/checkout.spec.ts:3`  |  **Kind:** `timeout`

### Proposed locator fix — confidence **high**

`getByTestId('checkout-button')` no longer matches anything. In the DOM snapshot at failure (Playwright trace), the button "Proceed to checkout" matches "checkout", and `getByRole('button', { name: 'Proceed to checkout' })` is proven to resolve to exactly that element.

```diff
--- a/tests/checkout.spec.ts
+++ b/tests/checkout.spec.ts
@@ -4,5 +4,5 @@
   await page.goto('/');
   await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
-  await page.getByTestId('checkout-button').click({ timeout: 3000 });
+  await page.getByRole('button', { name: 'Proceed to checkout' }).click({ timeout: 3000 });
 });
```

Other candidates: `getByRole('link', { name: 'Northwind Outfitters' })`, `getByRole('link', { name: 'New' })`

> Next: call **suggest-fix** again with `apply: true` to write this change and re-run the test to verify it.
```

</details>

<details><summary>Playwright MCP: browser_snapshot (2,231 tokens, first 40 lines)</summary>

```markdown
### Page
- Page URL: http://127.0.0.1:39363/
- Page Title: Northwind Outfitters
### Snapshot
```yaml
- generic [active] [ref=e1]:
  - banner [ref=e2]:
    - link "Northwind Outfitters" [ref=e3] [cursor=pointer]:
      - /url: /
    - navigation [ref=e4]:
      - link "New" [ref=e5] [cursor=pointer]:
        - /url: /new
      - link "Men" [ref=e6] [cursor=pointer]:
        - /url: /men
      - link "Women" [ref=e7] [cursor=pointer]:
        - /url: /women
      - link "Sale" [ref=e8] [cursor=pointer]:
        - /url: /sale
      - link "Help" [ref=e9] [cursor=pointer]:
        - /url: /help
    - search [ref=e10]:
      - text: Search
      - searchbox "Search" [ref=e11]
      - button "Search" [ref=e12]
    - link "Account" [ref=e13] [cursor=pointer]:
      - /url: /account
  - main [ref=e14]:
    - heading "All products" [level=1] [ref=e15]
    - region "Filters" [ref=e16]:
      - generic [ref=e17]:
        - checkbox "In stock" [ref=e18]
        - text: In stock
      - generic [ref=e19]:
        - checkbox "On sale" [ref=e20]
        - text: On sale
      - combobox "Sort" [ref=e21]:
        - option "Featured" [selected]
        - 'option "Price: low to high"'
        - 'option "Price: high to low"'
    - generic [ref=e22]:
```

</details>
