# Failure kinds and error codes

## Per-test failure kinds (from `run-test` and `get-failure`)

| Kind | Meaning | What to do |
| --- | --- | --- |
| `assertion` | An `expect` did not hold | Compare expected vs actual and the DOM snapshot; decide whether the app regressed or the expectation is stale, and say which before editing |
| `timeout` | An action or the test ran out of time | Check the DOM snapshot and failed network requests for the real cause (element never appeared, API failed) before touching timeouts |
| `server-unreachable` | The app under test did not respond | Ask the user to start the dev server, or configure `webServer` in the Playwright config; do not edit tests |
| `browser-crash` | The browser or page closed unexpectedly | Re-run once; if it repeats, suggest `npx playwright install` to repair browsers |
| `syntax` | The spec or config does not compile | Fix the reported `file:line` first; nothing else will run until it does |
| `config` | The Playwright config is invalid | Read the message and fix the config |
| `unknown` | Not classified | Read the message, stack and DOM snapshot directly |

A test reported as **flaky** passed on the automatic retry. Run
`diagnose-flaky` before deciding how to treat it.

## Tool error codes

| Code | Meaning | What to do |
| --- | --- | --- |
| `NO_PLAYWRIGHT` | `@playwright/test` is not installed in the project | Show the user the install command the error includes |
| `NO_CONFIG` | No `playwright.config.*` found | Ask where the config is, or pass `projectRoot` / `config` |
| `MULTIPLE_CONFIGS` | Several configs found; the error lists them numbered | Ask the user which one, or pick the obvious one, and pass `config: "2"` or its path |
| `INVALID_PATH` | A path or `projectRoot` leaves the allowed roots | Use a path inside the project; to allow another root the user must set `PW_MCP_ALLOWED_ROOTS` |
| `SERVER_NOT_RUNNING` | The app is not reachable | As `server-unreachable` above |
| `TIMEOUT` | The whole run hit `timeoutMs`; results are partial | Narrow the run (`testFiles`, `grep`) or raise `timeoutMs` for this call |
| `BROWSER_CRASH` | Browser failed | As `browser-crash` above |
| `SYNTAX_ERROR` | A spec has a syntax error | Fix the reported file; `list-tests` still works via a source scan |
| `DISK_FULL` | No space left on device | Ask the user to free disk space |
| `SPAWN_FAILED` / `REPORT_MISSING` | Playwright could not start or wrote no report | Check Node and Playwright are installed; re-run with `LOG_LEVEL=debug` |
| `CLIENT_DISCONNECT` | The run was cancelled | Re-run if still needed |
