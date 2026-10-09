---
name: playwright-e2e-mcp
description: Runs, debugs and fixes Playwright end-to-end tests through the playwright-e2e-mcp server, using structured run results, trace-based failure diagnostics, live DOM inspection and selector validation. Use when the user asks to run Playwright tests, fix a failing or broken e2e test, find out why a test is flaky, repair a selector that no longer matches, write a new Playwright test, or check a page for visual regressions.
---

# Playwright E2E with playwright-e2e-mcp

This skill drives the `playwright-e2e-mcp` MCP server. The server runs Playwright
for you and returns structured results instead of raw terminal output: pass/fail
stats, each failure with `file:line`, a failure kind, the DOM at the moment of
failure (read from the Playwright trace), failed network requests, console errors
and concrete next steps.

## Before you start

1. Check that the server's tools are available. They are named `run-test`,
   `get-failure`, `inspect-page`, `validate-selector`, `list-tests`,
   `generate-e2e-test`, `compare-visual-state` and `diagnose-flaky` (your client
   may prefix them, e.g. `mcp__playwright-e2e__run-test`).
2. If they are missing, stop and tell the user the MCP server is not connected.
   Point them to `references/setup.md` for the one-line install for their client.
   Do not fall back to shelling out to `npx playwright test` unless the user asks.
3. Every tool takes an optional `projectRoot`. Leave it out unless the user works
   in a sub-project; the server defaults to `PW_MCP_PROJECT_ROOT` or its working
   directory, and rejects any root outside its allowed roots.

## The core loop: fix a failing test

Follow these steps in order. Do not edit code before step 3.

1. **Run.** Call `run-test` with the narrowest scope you know:
   `{ "testFiles": ["tests/checkout.spec.ts"] }`, or `file:line`, or `grep`.
   Omit `testFiles` only when the user asks for the whole suite. Failing tests are
   retried once by default, so a test that passes on retry is reported as
   **flaky**, not failed.
2. **Read the failure.** For each failure, call `get-failure` with its 1-based
   `index`. Read the message and code frame, expected vs actual, the failure kind,
   the DOM snapshot at failure, the failed action and its selector, failed network
   requests and console errors.
3. **Decide what is wrong** using the failure kind (see
   `references/failure-kinds.md`):
   - `server-unreachable` / `SERVER_NOT_RUNNING`: the app is not running. Tell the
     user to start the dev server, or suggest `webServer` in the Playwright config.
     Do not edit tests.
   - A locator or selector in the message, or "0 elements": go to the selector
     loop below.
   - `assertion` with a sensible selector: compare expected vs actual and the DOM
     snapshot. Decide whether the app regressed or the test expectation is stale,
     and say which before changing anything.
   - `timeout`: check the DOM snapshot and failed requests for a slow or failed
     API call before raising any timeout.
   - Failed network request (4xx/5xx/no response) right before the failure: the
     backend is the likely cause; report it.
4. **Fix** the spec or the app code, the smallest change that addresses the cause.
5. **Re-run only what failed:** `run-test` with `{ "lastFailed": true }`. Repeat
   from step 2 until green.

## Selector loop: a locator no longer matches

1. `inspect-page` with the page URL (e.g. `{ "url": "http://localhost:3000/checkout" }`).
   Add `selector` to focus on a region, or `waitFor` if the content loads late.
   It returns each element's unique CSS selector, visibility, box, text and
   attributes.
2. Pick a replacement. Prefer, in order: `data-testid`, role + accessible name
   (`getByRole`), label/placeholder, then a short stable CSS selector. Avoid
   positional selectors such as `:nth-child` and generated class names.
3. `validate-selector` with `{ "url": ..., "selector": ... }` before editing the
   spec. Only use a selector that comes back `✅ VALID` with the expected match
   count (usually exactly 1). `validate-selector` checks plain CSS; for
   Playwright-only syntax (`text=`, `>>`, `:has-text()`, `getByRole`) validate the
   CSS equivalent or confirm with a re-run.
4. Update the spec and re-run with `lastFailed: true`.

## Flaky or intermittent failures

Call `diagnose-flaky` (optionally `{ "testFiles": [...], "runs": 5 }`; with no
`testFiles` it takes the tests that failed in the last run). It runs with retries
disabled and returns one verdict:

- **CONSISTENTLY FAILING**: not flaky; treat it as a real failure (core loop).
- **FLAKY**: some runs passed. Same error signature each time points to a real
  race in the app or test; varying errors point to timing or environment. Look for
  missing awaits, assertions without auto-waiting, shared state between tests and
  fixed `waitForTimeout` sleeps. Never "fix" flakiness by only adding retries or
  sleeps.
- **NOT REPRODUCING**: passed every run. Report that the failure was one-off.

`get-failure` works on the last diagnose run straight after.

## Other tasks

- **List tests:** `list-tests`, with `filter` for a substring of `file › title`.
- **Write a new test:** `generate-e2e-test` with a `description` (and `pageUrl` if
  there is no `baseURL`). It scaffolds a spec from selectors the project actually
  declares, from recent git changes, and reports each selector's source. Review the
  file it writes, then `run-test` it. Pass `write: false` to preview without
  writing.
- **Visual regression:** `compare-visual-state` with `url` and a `name`. The first
  call saves a baseline under `.pw-mcp/visual/`; later calls report changed
  regions and color shifts and write a diff image. Use `action: "baseline"` only
  when the user confirms the new look is intended.

## Reporting back

When you finish, tell the user, in this order:

1. The result: which tests now pass, fail or are flaky (counts from the last
   `run-test`).
2. The cause of each failure you fixed, with the `file:line` you changed.
3. Anything you did not fix and why (app bug, server down, needs a decision).

## Things to avoid

- Do not raise timeouts, add retries, add `waitForTimeout`, or delete or
  `test.skip` a test to make a run green, unless the user explicitly asks.
- Do not accept a new visual baseline without the user's confirmation.
- Do not point `inspect-page` or `validate-selector` at sites the user did not
  name; they open real pages in a headless browser.
- `run-test` executes the project's own test code. Run it only in projects the
  user has asked you to work on.

## References

- `references/setup.md`: install and client configuration, environment variables.
- `references/tools.md`: every tool's arguments.
- `references/failure-kinds.md`: failure kinds and error codes, and what to do.
- `references/example-session.md`: a worked fix-a-failing-test session.
