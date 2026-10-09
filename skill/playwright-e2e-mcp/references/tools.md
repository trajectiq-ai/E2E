# Tool reference

All paths are relative to the project root. Every tool accepts an optional
`projectRoot`, which must sit inside the server's allowed roots.

## run-test

Runs Playwright and returns stats, failures, failure kinds and fix hints.

| Argument | Type | Notes |
| --- | --- | --- |
| `testFiles` | string[] | Files or directories; `file:line` supported. Omit to run everything |
| `grep` | string | Only tests whose title matches this regex |
| `browser` | `chromium` \| `firefox` \| `webkit` | Matched against config project names |
| `headed` | boolean | Visible browser window |
| `timeoutMs` | number | Wall-clock limit for the run (default 120000); partial results are returned past it |
| `testTimeoutMs` | number | Per-test timeout |
| `workers`, `retries` | number | Passed to Playwright |
| `config` | string | Config path, or 1-based index when there are several |
| `retryOnFailure` | boolean | Retry failures once before reporting (default true; ignored when `retries` is set) |
| `lastFailed` | boolean | Re-run only the tests that failed last time |
| `args` | string[] | Allowlisted Playwright flags such as `--repeat-each=N`, `--max-failures=N`, `--update-snapshots`, `--shard=1/3`, `--trace=on`; path-taking flags are rejected |

Traces are captured on failure automatically so `get-failure` can show the DOM.

## get-failure

| Argument | Type | Notes |
| --- | --- | --- |
| `index` | number | 1-based failure index from the last run (default 1) |

Returns the message and code frame, expected vs actual, stack, failure kind and
diagnosis, console output, the DOM snapshot at failure with the failed action and
its selector, failed network requests, console errors and warnings, and next steps.

## inspect-page

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string | Required, full http(s) URL |
| `selector` | string | Inspect only matches of this CSS selector |
| `waitFor` | string | Wait for a selector (CSS or `text=...`) first |
| `waitUntil` | `load` \| `domcontentloaded` \| `networkidle` | Navigation wait |
| `includeHtml` | boolean | Include rendered HTML (capped by `maxHtmlChars`, default 20000) |
| `timeoutMs` | number | Default 45000 |
| `view` | `elements` \| `locators` | `locators`: compact map of interactive elements with verified locators |
| `storageState` | string | Playwright storageState JSON inside the project (signed-in session) |
| `headers` | object | Extra HTTP headers |
| `actions` | array | Up to 20 steps after load: `{ type: click\|fill\|press\|check\|select\|hover\|wait\|goto…, locator?, value?, url?, ms? }` |
| `viewport` | object | `{ width, height }` |

Returns each element's Playwright locators proven unique on the page (role +
name first), unique CSS selector, tag, visibility, box, text and attributes,
plus console messages. `validate-selector` and `compare-visual-state` take the
same `storageState`, `headers`, `actions` and `viewport`.

## validate-selector

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string | Required |
| `selector` | string | Required: CSS, a Playwright selector, or a locator such as `getByRole('button', { name: 'Save' })` |
| `timeoutMs` | number | Default 45000 |

Verdicts: `✅ VALID — N matches` with samples and a unique locator for each,
a strict-mode warning when more than one matches, `✅ VALID — 0 matches` with
advice, or `❌ INVALID` with the parse error.

## list-tests

| Argument | Type | Notes |
| --- | --- | --- |
| `config` | string | Config path or index |
| `testDir` | string | Restrict to a directory |
| `filter` | string | Case-insensitive substring of `file › title` |
| `limit` | number | Default 500 |

Falls back to a source scan when Playwright cannot list (broken install or spec).

## generate-e2e-test

| Argument | Type | Notes |
| --- | --- | --- |
| `description` | string | Required: what the test should cover |
| `pageUrl` | string | Start page (default: `baseURL` / `webServer.url`) |
| `testDir`, `file` | string | Where to write; `file` must end in `.spec.*` or `.test.*` |
| `write` | boolean | Write to disk (default true) |
| `overwrite` | boolean | Replace a spec this tool generated earlier |
| `liveInspect` | boolean | Cross-check selectors on the live page |
| `config` | string | As above |

## compare-visual-state

| Argument | Type | Notes |
| --- | --- | --- |
| `url` | string | Required |
| `name` | string | Baseline id, e.g. `checkout-page` |
| `action` | `compare` \| `baseline` | Default `compare`; `baseline` re-captures the reference |
| `selector` | string | Capture one element |
| `fullPage` | boolean | Full scrollable page |
| `tolerance` | number | Percent of pixels allowed to differ (default 0.1) |
| `pixelThreshold` | number | Per-pixel channel delta (default 60) |
| `waitUntil`, `waitFor`, `timeoutMs` | | As `inspect-page` |

Baselines live in `.pw-mcp/visual/`.

## diagnose-flaky

| Argument | Type | Notes |
| --- | --- | --- |
| `testFiles` | string[] | Default: tests that failed in the last run |
| `runs` | number | 2 to 10 (default 3) |
| `browser`, `headed`, `workers`, `config` | | As `run-test` |
| `timeoutMs` | number | Per run (default 120000) |

Runs with retries disabled and returns `CONSISTENTLY FAILING`, `FLAKY` or
`NOT REPRODUCING`, a per-run table and the number of distinct error signatures.

## suggest-fix

| Argument | Type | Notes |
| --- | --- | --- |
| `index` | number | 1-based failure index from the last run (default 1) |
| `apply` | boolean | Write the fix (default false: diff only) |
| `verify` | boolean | After applying, re-run and revert if still failing (default true) |
| `allowExpectationUpdate` | boolean | Allow applying a changed expected text (default false) |
| `url`, `storageState`, `headers` | | Heal against a live page instead of the trace snapshot |
| `config`, `timeoutMs` | | As `run-test` |

Returns a unified diff with confidence `high` or `medium`, or refuses and says the
element is most likely missing.

## get-run-status

| Argument | Type | Notes |
| --- | --- | --- |
| `runId` | string | From `run-test` with `background: true` (default: latest) |
| `waitSeconds` | number | Wait up to this long (max 55) |
| `cancel` | boolean | Stop the run |

## analyze-history

| Argument | Type | Notes |
| --- | --- | --- |
| `view` | `flaky` \| `patterns` \| `test` | Default `flaky` |
| `test` | string | Substring of a test's file or title |
| `lastRuns` | number | Default 30 |
| `limit` | number | Default 15 |

Reads `.playwright-e2e-mcp/history.jsonl`, written by every run
(`PW_MCP_HISTORY=0` disables it).
