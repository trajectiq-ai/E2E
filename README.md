# playwright-e2e-mcp

[![CI](https://github.com/trajectiq-ai/E2E/actions/workflows/ci.yml/badge.svg)](https://github.com/trajectiq-ai/E2E/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/trajectiq-ai/E2E)](https://github.com/trajectiq-ai/E2E/releases)

An [MCP](https://modelcontextprotocol.io) server that lets AI agents **run, debug, and inspect Playwright end-to-end tests** — with structured results, actionable failure diagnostics, and live DOM inspection.

```
run-test ──▶ get-failure ──▶ inspect-page ──▶ validate-selector ──▶ fix ──▶ re-run
   ▲                                                                    │
   └──────────────────────── list-tests ◀────────────────────────────────┘
```

Instead of handing an agent raw Playwright output, this server turns every run into
machinable results: pass/fail stats, per-failure messages with `file:line`, a failure
kind (assertion, timeout, browser crash, syntax error, dead dev server, full disk…),
and a concrete "how to fix" hint. When a test fails because a selector no longer
matches, the agent can open the **live page** in a headless browser, see the real DOM
with unique CSS selectors, and validate the replacement selector before re-running.

---

## Tools

| Tool | Purpose |
| --- | --- |
| `run-test` | Run Playwright tests and return stats, failures, diagnostics and hints |
| `get-failure` | Deep analysis of one failure: stack, expected/actual, **DOM snapshot at failure (from the Playwright trace)**, next steps |
| `inspect-page` | Open a URL headlessly and return the rendered DOM: selectors, visibility, boxes, text, console output, HTML |
| `list-tests` | List available tests (`file`, `line`, full title, projects) with filtering |
| `validate-selector` | Check a CSS selector against a live page: validity, match count, sample matches |
| `generate-e2e-test` | Scaffold a Playwright test from a description using the project's **real** selectors, discovered from recent file changes |
| `compare-visual-state` | Visual regression: screenshot before/after a change and report *what* moved and how colors shifted |
| `diagnose-flaky` | Run a failing test 2–10 times **with retries disabled** and return an evidence verdict: `CONSISTENTLY FAILING`, `FLAKY` or `NOT REPRODUCING` |

### `run-test`

| Argument | Type | Description |
| --- | --- | --- |
| `projectRoot` | string | Project directory (default: server working directory) |
| `testFiles` | string[] | Files/directories relative to the root; `file:line` supported. Omit to run everything |
| `grep` | string | Only run tests whose title matches this regex |
| `browser` | `chromium` \| `firefox` \| `webkit` | Playwright project to run (matched against config project names) |
| `headed` | boolean | Visible browser window |
| `timeoutMs` | number | Hard wall-clock limit for the run (default `120000`); the whole process tree is killed past it and **partial results are returned** |
| `testTimeoutMs` | number | Per-test timeout passed to Playwright |
| `workers` / `retries` | number | Passed through to Playwright |
| `config` | string | `playwright.config` path **or 1-based index** when the project has several |
| `retryOnFailure` | boolean | Auto-retry failures **once** before reporting them (default `true`; ignored when `retries` is set) |
| `lastFailed` | boolean | Only re-run tests that failed in the previous run (Playwright `--last-failed`) — the fast fix → re-run loop |
| `args` | string[] | Extra CLI flags (shell metacharacters are rejected) |

Flakiness handling: by default the server injects `--retries=1` (unless the config
already sets `retries`), so a test that passes on the retry is reported as **flaky**,
not failed. Traces are captured automatically (`--trace=retain-on-failure`) so
`get-failure` can show the DOM at the moment of failure.

Example result:

```markdown
## Playwright run — ❌ FAILED

**Command:** `playwright test --config playwright.config.ts tests/checkout.spec.ts --reporter=json`
**duration 4.2s · exit 1 · config `playwright.config.ts`**

| passed | failed | flaky | skipped | duration |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 0 | 0 | 1.1s |

### ❌ 1 failing test(s)

### 1 of 1. checkout.spec.ts › pays with card
**File:** `checkout.spec.ts:5`  |  **failed · server-unreachable**

### ⚠️ SERVER_NOT_RUNNING
Your app (dev server) does not appear to be reachable. Start it in another terminal
(e.g. npm run dev / npm start), keep it running, then retry — or configure `webServer`
in playwright.config.* so Playwright starts it automatically.
```

### `get-failure`

| Argument | Type | Description |
| --- | --- | --- |
| `index` | number | 1-based failure index from the last run (default `1`) |
| `projectRoot` | string | Only used when re-reading the stored report |

Returns the message/code frame, expected vs actual, stack, failure kind with a
diagnosis, the test's console output, **the DOM snapshot from the Playwright trace
(plus the failed action, its selector, and the action log leading up to it)**,
**the network requests that failed** (4xx/5xx, dead endpoints, no-response — with
method, URL, status and resource type), **the console errors/warnings the page
logged before the failure**, and
numbered next steps (re-run this single test by `file:line`, headed/debug mode,
`validate-selector` when the message mentions a locator, …).

### `inspect-page`

| Argument | Type | Description |
| --- | --- | --- |
| `url` | string | Full http(s) URL to open (required) |
| `projectRoot` | string | Project whose Playwright launches the browser |
| `selector` | string | Inspect matches of this CSS selector instead of the whole DOM |
| `waitFor` | string | Wait for a selector (CSS or `text=…`) before inspecting |
| `waitUntil` | `load` \| `domcontentloaded` \| `networkidle` | Navigation wait condition |
| `includeHtml` | boolean | Include the rendered HTML (capped) |
| `maxHtmlChars` | number | HTML cap, default `20000` |
| `timeoutMs` | number | Overall limit, default `45000` |

Returns each element's **unique CSS selector**, tag, visibility, bounding box, text and
attributes, plus captured console messages (errors first).

### `list-tests`

| Argument | Type | Description |
| --- | --- | --- |
| `projectRoot` | string | Project directory |
| `config` | string | Config path or 1-based index |
| `testDir` | string | Restrict scanning to a directory (must stay inside the project) |
| `filter` | string | Case-insensitive substring filter on `file › title` |
| `limit` | number | Max tests returned, default `500` |

Uses `playwright test --list` when Playwright works, and **falls back to a source scan**
(keeping the reason) when the install or a spec file is broken.

### `validate-selector`

| Argument | Type | Description |
| --- | --- | --- |
| `url` | string | Live page to test against (required) |
| `selector` | string | CSS selector to validate (required) |
| `projectRoot` | string | Project whose Playwright launches the browser |
| `timeoutMs` | number | Overall limit, default `45000` |

Verdicts: `✅ VALID — N matches` (with a sample of matches), `✅ VALID — 0 matches`
(with debugging advice), `❌ INVALID` (parse error + fix), or a warning when the input
uses a Playwright-only engine (`text=`, `xpath=`, `>>`, `:has-text()`), which is not
plain CSS.

### `generate-e2e-test`

| Argument | Type | Description |
| --- | --- | --- |
| `description` | string | What the test should cover (required) |
| `pageUrl` | string | Page the test starts on (default: `baseURL` / `webServer.url` from config) |
| `testDir` / `file` | string | Where to write the spec (default: detected `testDir` + `generated/<slug>.spec.ts`) |
| `write` | boolean | Write the file to disk (default `true`) |
| `overwrite` | boolean | Replace an existing file at the target path |
| `liveInspect` | boolean | Cross-check selectors against the live page (default on when a URL is known) |
| `projectRoot` / `config` | string | As with the other tools |

Reads the agent's recent changes (`git status`, falling back to `git diff HEAD~1`,
then recent mtimes), extracts the locators those files actually declare
(`data-testid`, `getByRole`, `aria-label`, `placeholder`, `id`, `name`, element text),
ranks verified-live selectors first, writes a spec built from them, and reports each
selector with its source `file:line`.

### `compare-visual-state`

| Argument | Type | Description |
| --- | --- | --- |
| `url` | string | Page to capture (required) |
| `name` | string | Baseline id, e.g. `checkout-page` (letters, digits, `. _ -`) |
| `action` | `compare` \| `baseline` | `compare` (default) diffs; `baseline` re-captures the reference |
| `selector` | string | Capture just this element |
| `fullPage` | boolean | Capture the full scrollable page |
| `tolerance` | number | Percent of pixels that may differ (default `0.1`) |
| `pixelThreshold` | number | Per-pixel channel delta considered different (default `60`) |
| `waitUntil` / `waitFor` / `timeoutMs` | — | As with `inspect-page` |

The first call saves a baseline under `.pw-mcp/visual/` (add that to `.gitignore`, or
commit it for CI comparisons). Later calls report changed-pixel counts, **merged
regions** (`(x, y) 120×40 — 1,200 px`), the **average color shift** ("blue → red"),
and write a red-highlighted diff image for review.

### `diagnose-flaky`

| Argument | Type | Description |
| --- | --- | --- |
| `testFiles` | string[] | Tests to diagnose (`file:line` supported). Defaults to the tests that failed in the most recent run |
| `runs` | number | Times to run them, `2–10` (default `3`) |
| `browser` / `headed` / `workers` / `config` | — | As with `run-test` |
| `timeoutMs` | number | Hard wall-clock limit **per run** (default `120000`) |
| `projectRoot` | string | Project directory |

Every run executes with `--retries=0` and auto-retry disabled, so each result is
honest evidence. The response contains a per-run table (status, duration, first
failure), the count of **distinct normalized error signatures**, and one of:

- **❌ CONSISTENTLY FAILING** — failed every run (same error → reproducible bug,
  different errors → still broken, just noisy). Fix it; it is not flaky.
- **⚠️ FLAKY** — some runs passed. Includes `N of M` counts and whether the
  failures share one signature (real intermittent bug) or vary (timing/environment
  instability).
- **✅ NOT REPRODUCING** — passed every re-run; the original failure was one-off.

The last run is stored, so `get-failure` can analyze it immediately afterwards.

---

## Installation

Requirements:

- Node.js **≥ 20** (the server is built on MCP SDK v2 — the `2026-07-28` spec line)
- A project with `@playwright/test` installed and browsers available
  (`npx playwright install chromium`)

```bash
npm install -D playwright-e2e-mcp @playwright/test
npx playwright install chromium
```

Or run it without installing, via `npx -y playwright-e2e-mcp`.

**No npm account needed** — install straight from GitHub (the `prepare` script
builds `dist/` automatically on install):

```bash
npx -y github:trajectiq-ai/E2E
```

Or grab the packaged tarball from the repo's **GitHub Releases** page and install
it locally:

```bash
npm install -D https://github.com/trajectiq-ai/E2E/releases/download/v0.1.0/playwright-e2e-mcp-0.1.0.tgz
```

### MCP client configuration

**Claude Code / generic (project-scoped):**

```json
{
  "mcpServers": {
    "playwright-e2e": {
      "command": "npx",
      "args": ["-y", "playwright-e2e-mcp"],
      "env": { "PW_MCP_PROJECT_ROOT": "/absolute/path/to/your/project" }
    }
  }
}
```

**Claude Desktop / Cursor / Windsurf:** add the same block to their MCP config file.
The server uses its working directory as the project root; set `PW_MCP_PROJECT_ROOT`
when the client launches it somewhere else (e.g. your home directory).

**Codex / VS Code / Copilot CLIs:**

```bash
codex mcp add playwright-e2e -- npx -y playwright-e2e-mcp
code --add-mcp '{"name":"playwright-e2e","command":"npx","args":["-y","playwright-e2e-mcp"]}'
```

All tools ship MCP **tool annotations** (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`), so clients can show accurate safety prompts
before running anything.

**From a local checkout:**

```json
{
  "mcpServers": {
    "playwright-e2e": {
      "command": "node",
      "args": ["/path/to/playwright-e2e-mcp/dist/index.js"],
      "env": { "PW_MCP_PROJECT_ROOT": "/path/to/your/project" }
    }
  }
}
```

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PW_MCP_PROJECT_ROOT` | server cwd | Default project root for every tool |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `LOG_FORMAT` | `text` | `text` or `json` (structured) |

Logs always go to **stderr** — stdout is reserved for the MCP protocol.

## Typical workflow

1. `generate-e2e-test` `{ "description": "checkout with a saved card" }` — scaffolds a
   spec from your real selectors (skipped if you write the test yourself).
2. `list-tests` — see what exists (`tests/checkout.spec.ts:5 checkout › pays with card`).
3. `run-test` `{ "testFiles": ["tests/checkout.spec.ts"] }` — run it; get stats + failures
   (flaky tests are auto-retried once before being called failures).
4. `get-failure` `{ "index": 1 }` — read the code frame, expected/actual, **the DOM
   snapshot at failure from the trace**, the failed network requests, the page's
   console errors, and next steps.
5. If it looks selector-related: `inspect-page` `{ "url": "http://localhost:3000/checkout" }`
   to see the real DOM, then `validate-selector` to prove the replacement selector works.
6. After changing CSS/components: `compare-visual-state` `{ "url": "…", "name": "checkout" }`
   to catch unintended visual regressions.
7. If a failure looks intermittent: `diagnose-flaky` `{ "runs": 3 }` — get the evidence
   verdict (flaky vs consistently broken) before deciding what to fix.
8. Fix the spec or the app, then re-run **only what failed**:
   `run-test` `{ "lastFailed": true }`, and repeat until green.

## Edge cases handled

| Situation | Behaviour |
| --- | --- |
| No Playwright installed | `NO_PLAYWRIGHT` error with the exact install commands for your package manager |
| Dev server not running | Failure classified `server-unreachable` / `SERVER_NOT_RUNNING` with a "start your dev server" hint (and `webServer` advice) |
| Test exceeds `timeoutMs` | Process **group** is killed (SIGINT→SIGKILL on POSIX, `taskkill /T /F` on Windows) and partial results are returned |
| Browser crashes | Classified `browser-crash` with retry / reinstall guidance |
| Windows backslashes | All paths normalized lexically (`C:\a\..\b` → `C:/b`); unit-tested on both platforms |
| Flaky tests | Failing tests are automatically retried once (`--retries=1`) before being reported; passes surface as **flaky** with a stability warning; `diagnose-flaky` decides flaky-vs-broken with multi-run evidence |
| Trace/DOM context | `--trace=retain-on-failure` is passed automatically, so `get-failure` can show the exact DOM at the moment of failure — plus the failed network requests (`*.network` logs) and console errors from the same trace |
| Slow re-runs after a fix | `run-test` with `lastFailed: true` re-runs only the tests that failed last time (`--last-failed`) |
| Several `playwright.config` files | Returns a numbered menu (`MULTIPLE_CONFIGS`); pick with `config: "2"` or a path |
| Syntax error in a spec | `SYNTAX_ERROR` with file:line; nothing crashes; `list-tests` falls back to a source scan |
| MCP client disconnects | Per-request `AbortSignal` kills the run; stdin end triggers shutdown, and every tracked child tree is force-killed (`killActiveChildren`) |
| Disk full | `ENOSPC` detected → `DISK_FULL` with a "free space" hint; logging never throws |
| Malicious paths | `../../etc/passwd`, absolute paths outside the root, URLs and null bytes are rejected with `INVALID_PATH`; CLI args are shell-metacharacter-checked |

## Security notes

- **No shell**: Playwright is spawned as `node <playwright/cli.js> …` with an argument
  array — no command interpolation.
- **Path sandbox**: user paths are resolved lexically and must stay inside the project root.
- **Cleanup**: temp report/script files are written to the OS temp dir and removed;
  child processes are tracked and killed on shutdown.

## Development

```
src/
├── index.ts            # bin entry point (--version/--help, main-module guard)
├── server.ts           # McpServer setup, tool registration, shutdown handling
├── tools/              # the eight tools + shared plumbing
├── utils/              # playwright-runner, report-parser, project-detector, path-utils,
│                       # logger, trace-reader (trace.zip → DOM/network/console),
│                       # image-diff (PNG codec + pixel diff), change-analyzer
└── types/              # shared interfaces and the ErrorKind taxonomy
```

Built on **`@modelcontextprotocol/server` v2** (the `2026-07-28` MCP spec line) with
Zod v4 standard schemas; every tool declares spec tool annotations.

```bash
npm install
npm run build   # tsc → dist/ (zero errors)
npm test        # build + test/run-tests.mjs (70 unit tests, any Node ≥20)
npm run e2e     # build + e2e/run.mjs: live MCP ↔ Playwright integration suite
```

Tests cover the report parser (sample Playwright JSON, trace attachments), path utils
(Windows and macOS paths, sandboxing), the project detector (temp-dir fixtures: config
discovery, multiple configs, missing install, test-file scanning), the shared tool
helpers, the **trace reader** (synthetic trace.zip: error, failed action, DOM snapshot,
`*.network` failed-request parsing, console error/warning events), the **image diff**
(PNG round-trip, regions, color shift, dimension changes), the **change analyzer**
(selector extraction, git + mtime paths) and the **flaky verdict logic**
(failure signatures, CONSISTENTLY FAILING / FLAKY / NOT REPRODUCING / NO TESTS RAN).

### Integration suite (`npm run e2e`)

Unit tests prove the logic; the integration suite proves the loop. It boots the real
server over stdio against a live fixture app and a Playwright project under
`e2e/fixture/`, then drives it exactly like an MCP client and asserts ~40 behaviours
that only appear end-to-end:

- initialize handshake, 8 tools, spec tool annotations and object input schemas,
- live DOM inspection, CSS selector validation (matches, zero matches, engine
  syntax, parse errors), dead-server detection,
- visual regression: baseline → unchanged compare → `blue → red` diff detection,
- `run-test` pass/fail/`lastFailed` stats and meta lines,
- `get-failure` trace diagnostics: DOM at failure, the 404 network request,
  the `console.error` message, diagnosis and next steps,
- auto-retry turning a first-run failure into `PASSED (1 flaky)`,
- `diagnose-flaky` verdict **FLAKY** (2 of 3 runs) with retries disabled,
- `generate-e2e-test` writing its scaffold, plus error paths
  (missing test path, unknown tool, unreachable server).

First run needs the browser once: `npx playwright install chromium`.
CI runs the suite on Ubuntu and Windows (see `.github/workflows/ci.yml`).

### Try the example

With Playwright installed in your project:

```bash
npx playwright test examples/sample-test.spec.ts
```

or ask your agent to call `run-test` with
`"testFiles": ["examples/sample-test.spec.ts"]` — it hits the public
[example.com](https://example.com) page, so it verifies browsers, network and the MCP
pipeline in one shot.

## License

MIT
