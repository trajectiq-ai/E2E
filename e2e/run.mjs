#!/usr/bin/env node
/**
 * Integration suite for playwright-e2e-mcp (run via `npm run e2e`).
 *
 * Unit tests (test/*.test.mjs) prove the pure logic; this suite proves the
 * *live* loop the server exists for. It:
 *
 *   1. starts a small fixture web app on an ephemeral port,
 *   2. boots the real MCP server (dist/index.js) over stdio with
 *      PW_MCP_PROJECT_ROOT pointing at e2e/fixture,
 *   3. drives it through the MCP protocol exactly like a client would, and
 *   4. asserts ~90 behaviours that only appear end-to-end:
 *      handshake + tool annotations + prompts, live DOM inspection with
 *      verified role locators, selector/locator validation, pages behind a
 *      login (storageState) and after steps (actions), visual baseline/diff
 *      (blue → red), pass/fail/lastFailed Playwright runs with progress
 *      notifications, background runs, trace network-404 + console-error
 *      diagnostics, suggest-fix (refusal on a missing element, verified heal
 *      of a renamed one), auto-retry flaky reporting, diagnose-flaky
 *      verdicts, run history ranking, scaffold generation and error paths.
 *
 * Exit code 0 only when every check passes.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fixtureRoot = path.join(here, 'fixture');
const serverEntry = path.join(repoRoot, 'dist', 'index.js');

const COLORS = { blue: 'rgb(37, 99, 235)', red: 'rgb(220, 38, 38)' };
const EXPECTED_TOOLS = [
  'analyze-history',
  'compare-visual-state',
  'diagnose-flaky',
  'generate-e2e-test',
  'get-failure',
  'get-run-status',
  'inspect-page',
  'list-tests',
  'run-test',
  'suggest-fix',
  'validate-selector',
];

/* ------------------------------------------------------------------ */
/* Check bookkeeping                                                   */
/* ------------------------------------------------------------------ */

const checks = [];

function check(name, ok, detail) {
  const passed = Boolean(ok);
  checks.push({ name, ok: passed, detail });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${!passed && detail ? `\n      ${detail}` : ''}\n`);
}

function contains(name, text, needle) {
  const ok = typeof text === 'string' && text.includes(needle);
  check(name, ok, ok ? undefined : `expected output to include ${JSON.stringify(needle)}${typeof text === 'string' ? '' : ` (got ${typeof text})`}`);
}

/* ------------------------------------------------------------------ */
/* Fixture web app                                                     */
/* ------------------------------------------------------------------ */

function pageHtml(flipped) {
  const initial = flipped ? COLORS.red : COLORS.blue;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Freebuff Demo Shop</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 48px; background: #f8fafc; color: #0f172a; }
  #cta { padding: 20px 40px; font-size: 20px; color: #fff; border: 0; border-radius: 10px; cursor: pointer; }
</style>
</head>
<body>
  <h1>Freebuff Demo Shop</h1>
  <p>Fixture app for the playwright-e2e-mcp integration suite.</p>
  <button id="cta" data-testid="cta-button" style="background-color: ${initial}">Buy now</button>
  <script>
    (function () {
      var btn = document.getElementById('cta');
      var colors = ['${COLORS.blue}', '${COLORS.red}'];
      btn.addEventListener('click', function () {
        var next = btn.style.backgroundColor === '${COLORS.blue}' ? 1 : 0;
        btn.style.backgroundColor = colors[next];
      });
    })();
  </script>
</body>
</html>
`;
}

function accountHtml() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Your account</title></head>
<body>
  <h1>Your account</h1>
  <button id="open-settings">Open settings</button>
  <dialog id="settings"><h2>Settings</h2><label for="nick">Nickname</label><input id="nick"><button>Save settings</button></dialog>
  <script>
    document.getElementById('open-settings').addEventListener('click', function () {
      document.getElementById('settings').showModal();
    });
  </script>
</body>
</html>
`;
}

function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const state = { flipped: false };
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/flip') {
        state.flipped = !state.flipped;
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET' && req.url === '/account') {
        if (!/(^|;\s*)session=ok(;|$)/.test(req.headers.cookie ?? '')) {
          res.writeHead(302, { location: '/login' }).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(accountHtml());
        return;
      }
      if (req.method === 'GET' && req.url === '/login') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Sign in</title><h1>Sign in</h1><label for="email">Email</label><input id="email"><button>Sign in</button>');
        return;
      }
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(pageHtml(state.flipped));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: req.url }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        flip: async () => {
          const response = await fetch(`http://127.0.0.1:${port}/flip`, { method: 'POST' });
          if (!response.ok) throw new Error(`fixture flip failed: ${response.status}`);
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Minimal MCP stdio client (newline-delimited JSON-RPC 2.0)           */
/* ------------------------------------------------------------------ */

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.stderr = '';
    this.exited = null;
    this.notifications = [];

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let index;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line === '') continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Non-protocol noise on stdout is a bug we surface elsewhere.
        }
        if (message.id === undefined && typeof message.method === 'string') {
          this.notifications.push(message);
          continue;
        }
        if (message.id === undefined || !this.pending.has(message.id)) continue;
        const entry = this.pending.get(message.id);
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const error = new Error(message.error.message ?? 'JSON-RPC error');
          error.code = message.error.code;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-40_000);
    });

    child.on('close', (code, signal) => {
      this.exited = { code, signal };
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`MCP server exited unexpectedly (code ${code}, signal ${signal})`));
      }
      this.pending.clear();
    });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 120_000) {
    if (this.exited) {
      return Promise.reject(new Error(`MCP server already exited (code ${this.exited.code})`));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** End stdin (the server's graceful-shutdown signal) and await exit. */
  async stop() {
    if (!this.exited) {
      try {
        this.child.stdin.end();
      } catch {
        /* already closed */
      }
      await new Promise((done) => {
        const timer = setTimeout(done, 15_000);
        this.child.once('close', () => {
          clearTimeout(timer);
          done();
        });
      });
      if (!this.exited) this.child.kill();
    }
    return this.exited;
  }
}

async function callTool(client, name, args, timeoutMs = 150_000, meta) {
  const result = await client.request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) }, timeoutMs);
  const text = (result.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  return { result, text, isError: result.isError === true };
}

/* ------------------------------------------------------------------ */
/* Fixture lifecycle                                                   */
/* ------------------------------------------------------------------ */

function cleanFixture() {
  const stale = ['test-results', 'playwright-report', 'blob-report', '.pw-mcp', '.playwright-e2e-mcp', '.auth', 'tests/generated', 'tests/.flaky-marker', 'tests/heal.spec.ts'];
  for (const entry of stale) {
    rmSync(path.join(fixtureRoot, entry), { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */

async function phaseHandshake(client, pkg) {
  const init = await client.request(
    'initialize',
    {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'playwright-e2e-mcp-e2e', version: '1.0.0' },
    },
    30_000,
  );
  check('initialize handshake returns our server', init?.serverInfo?.name === 'playwright-e2e-mcp', `got ${JSON.stringify(init?.serverInfo)}`);
  check('server reports the package version', init?.serverInfo?.version === pkg.version, `expected ${pkg.version}, got ${init?.serverInfo?.version}`);
  client.notify('notifications/initialized');

  const list = await client.request('tools/list', {}, 30_000);
  const tools = list.tools ?? [];
  const names = tools.map((tool) => tool.name).sort();
  check(`tools/list exposes all ${EXPECTED_TOOLS.length} tools`, JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), `got ${JSON.stringify(names)}`);

  const prompts = await client.request('prompts/list', {}, 30_000);
  const promptNames = (prompts.prompts ?? []).map((prompt) => prompt.name).sort();
  check('prompts/list offers the fix and triage workflows', JSON.stringify(promptNames) === JSON.stringify(['fix-failing-test', 'triage-flaky-tests']), `got ${JSON.stringify(promptNames)}`);
  const fixPrompt = await client.request('prompts/get', { name: 'fix-failing-test', arguments: { test: 'tests/fail.spec.ts' } }, 30_000);
  contains('fix-failing-test prompt walks the suggest-fix loop', fixPrompt.messages?.[0]?.content?.text, 'suggest-fix');

  const missingAnnotations = tools.filter((tool) => typeof tool?.annotations?.readOnlyHint !== 'boolean');
  check('every tool declares spec tool annotations', missingAnnotations.length === 0, `missing readOnlyHint on: ${missingAnnotations.map((t) => t.name).join(', ')}`);

  const missingSchema = tools.filter((tool) => tool?.inputSchema?.type !== 'object' && !tool?.inputSchema?.properties);
  check('every tool input schema is an object schema', missingSchema.length === 0, `bad schema on: ${missingSchema.map((t) => t.name).join(', ')}`);

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  check(
    'safety hints: run-test mutates, get-failure is read-only',
    byName.get('run-test')?.annotations?.readOnlyHint === false && byName.get('get-failure')?.annotations?.readOnlyHint === true,
    JSON.stringify({ runTest: byName.get('run-test')?.annotations, getFailure: byName.get('get-failure')?.annotations }),
  );
  const missingTitles = tools.filter((tool) => typeof tool.title !== 'string' || tool.title === '');
  check('every tool has a title', missingTitles.length === 0, `untitled: ${missingTitles.map((t) => t.name).join(', ')}`);
}

async function phaseLivePage(client, origin) {
  const inspect = await callTool(
    client,
    'inspect-page',
    { url: origin, waitFor: '#cta' },
    90_000,
  );
  check('inspect-page returns the live DOM', !inspect.isError && inspect.text.includes('Freebuff Demo Shop'), inspect.text.slice(0, 400));
  contains('inspect-page sees data-testid="cta-button"', inspect.text, 'cta-button');
  contains('inspect-page sees the button text', inspect.text, 'Buy now');

  const valid = await callTool(client, 'validate-selector', { url: origin, selector: '#cta' }, 90_000);
  check('validate-selector: #cta matches once', !valid.isError && valid.text.includes('## ✅ VALID — 1 match'), valid.text.slice(0, 300));

  const missing = await callTool(client, 'validate-selector', { url: origin, selector: '#not-here' }, 90_000);
  contains('validate-selector: missing id reports 0 matches', missing.text, 'VALID — 0 matches');

  const engine = await callTool(client, 'validate-selector', { url: origin, selector: 'text=Buy now' }, 90_000);
  contains('validate-selector: Playwright selector engines are validated', engine.text, '## ✅ VALID — 1 match');
  contains('validate-selector: suggests the role locator for the match', engine.text, "unique locator: `getByRole('button', { name: 'Buy now' })`");

  const role = await callTool(client, 'validate-selector', { url: origin, selector: "page.getByRole('button', { name: 'Buy now' })" }, 90_000);
  contains('validate-selector: getByRole locator matches once', role.text, '## ✅ VALID — 1 match');
  contains('validate-selector: shows the parsed locator', role.text, "**Parsed as:** `getByRole('button', { name: 'Buy now' })`");

  const unsafe = await callTool(client, 'validate-selector', { url: origin, selector: "getByRole('button').evaluate(() => 1)" }, 30_000);
  contains('validate-selector: refuses non-locator code', unsafe.text, '## ❌ INVALID');

  const map = await callTool(client, 'inspect-page', { url: origin, view: 'locators' }, 90_000);
  contains('inspect-page locator map lists the verified role locator', map.text, "`getByRole('button', { name: 'Buy now' })` — button \"Buy now\"");
  contains('inspect-page locator map offers the test id alternative', map.text, "getByTestId('cta-button')");
  contains('inspect-page DOM view carries locators too', inspect.text, "locator: `getByRole('button', { name: 'Buy now' })`");

  const loggedOut = await callTool(client, 'inspect-page', { url: `${origin}/account` }, 90_000);
  contains('inspect-page without a session lands on the login page', loggedOut.text, '"Sign in"');
  contains('inspect-page hints at storageState on a login page', loggedOut.text, 'Pass `storageState`');

  const host = new URL(origin).hostname;
  mkdirSync(path.join(fixtureRoot, '.auth'), { recursive: true });
  writeFileSync(
    path.join(fixtureRoot, '.auth', 'user.json'),
    JSON.stringify({ cookies: [{ name: 'session', value: 'ok', domain: host, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] }),
  );
  const loggedIn = await callTool(
    client,
    'inspect-page',
    {
      url: `${origin}/account`,
      storageState: '.auth/user.json',
      view: 'locators',
      actions: [{ type: 'click', locator: "getByRole('button', { name: 'Open settings' })" }],
    },
    90_000,
  );
  contains('storageState opens the page behind the login', loggedIn.text, '"Your account"');
  contains('page state line names the session file', loggedIn.text, 'session `.auth/user.json`');
  contains('actions reach the settings dialog', loggedIn.text, "getByRole('heading', { name: 'Settings' })");
  contains('locators inside the dialog are verified', loggedIn.text, "getByRole('textbox', { name: 'Nickname' })");

  const escape = await callTool(client, 'inspect-page', { url: origin, storageState: '../../package.json' }, 30_000);
  check('storageState outside the project is refused', escape.isError && escape.text.includes('INVALID_PATH'), escape.text.slice(0, 300));

  const badStep = await callTool(
    client,
    'inspect-page',
    { url: origin, actions: [{ type: 'click', locator: "getByRole('button', { name: 'Does not exist' })" }], timeoutMs: 30_000 },
    60_000,
  );
  check('a failing action names the step', badStep.isError && badStep.text.includes('step 1 (click'), badStep.text.slice(0, 400));

  const broken = await callTool(client, 'validate-selector', { url: origin, selector: 'div >' }, 90_000);
  contains('validate-selector: CSS parse error reported', broken.text, '## ❌ INVALID');

  const baseline = await callTool(client, 'compare-visual-state', { url: origin, name: 'e2e-cta', action: 'baseline' }, 90_000);
  contains('visual baseline created', baseline.text, '📸 Baseline');

  const same = await callTool(client, 'compare-visual-state', { url: origin, name: 'e2e-cta' }, 90_000);
  contains('unchanged page matches its baseline', same.text, '✅ No visual change');

  await flipFixture();
  const changed = await callTool(client, 'compare-visual-state', { url: origin, name: 'e2e-cta' }, 90_000);
  check(
    'changed button detected with blue → red color shift',
    !changed.isError && changed.text.includes('⚠️ Visual change detected') && changed.text.includes('blue → red') && changed.text.includes('Diff image'),
    changed.text.slice(0, 600),
  );
  await flipFixture(); // restore the blue starting state for the test runs

  const dead = await callTool(client, 'inspect-page', { url: 'http://127.0.0.1:9/' }, 60_000);
  check(
    'dead server detected (SERVER_NOT_RUNNING)',
    dead.isError && dead.text.includes('SERVER_NOT_RUNNING'),
    dead.text.slice(0, 300),
  );
}

// Set by main() so phaseLivePage can toggle the fixture app's button color.
let flipFixture = async () => {};

async function phaseTestRuns(client, origin) {
  const list = await callTool(client, 'list-tests', {}, 90_000);
  contains('list-tests finds 3 fixture tests', list.text, '3 tests found');
  contains('list-tests uses `playwright test --list`', list.text, 'Playwright `--list`');
  contains('list-tests lists pass.spec.ts', list.text, 'tests/pass.spec.ts');
  contains('list-tests lists fail.spec.ts', list.text, 'tests/fail.spec.ts');
  contains('list-tests lists flaky.spec.ts', list.text, 'tests/flaky.spec.ts');

  const pass = await callTool(client, 'run-test', { testFiles: ['tests/pass.spec.ts'] }, 180_000);
  check('run-test passes the healthy spec', !pass.isError && pass.text.includes('✅ PASSED'), pass.text.slice(0, 500));
  contains('pass run reports stats | 1 | 0 | 0 | 0 |', pass.text, '| 1 | 0 | 0 | 0 |');

  client.notifications.length = 0;
  const fail = await callTool(client, 'run-test', { testFiles: ['tests/fail.spec.ts'], retryOnFailure: false }, 180_000, { progressToken: 'e2e-fail' });
  const progress = client.notifications.filter((n) => n.method === 'notifications/progress' && n.params?.progressToken === 'e2e-fail');
  check('run-test sends progress notifications', progress.length > 0 && progress.some((n) => n.params.total === 1), JSON.stringify(progress.slice(-2)));
  check('run-test fails the broken spec', !fail.isError && fail.text.includes('❌ FAILED'), fail.text.slice(0, 500));
  contains('fail run names the missing save-btn', fail.text, 'save-btn');
  contains('fail run reports stats | 0 | 1 | 0 | 0 |', fail.text, '| 0 | 1 | 0 | 0 |');
  contains('fail run reports the project-relative file path', fail.text, '**File:** `tests/fail.spec.ts');

  const failure = await callTool(client, 'get-failure', {}, 60_000);
  contains('get-failure reports Failure 1 of 1', failure.text, '## Failure 1 of 1');
  contains('get-failure titles the failure', failure.text, 'checkout save button surfaces cart errors');
  contains('get-failure points at the project-relative file', failure.text, '**File:** `tests/fail.spec.ts');
  contains('get-failure suggests a runnable re-run path', failure.text, 'testFiles: ["tests/fail.spec.ts:');
  contains('get-failure captured the DOM at failure (trace)', failure.text, '### DOM at failure (Playwright trace)');
  contains('get-failure lists the failed 404 request', failure.text, '### Network requests that failed');
  contains('get-failure shows the 404 URL', failure.text, 'missing.json');
  contains('get-failure surfaces the console error', failure.text, 'fixture-console-error: cart service unreachable');
  contains('get-failure shows the console section', failure.text, '### Console before the failure');
  contains('get-failure provides a diagnosis', failure.text, '### Diagnosis');
  contains('get-failure provides next steps', failure.text, '### Next steps');

  const refuse = await callTool(client, 'suggest-fix', {}, 90_000);
  contains('suggest-fix refuses to heal a missing element', refuse.text, "No confident replacement for `getByTestId('save-btn')`");
  contains('suggest-fix explains it is likely an app bug', refuse.text, 'most likely **missing**');

  const lastFailed = await callTool(client, 'run-test', { lastFailed: true }, 180_000);
  contains('lastFailed run is labelled (--last-failed)', lastFailed.text, 'failed tests only (--last-failed)');
  contains('lastFailed reran the failing test', lastFailed.text, '| 0 | 1 | 0 | 0 |');
  check(
    'lastFailed did NOT rerun the passing test',
    !lastFailed.text.includes('tests/pass.spec.ts'),
    'pass.spec.ts appeared in the --last-failed run output',
  );

  // No testFiles → the target comes from the stored failure's file path;
  // this proves the parser rebase (tests/fail.spec.ts, not fail.spec.ts)
  // flows into the default targeting and covers the third verdict.
  const consistent = await callTool(client, 'diagnose-flaky', { runs: 2 }, 360_000);
  contains('diagnose-flaky defaults to the last failed test', consistent.text, '## Flaky diagnosis — `tests/fail.spec.ts` × 2 runs');
  contains('diagnose-flaky verdict: CONSISTENTLY FAILING', consistent.text, '**CONSISTENTLY FAILING** — failed all 2 run(s)');

  rmSync(path.join(fixtureRoot, 'tests', '.flaky-marker'), { force: true });
  const flaky = await callTool(client, 'run-test', { testFiles: ['tests/flaky.spec.ts'] }, 180_000);
  contains('auto-retry turns the first-run failure into FLAKY', flaky.text, '✅ PASSED (1 flaky)');
  contains('flaky run shows the auto retry meta line', flaky.text, 'auto retry ×1');
  contains('flaky run warns about flaky tests', flaky.text, '1 flaky test(s)');

  rmSync(path.join(fixtureRoot, 'tests', '.flaky-marker'), { force: true });
  const diagnosis = await callTool(client, 'diagnose-flaky', { testFiles: ['tests/flaky.spec.ts'], runs: 3 }, 360_000);
  contains('diagnose-flaky runs with retries disabled', diagnosis.text, 'Playwright retries disabled');
  contains('diagnose-flaky verdict: FLAKY (2 of 3)', diagnosis.text, '**FLAKY** — 2 of 3 run(s) passed');
  const passedRows = (diagnosis.text.match(/✅ passed/g) ?? []).length;
  check('diagnose-flaky table shows 2 passes + 1 failure', passedRows >= 2 && diagnosis.text.includes('❌ failed'), `passed rows: ${passedRows}`);

  const generatedPath = path.join(fixtureRoot, 'tests', 'generated', 'click-the-call-to-action-button.spec.ts');
  const generate = await callTool(client, 'generate-e2e-test', { description: 'click the call to action button', pageUrl: origin }, 120_000);
  contains('generate-e2e-test renders the scaffold', generate.text, '## 🧪 Generated test');
  contains('generate-e2e-test reports the target file', generate.text, 'tests/generated/click-the-call-to-action-button.spec.ts');
  contains('generate-e2e-test records the entry URL', generate.text, '**Entry URL:**');
  const wrote = existsSync(generatedPath) && statSync(generatedPath).isFile();
  check('generated spec exists on disk', wrote, generatedPath);
  if (wrote) {
    const source = readFileSync(generatedPath, 'utf8');
    contains('generated spec contains a Playwright test', source, 'test(');
  }
}

async function phaseHistoryAndHeal(client) {
  const ranking = await callTool(client, 'analyze-history', {}, 30_000);
  contains('analyze-history ranks the flaky fixture test', ranking.text, '### ⚠️ Flaky');
  contains('analyze-history names flaky.spec.ts', ranking.text, 'tests/flaky.spec.ts');
  contains('analyze-history lists the always-failing test as broken', ranking.text, '### ❌ Broken');
  check('history file written inside the project', existsSync(path.join(fixtureRoot, '.playwright-e2e-mcp', 'history.jsonl')), 'missing history.jsonl');
  check('history folder ignores itself in git', existsSync(path.join(fixtureRoot, '.playwright-e2e-mcp', '.gitignore')), 'missing .gitignore');

  const patterns = await callTool(client, 'analyze-history', { view: 'patterns' }, 30_000);
  contains('analyze-history groups failures by cause', patterns.text, '## Failure patterns');
  const timeline = await callTool(client, 'analyze-history', { test: 'inventory sync' }, 30_000);
  contains('analyze-history shows one test timeline', timeline.text, '**Timeline (oldest → newest):**');

  const started = await callTool(client, 'run-test', { testFiles: ['tests/pass.spec.ts'], background: true }, 30_000);
  const runId = /`(run-[a-z0-9-]+)`/.exec(started.text)?.[1];
  check('run-test background returns a run id at once', Boolean(runId), started.text.slice(0, 300));
  const status = await callTool(client, 'get-run-status', { runId, waitSeconds: 55 }, 90_000);
  contains('get-run-status returns the finished result', status.text, '✅ PASSED');
  contains('get-run-status labels the background run', status.text, `Background run \`${runId}\``);

  // A renamed test id: the element is still there, the locator drifted.
  const healPath = path.join(fixtureRoot, 'tests', 'heal.spec.ts');
  writeFileSync(
    healPath,
    [
      "import { expect, test } from '@playwright/test';",
      '',
      "test('buy button still works', async ({ page }) => {",
      "  await page.goto('/');",
      "  await page.getByTestId('buy-button').click({ timeout: 3000 });",
      "  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();",
      '});',
      '',
    ].join('\n'),
  );
  const broken = await callTool(client, 'run-test', { testFiles: ['tests/heal.spec.ts'], retryOnFailure: false }, 180_000);
  contains('drifted locator fails first', broken.text, 'buy-button');
  const proposal = await callTool(client, 'suggest-fix', {}, 90_000);
  contains('suggest-fix proposes the role locator', proposal.text, "+  await page.getByRole('button', { name: 'Buy now' }).click({ timeout: 3000 });");
  contains('suggest-fix rates it high confidence', proposal.text, 'confidence **high**');
  check('suggest-fix without apply leaves the file alone', readFileSync(healPath, 'utf8').includes("getByTestId('buy-button')"), 'file changed');
  const applied = await callTool(client, 'suggest-fix', { apply: true }, 180_000);
  contains('suggest-fix apply verifies with a re-run', applied.text, '### ✅ Verified');
  contains('the spec now uses the healed locator', readFileSync(healPath, 'utf8'), "getByRole('button', { name: 'Buy now' })");
  rmSync(healPath, { force: true });
}

async function phaseErrorPaths(client) {
  const missing = await callTool(client, 'run-test', { testFiles: ['tests/does-not-exist.spec.ts'] }, 60_000);
  check(
    'run-test rejects a missing test path (INVALID_PATH)',
    missing.isError && missing.text.includes('INVALID_PATH') && missing.text.includes('not found'),
    missing.text.slice(0, 300),
  );

  let unknownOk = false;
  let unknownDetail = '';
  try {
    const result = await client.request('tools/call', { name: 'definitely-not-a-tool', arguments: {} }, 30_000);
    unknownOk = result?.isError === true;
    unknownDetail = `server answered with isError=${result?.isError}`;
  } catch (error) {
    unknownOk = true;
    unknownDetail = error.message;
  }
  check('unknown tool call is rejected', unknownOk, unknownDetail);
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();

  if (!existsSync(serverEntry)) {
    process.stderr.write(`e2e: ${serverEntry} not found — run \`npm run e2e\` (it builds first) or \`npm run build\`.\n`);
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  cleanFixture();

  const fixture = await startFixtureServer();
  flipFixture = fixture.flip;

  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PW_MCP_PROJECT_ROOT: fixtureRoot,
      FIXTURE_PORT: new URL(fixture.origin).port,
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
      FORCE_COLOR: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const client = new McpClient(child);
  let fatal = null;

  try {
    await phaseHandshake(client, pkg);
    await phaseLivePage(client, fixture.origin);
    await phaseTestRuns(client, fixture.origin);
    await phaseHistoryAndHeal(client);
    await phaseErrorPaths(client);
  } catch (error) {
    fatal = error;
    check(`harness aborted: ${error?.message ?? error}`, false, error?.stack);
  } finally {
    const exited = await client.stop();
    check('MCP server shuts down cleanly (exit 0)', exited?.code === 0, `exit=${JSON.stringify(exited)}`);
    await fixture.close();
  }

  const failed = checks.filter((entry) => !entry.ok);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  process.stdout.write(`\n${'─'.repeat(60)}\n`);
  process.stdout.write(`Integration suite: ${checks.length - failed.length}/${checks.length} checks passed (${elapsed}s)\n`);

  if (failed.length > 0 || fatal) {
    process.stdout.write('\nFailures:\n');
    for (const entry of failed) process.stdout.write(`  - ${entry.name}\n`);
    const stderr = client.stderr.trim();
    if (stderr !== '') {
      process.stdout.write(`\nServer stderr (tail):\n${stderr.slice(-4_000)}\n`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`e2e: fatal — ${error?.stack ?? error}\n`);
  process.exit(1);
});
