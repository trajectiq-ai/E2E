# playwright-e2e-mcp

[![CI](https://github.com/trajectiq-ai/E2E/actions/workflows/ci.yml/badge.svg)](https://github.com/trajectiq-ai/E2E/actions/workflows/ci.yml) [![release](https://img.shields.io/github/v/release/trajectiq-ai/E2E)](https://github.com/trajectiq-ai/E2E/releases) [![MCP Registry](https://img.shields.io/badge/MCP%20Registry-io.github.trajectiq--ai%2FE2E-2563eb)](https://registry.modelcontextprotocol.io/)

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

## Demo

**Hosted endpoint** — what an `initialize` + `tools/list` round-trip against
`https://playwright-e2e-mcp.vercel.app/api/mcp` returns for a client that sends the
bearer token (without one, only `list-tests` and `get-failure` are listed):

![Token-protected endpoint: initialize handshake and all 8 tools](https://raw.githubusercontent.com/trajectiq-ai/E2E/main/docs/demo-endpoint.png)

**A real test run** — `run-test` served over stdio by `npx -y playwright-e2e-mcp`
against the bundled `examples/sample-test.spec.ts` (actual output, unedited):

![run-test result: 4 passed, 0 failed, 5.1s](https://raw.githubusercontent.com/trajectiq-ai/E2E/main/docs/demo-run-test.png)

Images are rendered with `node scripts/gen-demo-images.mjs`: the run-test card is real
captured output; the endpoint card is an illustration of the authenticated listing.

## Install

Works with Claude Desktop, Claude Code, Cursor, Windsurf, Codex, Gemini CLI, Freebuff
and every other MCP client — pick whichever route fits:

| Route | How |
| --- | --- |
| **npm (canonical, fastest)** | `npx -y playwright-e2e-mcp` |
| **MCP Registry** (registry-aware clients discover it automatically) | `io.github.trajectiq-ai/E2E` — [listing](https://registry.modelcontextprotocol.io/) |
| **Any client, no npm account needed** | `npx -y github:trajectiq-ai/E2E#v0.1.3` (pin a release tag) |
| **Claude Desktop, zero Node setup** | double-click the [`.mcpb` extension](https://github.com/trajectiq-ai/E2E/releases) |
| **Remote-only clients (ChatGPT connectors)** | `https://playwright-e2e-mcp.vercel.app/api/mcp` |

Details and per-client config: [Installation](#installation) ·
[MCP client configuration](#mcp-client-configuration).

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
| `projectRoot` | string | Project directory inside the configured root (default: server working directory) |
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
| `args` | string[] | Extra Playwright flags from an allowlist (`--repeat-each=N`, `--max-failures=N`, `--update-snapshots`, `--shard=1/3`, `--trace=on`, …); values go after `=` and are checked, and flags that take a path, such as `--config` or `--output`, are rejected |

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
| `testDir` / `file` | string | Where to write the spec (default: detected `testDir` + `generated/<slug>.spec.ts`); `file` must end in `.spec.*` or `.test.*` |
| `write` | boolean | Write the file to disk (default `true`) |
| `overwrite` | boolean | Replace an existing spec at the target path; only specs this tool generated can be replaced |
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

**No npm account needed** — install straight from GitHub (the `prepare` script
builds `dist/` automatically on install). Pin a release tag: an unpinned
`github:trajectiq-ai/E2E` runs whatever is on the default branch at that moment.

```bash
npx -y github:trajectiq-ai/E2E#v0.1.3
npm install -D github:trajectiq-ai/E2E#v0.1.3 @playwright/test   # or as a project dependency
npx playwright install chromium
```

Or grab the packaged tarball from the repo's **GitHub Releases** page and install
it locally:

```bash
npm install -D https://github.com/trajectiq-ai/E2E/releases/download/v0.1.3/playwright-e2e-mcp-0.1.3.tgz
```

Listed in the **official [MCP Registry](https://registry.modelcontextprotocol.io/)** as
`io.github.trajectiq-ai/E2E` — registry-aware clients discover it there, and every
`v*` release tag republishes the entry from CI via [`server.json`](server.json).

### MCP client configuration

**Claude Code / generic (project-scoped):**

```json
{
  "mcpServers": {
    "playwright-e2e": {
      "command": "npx",
      "args": ["-y", "github:trajectiq-ai/E2E#v0.1.3"],
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
codex mcp add playwright-e2e -- npx -y github:trajectiq-ai/E2E#v0.1.3
code --add-mcp '{"name":"playwright-e2e","command":"npx","args":["-y","github:trajectiq-ai/E2E#v0.1.3"]}'
```

Codex's defaults fight this server: the first launch clones the repo and runs
`tsc` (measured 30 s on a cold `npx` cache, against a 10 s
`startup_timeout_sec` default), and a Playwright run with retries beats the 60 s
`tool_timeout_sec` default. Raise both in `~/.codex/config.toml`:

```toml
[mcp_servers.playwright-e2e]
command = "npx"
args = ["-y", "github:trajectiq-ai/E2E#v0.1.3"]
startup_timeout_sec = 60
tool_timeout_sec = 600
```

**Claude Desktop (one-click):** download and double-click the `.mcpb` Desktop
Extension attached to the [latest release](https://github.com/trajectiq-ai/E2E/releases) —
the bundle ships its own dependencies, so no Node setup is required. On install it
asks you to pick your **project root** (required, no default: choose the project
folder, not your home directory) and wires it
into `PW_MCP_PROJECT_ROOT`, so the tools point at a real project from the first call.

**Claude Code:**

```bash
claude mcp add playwright-e2e -- npx -y github:trajectiq-ai/E2E#v0.1.3
```

**Gemini CLI / Qwen Code:** paste the `mcpServers` block above into
`.gemini/settings.json` (Qwen Code: `.qwen/settings.json`) — both speak the same
MCP settings format.

**Freebuff / Codebuff (project-scoped):** this repo ships a committed
[`.agents/mcp.json`](.agents/mcp.json), so opening the checkout in Freebuff
attaches the server workspace-wide — no global config needed. Your own projects
can do the same: drop an `mcp.json` with the block above into their `.agents/`
directory. Freebuff asks you to trust a repository's `.agents/` on first run.

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

## Hosted endpoint (ChatGPT & remote clients)

Some clients — ChatGPT custom connectors especially — only accept **remote
HTTPS** MCP servers and refuse to spawn a local `npx` process. This repo ships a
Streamable HTTP bridge for exactly that case:

| | |
| --- | --- |
| **Endpoint** | `https://playwright-e2e-mcp.vercel.app/api/mcp` |
| **Transport** | MCP Streamable HTTP (`POST` JSON in, JSON or SSE out) |
| **Auth** | bearer token (`PW_MCP_HTTP_TOKEN`). The deployment at this URL requires it; a bridge started without the variable serves only the read-only tools |
| **Source** | [`api/mcp.ts`](api/mcp.ts) → [`src/http.ts`](src/http.ts) |

The bridge runs the *same* `createServer()` as the stdio transport; the SDK
serves every request with a fresh server instance, which is what a serverless
function wants. `test/http-bridge.test.mjs` drives the real Node adapter over
`node:http` so a broken bridge fails in CI, not in ChatGPT.

**This deployment is token-protected.** `https://playwright-e2e-mcp.vercel.app`
has `PW_MCP_HTTP_TOKEN` set, so a request without `Authorization: Bearer <token>`
— including a ChatGPT connector created with authentication *None* — gets
`401 {"error":"unauthorized"}`. Ask the operator for the token, or run your own
bridge (below).

**Open vs. token-protected.** With `PW_MCP_HTTP_TOKEN` set (at least 16
characters; use a random value) all eight tools are served to clients that send
`Authorization: Bearer <token>`, and every other request gets `401`. Without that
variable anyone who reaches the URL can call the bridge, so it degrades to
`list-tests` and `get-failure` in restricted mode: `list-tests` scans sources
instead of running `playwright test --list` (which would execute the project's
config), callers cannot pick another `projectRoot`, and nothing spawns a process,
drives a browser or writes a file. Child processes started over HTTP get only an
allowlisted environment. `PW_MCP_ALLOWED_HOSTS` (comma separated, `*` for any)
limits the accepted `Host` header; without a token and without that variable,
only `localhost` names and the deployment's own Vercel hostnames are accepted
(DNS-rebinding protection).

**Add it to ChatGPT:** Settings → Connectors → turn on **Advanced → Developer
mode** → *Create custom connector* → paste the endpoint above. Authentication
**None** only works against a bridge with no token (read-only tools), so for this
deployment choose the connector's **API key** authentication and send
`Authorization: Bearer <token>` — or point the connector at your own deployment
with `PW_MCP_HTTP_TOKEN` unset.

To self-host the open, read-only variant, deploy this repo with
`PW_MCP_HTTP_TOKEN` unset; nothing else changes.

Codex can also take the remote transport instead of spawning `npx`, if you'd
rather not ship Playwright to every machine. Point it at the token through an
environment variable so the secret stays out of the config file:

```bash
export PW_MCP_HTTP_TOKEN=…   # ask the operator for the value
codex mcp add playwright-e2e-remote --url https://playwright-e2e-mcp.vercel.app/api/mcp \
  --bearer-token-env-var PW_MCP_HTTP_TOKEN
```

**What to expect:** `list-tests` works and reports the specs bundled with the
deployment. Even with a token, tools that spawn a browser (`run-test`,
`inspect-page`, `validate-selector`, `diagnose-flaky`, …) cannot download
Chromium in a serverless function, so they return their normal `NO_PLAYWRIGHT`
hint. Use the stdio install for real runs; the hosted endpoint is for discovery
and for clients that cannot run local processes.

```bash
# verify the handshake without any client (the live deployment needs the token;
# drop the authorization header and it answers 401 instead)
curl -X POST https://playwright-e2e-mcp.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer $PW_MCP_HTTP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```

Redeploy after a change: merge to `main`. Vercel's Git integration deploys
every push, so there is no token to manage and no CLI step — watch the
`Vercel` commit status for the deployment result.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PW_MCP_PROJECT_ROOT` | server cwd | Default project root for every tool |
| `PW_MCP_ALLOWED_ROOTS` | — | Extra directories a caller may pass as `projectRoot` (`:`-separated, `;` on Windows). Anything outside these and the default root is rejected |
| `PW_MCP_HTTP_TOKEN` | — | HTTP bridge only: bearer token (16+ characters) that unlocks all tools (see above) |
| `PW_MCP_ALLOWED_HOSTS` | localhost + Vercel hostnames when there is no token | HTTP bridge only: comma-separated `Host` allowlist; `*` accepts any |
| `PW_MCP_PASSTHROUGH_ENV` | — | HTTP bridge only: comma-separated extra variables passed to test runs (e.g. `BASE_URL`) |
| `PW_MCP_MAX_CHILDREN` | `4` | HTTP bridge only: how many test runs and browser probes may run at once |
| `PW_MCP_BLOCK_PRIVATE_URLS` | off (on for the HTTP bridge) | `1` makes the URL tools refuse loopback, private-network and cloud-metadata addresses, including redirects and subresources |
| `LOG_LEVEL` / `MCP_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` \| `silent`; `LOG_LEVEL` wins when both are set |
| `LOG_FORMAT` / `MCP_LOG_FORMAT` | `text` | `text`, or `json` (also `ndjson`) for one structured JSON object per line — ready for a log ingester |

Logs always go to **stderr** — stdout is reserved for the MCP protocol. Unrecognized values
fall back to the default, so a typo in `LOG_LEVEL` logs at `info` and one in `LOG_FORMAT`
logs as text rather than silencing the server. With `LOG_FORMAT=json` each line is a single
object (`time`, `level`, `message` plus context):

```json
{"time":"2026-10-07T08:00:00.000Z","level":"info","message":"server ready","name":"playwright-e2e-mcp"}
```

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
| Malicious paths | `../../etc/passwd`, absolute paths outside the root, a `projectRoot` outside the allowed roots, symlinks that leave the root, URLs and null bytes are rejected with `INVALID_PATH`; extra CLI args must be allowlisted Playwright flags |

## Security notes

- **No shell**: Playwright is spawned as `node <playwright/cli.js> …` with an argument
  array — no command interpolation. Extra `args` are limited to an allowlist of
  Playwright flags, each with a checked value (`--flag=value`), so a caller cannot
  swap in another `--config` or `--output` or hand git an option through
  `--only-changed`. Paths with a segment starting with `-` are rejected, so a test
  file name cannot be read as a flag.
- **Path sandbox**: user paths must stay inside the project root, checked lexically
  and again with symlinks resolved. A caller-supplied `projectRoot` must sit inside
  `PW_MCP_PROJECT_ROOT` (or a `PW_MCP_ALLOWED_ROOTS` entry).
- **Generated code**: `generate-e2e-test` only writes `*.spec.*` / `*.test.*` files,
  only overwrites specs whose header it wrote itself, never writes through a symlink,
  and escapes every value it puts into strings or comments.
- **HTTP bridge**: read-only tools unless `PW_MCP_HTTP_TOKEN` is set; child processes
  started over HTTP get only an allowlisted environment (`PATH`, `HOME`, temp dirs,
  locale, `CI`, `PLAYWRIGHT_*`, `npm_config_*` without embedded credentials, plus
  anything in `PW_MCP_PASSTHROUGH_ENV`), at most `PW_MCP_MAX_CHILDREN` run at once
  (a disconnected client frees its slot immediately), and internal error messages
  are not returned to clients. The allowlist only covers the child's own
  environment: test code runs as the same OS user, so on Linux it could still read
  the server's startup environment from `/proc`. That is why only token holders
  can run project code; keep other secrets out of the bridge's environment, or run
  it under a separate user.
- **SSRF guard**: on the HTTP bridge (or with `PW_MCP_BLOCK_PRIVATE_URLS=1`) the URL tools
  refuse hosts that resolve to loopback, private, link-local/metadata or reserved
  addresses, and route the browser through a local proxy that applies the same check
  to every redirect hop and subresource; IPv6 forms that embed an IPv4 address
  (mapped, NAT64, 6to4, Teredo) are blocked too, and WebRTC UDP is disabled so a
  page cannot reach the network around the proxy. It is off for stdio by default because
  opening `http://localhost` dev servers is what these tools are for.
- **Cleanup**: temp report/script files are written to the OS temp dir and removed;
  child processes are tracked and killed on shutdown. Trace decompression has one
  size budget per archive, and PNGs are capped at 16,384 px per side and 50 M pixels.

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
npm test        # build + test/run-tests.mjs (unit tests, any Node ≥20)
npm run e2e     # build + e2e/run.mjs: live MCP ↔ Playwright integration suite
npm run mcpb    # build + bundle dist/ into playwright-e2e-mcp-<version>.mcpb (+ .sha256)
npm run mcpb:smoke   # ...then install that bundle in a temp dir, launch it and assert the handshake
```

Tests cover the report parser (sample Playwright JSON, trace attachments), path utils
(Windows and macOS paths, sandboxing), the project detector (temp-dir fixtures: config
discovery, multiple configs, missing install, test-file scanning), the shared tool
helpers, the **trace reader** (synthetic trace.zip: error, failed action, DOM snapshot,
`*.network` failed-request parsing, console error/warning events), the **image diff**
(PNG round-trip, regions, color shift, dimension changes), the **change analyzer**
(selector extraction, git + mtime paths), the **flaky verdict logic**
(failure signatures, CONSISTENTLY FAILING / FLAKY / NOT REPRODUCING / NO TESTS RAN),
the **HTTP bridge** (token, restricted mode, Host allowlist), the **security
regressions** (sandbox escapes, argument smuggling, symlink writes, code injection,
SSRF ranges, env scrubbing, decode limits), the `.mcpb` manifest, the `.mcpb` zip
extractor, and the MCP config files.

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
