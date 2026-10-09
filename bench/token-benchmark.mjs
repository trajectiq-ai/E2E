#!/usr/bin/env node
/**
 * Token benchmark: what does an agent have to read to diagnose and fix one
 * drifted locator, with this server versus Playwright MCP + a shell?
 *
 *   node bench/token-benchmark.mjs        (after npm run build)
 *
 * Scenario: bench/app.mjs serves a storefront page (nav, search, 24 product
 * cards, cart, footer). The spec clicks getByTestId('checkout-button'), but
 * the app renamed it to checkout-btn.
 *
 * Route A, playwright-e2e-mcp: run-test → suggest-fix → suggest-fix apply
 * (which re-runs the test to verify). Counted: tool definitions + the three
 * results.
 *
 * Route B, Playwright MCP + shell: `playwright test` output (list reporter),
 * browser_navigate + browser_snapshot (the accessibility snapshot the agent
 * reads to find the element), and the passing re-run's output after the
 * agent edits the spec. Counted: tool definitions + those three outputs. This is a
 * lower bound for route B: it assumes the agent finds the element and writes
 * the fix without any further calls.
 *
 * Tokens are estimated as characters ÷ 4 for both routes, the same
 * rule, so the ratio is what matters. Results go to bench/RESULTS.md.
 *
 * Playwright MCP needs a browser: set BENCH_CHROME to a Chromium/Chrome
 * executable, or have Google Chrome installed (its default channel).
 */

import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const project = path.join(here, 'project');
const specTemplate = path.join(project, 'tests', 'checkout.spec.ts.txt');
const spec = path.join(project, 'tests', 'checkout.spec.ts');
const pwCli = path.join(repoRoot, 'node_modules', 'playwright', 'cli.js');

const tokens = (text) => Math.ceil(text.length / 4);

class Client {
  constructor(command, args, env, cwd) {
    this.child = spawn(command, args, { env: { ...process.env, ...env }, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.pending = new Map();
    this.id = 0;
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      }
    });
    this.child.stderr.on('data', () => undefined);
  }
  request(method, params, timeoutMs = 180_000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '1' } });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return this;
  }
  async toolsJson() {
    const list = await this.request('tools/list', {});
    return JSON.stringify(list.tools);
  }
  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    return (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  }
  close() {
    this.child.kill();
  }
}

/** What an agent reads from a shell: `playwright test` with the list reporter. */
function rawTestRun(env) {
  // Async: the app under test is served from this same process.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [pwCli, 'test', 'tests/checkout.spec.ts', '--reporter=list'], {
      cwd: project,
      env: { ...process.env, ...env, FORCE_COLOR: '0', CI: '1' },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', () => resolve(out));
  });
}

async function main() {
  const app = await startApp();
  const env = { BENCH_URL: app.origin };
  const rows = [];
  const samples = {};
  try {
    // Route A
    copyFileSync(specTemplate, spec);
    const ours = await new Client(process.execPath, [path.join(repoRoot, 'dist', 'index.js')], { ...env, PW_MCP_PROJECT_ROOT: project, PW_MCP_HISTORY: '0', LOG_LEVEL: 'silent' }, repoRoot).init();
    const oursDefs = await ours.toolsJson();
    const run = await ours.call('run-test', { testFiles: ['tests/checkout.spec.ts'], retryOnFailure: false });
    const fix = await ours.call('suggest-fix', {});
    const applied = await ours.call('suggest-fix', { apply: true });
    ours.close();
    const fixedByUs = readFileSync(spec, 'utf8').includes("getByRole('button', { name: 'Proceed to checkout' })") && applied.includes('✅ Verified');
    samples.ours = { run, fix, applied };

    // Route B
    copyFileSync(specTemplate, spec);
    const failing = await rawTestRun(env);
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'bench-pwmcp-'));
    const pwArgs = [pwCli, 'mcp', '--headless', '--isolated', `--output-dir=${outDir}`];
    if (process.env.BENCH_CHROME) pwArgs.push(`--executable-path=${process.env.BENCH_CHROME}`);
    // Chromium refuses to start sandboxed as root (containers, CI images).
    if (process.getuid?.() === 0) pwArgs.push('--no-sandbox');
    const pw = await new Client(process.execPath, pwArgs, {}, outDir).init();
    const pwDefs = await pw.toolsJson();
    const navigate = await pw.call('browser_navigate', { url: app.origin });
    // browser_navigate links the snapshot as a file; this is the inline
    // accessibility snapshot the agent reads to find the element.
    const snapshot = await pw.call('browser_snapshot', {});
    pw.close();
    rmSync(outDir, { recursive: true, force: true });
    writeFileSync(spec, readFileSync(specTemplate, 'utf8').replace("getByTestId('checkout-button')", "getByRole('button', { name: 'Proceed to checkout' })"));
    const passing = await rawTestRun(env);
    samples.pw = { failing, navigate, snapshot, passing };

    const a = { defs: tokens(oursDefs), steps: tokens(run) + tokens(fix) + tokens(applied) };
    const b = { defs: tokens(pwDefs), steps: tokens(failing) + tokens(navigate) + tokens(snapshot) + tokens(passing) };
    rows.push(['Tool definitions (sent with every request)', a.defs, b.defs]);
    rows.push(['Run the failing test', tokens(run), tokens(failing)]);
    rows.push(['Find the element / propose the fix', tokens(fix), tokens(navigate) + tokens(snapshot)]);
    rows.push(['Apply + verify (re-run)', tokens(applied), tokens(passing)]);
    rows.push(['**Total for one fix**', a.defs + a.steps, b.defs + b.steps]);

    const date = new Date().toISOString().slice(0, 10);
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const pwPkg = JSON.parse(readFileSync(path.join(repoRoot, 'node_modules', 'playwright', 'package.json'), 'utf8'));
    const table = [
      '| Step | playwright-e2e-mcp | Playwright MCP + shell |',
      '| --- | ---: | ---: |',
      ...rows.map(([label, x, y]) => `| ${label} | ${x.toLocaleString('en-US')} | ${y.toLocaleString('en-US')} |`),
    ].join('\n');
    const md = [
      '# Token benchmark: diagnosing one drifted locator',
      '',
      `Run ${date} with playwright-e2e-mcp ${pkg.version} and Playwright ${pwPkg.version} (\`playwright mcp\`). Reproduce with \`npm run build && node bench/token-benchmark.mjs\`.`,
      '',
      'Scenario: a storefront page (navigation, search, 24 product cards, cart, footer) renamed its checkout button test id from `checkout-button` to `checkout-btn`; the spec still uses the old one. Tokens are estimated as characters ÷ 4 for both routes.',
      '',
      table,
      '',
      `Fixed and verified by playwright-e2e-mcp without an edit by the agent: **${fixedByUs ? 'yes' : 'no'}**.`,
      '',
      'Route B is a lower bound: it assumes the agent reads one snapshot, writes the right locator first time and re-runs once. It also leaves the reasoning (matching `checkout-button` to "Proceed to checkout" among ~150 elements) to the model, which route A does in the server.',
      '',
      '## What each route returned for the diagnosis step',
      '',
      '<details><summary>playwright-e2e-mcp: suggest-fix</summary>',
      '',
      '```markdown',
      fix.trim(),
      '```',
      '',
      '</details>',
      '',
      `<details><summary>Playwright MCP: browser_snapshot (${tokens(snapshot).toLocaleString('en-US')} tokens, first 40 lines)</summary>`,
      '',
      '```markdown',
      snapshot.split('\n').slice(0, 40).join('\n'),
      '```',
      '',
      '</details>',
      '',
    ].join('\n');
    writeFileSync(path.join(here, 'RESULTS.md'), md);
    process.stdout.write(`${table}\n\nFixed and verified: ${fixedByUs ? 'yes' : 'no'}\nWrote bench/RESULTS.md\n`);
  } finally {
    rmSync(spec, { force: true });
    rmSync(path.join(project, 'test-results'), { recursive: true, force: true });
    app.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  rmSync(spec, { force: true });
  process.exit(1);
});
