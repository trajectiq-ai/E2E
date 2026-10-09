#!/usr/bin/env node
/**
 * Real-client check for the `.mcpb` bundle.
 *
 * `mcpb-launch-sim.mjs` answers "does the archive extract and complete a
 * handshake". This answers the next question — "does an actual MCP client get
 * work out of it?" — and deliberately avoids the repo's own hand-rolled
 * reader: it installs the bundle the way a host does (extract, read
 * `manifest.json`, substitute `mcp_config`), then drives the entry point with
 * the **official MCP SDK client** (`@modelcontextprotocol/client`, the same
 * package line the server is built on) and makes a real tool call against the
 * integration fixture, asserting on what comes back.
 *
 * Usage: node scripts/mcpb-client-check.mjs [<bundle.mcpb> | <extracted-dir>]
 *
 * With no argument the bundle this checkout just built is used.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { extractMcpb } from './extract-mcpb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(root, 'e2e', 'fixture');

/** Tools and prompts the published bundle must advertise. */
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
const EXPECTED_PROMPTS = ['fix-failing-test', 'triage-flaky-tests'];

const scratch = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

/** Resolve the argument to something with a manifest.json at its root. */
function locate() {
  const arg = process.argv[2];
  if (!arg) {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const built = path.join(root, `${pkg.name}-${pkg.version}.mcpb`);
    if (!existsSync(built)) {
      throw new Error(`no bundle at ${path.basename(built)} — run \`npm run mcpb\` first, or pass a .mcpb path`);
    }
    return { kind: 'mcpb', target: built };
  }
  const abs = path.resolve(arg);
  if (!existsSync(abs)) throw new Error(`no such path: ${arg}`);
  if (/\.mcpb$/i.test(abs)) return { kind: 'mcpb', target: abs };
  if (statSync(abs).isDirectory()) return { kind: 'dir', target: abs };
  throw new Error(`expected a .mcpb file or an extracted directory: ${arg}`);
}

const checks = [];
function expect(label, condition, detail = '') {
  if (!condition) throw new Error(`${label}${detail ? ` — ${detail}` : ''}`);
  checks.push(label);
}

/** @returns {string} the concatenated text of a tool result. */
function textOf(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  return parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
}

async function main() {
  const located = locate();
  const dir = located.kind === 'mcpb' ? tmp('mcpb-client-extract-') : located.target;
  if (located.kind === 'mcpb') {
    extractMcpb(located.target, dir);
    console.log(`installed ${path.basename(located.target)} -> temp extensions dir`);
  }

  const home = tmp('mcpb-client-home-');
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const cfg = manifest.server?.mcp_config;
  expect('manifest declares a node server with an entry point', Boolean(cfg?.command) && Array.isArray(cfg?.args));

  // The official bundle CLI validates the manifest against its own schema — a
  // second opinion on the file the host will read, from the tool that defines
  // the format. It is a devDependency, so this needs no network access.
  const mcpbCli = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
  const validation = spawnSync(process.execPath, [mcpbCli, 'validate', path.join(dir, 'manifest.json')], {
    encoding: 'utf8',
  });
  expect(
    'official mcpb CLI validates the manifest',
    validation.status === 0,
    `${validation.stdout ?? ''}${validation.stderr ?? ''}`.trim().slice(0, 300),
  );

  // Host-style substitution: ${__dirname}, ${HOME} and user_config values.
  const substitute = (value, projectRoot) =>
    value
      .replaceAll('${__dirname}', dir)
      .replaceAll('${HOME}', home)
      .replaceAll('${user_config.project_root}', projectRoot);

  const transport = new StdioClientTransport({
    command: substitute(cfg.command, fixtureRoot),
    args: cfg.args.map((arg) => substitute(arg, fixtureRoot)),
    cwd: dir,
    env: {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(cfg.env ?? {}).map(([key, value]) => [key, substitute(String(value), fixtureRoot)]),
      ),
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'mcpb-client-check', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const version = client.getServerVersion();
  expect(
    `official client completed initialize (${version?.name} ${version?.version})`,
    version?.name === 'playwright-e2e-mcp' && version?.version === manifest.version,
    `got ${JSON.stringify(version)} for bundle version ${manifest.version}`,
  );

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const missingTools = EXPECTED_TOOLS.filter((name) => !tools.includes(name));
  expect(`tools/list advertised all ${EXPECTED_TOOLS.length} tools`, missingTools.length === 0, `missing ${missingTools.join(', ')}`);

  const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
  const missingPrompts = EXPECTED_PROMPTS.filter((name) => !prompts.includes(name));
  expect(`prompts/list advertised ${EXPECTED_PROMPTS.length} prompts`, missingPrompts.length === 0, `missing ${missingPrompts.join(', ')}`);

  // A real tool call against the integration fixture, through the real client.
  const listed = await client.callTool({ name: 'list-tests', arguments: { projectRoot: fixtureRoot } });
  const listing = textOf(listed);
  expect('callTool list-tests returned content', listing.length > 0, `result was ${JSON.stringify(listed).slice(0, 200)}`);
  expect('callTool list-tests found the fixture specs', /pass\.spec\.ts/.test(listing), `listing was: ${listing.slice(0, 200)}`);

  await client.close();

  for (const line of checks) console.log(`PASS ${line}`);
  console.log(`client check: ${checks.length} checks passed`);
}

try {
  await main();
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  // Windows can hold a just-closed child's handles briefly; retries make the
  // transient EPERM a no-op.
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
