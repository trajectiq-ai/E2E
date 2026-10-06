/**
 * Regression tests for the second security audit: flags smuggled through
 * an allowed flag's value or a test file name, list-tests running project
 * code for unauthenticated callers, writes through planted symlinks, a
 * loose generated-file marker, zip bombs spread over many entries, IPv6
 * forms of private addresses, credentials in passed-through env values,
 * and HTTP clients that disconnect while holding a run slot.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createToolStore } from '../dist/tools/shared.js';
import { generateE2ETestTool } from '../dist/tools/generate-e2e-test.js';
import { listTestsTool } from '../dist/tools/list-tests.js';
import { runTestTool } from '../dist/tools/run-test.js';
import { normalizePath, sanitizeCliArg, sanitizeUserPath } from '../dist/utils/path-utils.js';
import { logger } from '../dist/utils/logger.js';
import { isBlockedAddress } from '../dist/utils/url-policy.js';
import { childEnv, killActiveChildren, setScrubChildEnv } from '../dist/utils/playwright-runner.js';
import { readZipEntries } from '../dist/utils/trace-reader.js';
import { createMcpHttpHandler, handleNodeRequest } from '../dist/http.js';

let base;
let root;
let outside;

/** A fake Playwright install whose CLI records its argv (and can be told to hang). */
const STUB_CLI = `
const fs = require('node:fs');
const path = require('node:path');
fs.writeFileSync(path.join(process.cwd(), 'argv.json'), JSON.stringify(process.argv.slice(2)));
if (process.env.STUB_HANG === '1') setTimeout(() => {}, 60_000);
`;

before(async () => {
  base = normalizePath(await mkdtemp(path.join(os.tmpdir(), 'pw-mcp-sec2-')));
  root = `${base}/project`;
  outside = `${base}/outside`;
  await mkdir(`${root}/tests`, { recursive: true });
  await mkdir(`${root}/node_modules/@playwright/test`, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(`${root}/package.json`, '{"name":"victim","devDependencies":{"@playwright/test":"*"}}\n');
  await writeFile(`${root}/node_modules/@playwright/test/package.json`, '{"name":"@playwright/test","version":"1.0.0"}\n');
  await writeFile(`${root}/node_modules/@playwright/test/cli.js`, STUB_CLI);
  await writeFile(`${root}/tests/a.spec.ts`, "import { test } from '@playwright/test';\ntest('a', async () => {});\n");
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

const ctxFor = (projectRoot, extra = {}) => ({
  logger: logger.child({ tool: 'test' }),
  store: createToolStore(),
  projectRoot,
  ...extra,
});

test('allowed flags only accept checked values', () => {
  for (const ok of ['--only-changed', '--only-changed=main', '--only-changed=HEAD~1', '--repeat-each=3', '--workers=50%', '--shard=1/3', '--trace=on', '-u', '--update-snapshots=missing', '--project=chromium', '--headed']) {
    assert.equal(sanitizeCliArg(ok), ok);
  }
  for (const bad of [
    '--only-changed=--output=/tmp/x',
    '--only-changed=-c',
    '--project',
    '--project=--config=x',
    '--grep-invert',
    '--shard',
    '--workers=200',
    '-j=0',
    '--retries=99',
    '--trace=--output',
    '--headed=--config=x',
    '--debug',
    '--repeat-each=1\n--config=x',
  ]) {
    assert.throws(() => sanitizeCliArg(bad), (err) => err.kind === 'INVALID_PATH', JSON.stringify(bad));
  }
});

test('paths with an option-like segment are rejected', () => {
  for (const bad of ['--output=/tmp/x.spec.ts', 'tests/--reporter=x/a.spec.ts', '-x']) {
    assert.throws(() => sanitizeUserPath(bad, root), (err) => err.kind === 'INVALID_PATH', bad);
  }
  assert.equal(sanitizeUserPath('tests/a-b.spec.ts', root), `${root}/tests/a-b.spec.ts`);
});

async function runTest(args) {
  await rm(`${root}/argv.json`, { force: true });
  const result = await runTestTool.handler({ retryOnFailure: false, ...args }, ctxFor(root));
  const argv = existsSync(`${root}/argv.json`) ? JSON.parse(await readFile(`${root}/argv.json`, 'utf8')) : null;
  return { result, argv };
}

test('run-test never hands a smuggled flag to Playwright', async () => {
  const smuggled = await runTest({ testFiles: [`--output=${outside}/pwout`] });
  assert.equal(smuggled.result.isError, true);
  assert.equal(smuggled.argv, null, 'Playwright must not start');

  const viaArgs = await runTest({ args: [`--only-changed=--output=${outside}/git-out.txt`] });
  assert.equal(viaArgs.result.isError, true);
  assert.equal(viaArgs.argv, null);

  const fine = await runTest({ testFiles: ['tests/a.spec.ts'], args: ['--repeat-each=2'] });
  assert.ok(fine.argv, 'stub CLI should have run');
  assert.ok(fine.argv.includes('tests/a.spec.ts'));
  assert.ok(fine.argv.includes('--repeat-each=2'));
  assert.equal(fine.argv.at(-1), '--reporter=json');
  assert.equal(fine.argv.filter((arg) => arg.startsWith('--reporter')).length, 1);
});

test('restricted list-tests scans sources and never runs project code', async () => {
  const marker = `${base}/config-ran.txt`;
  await writeFile(`${root}/playwright.config.js`, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nmodule.exports = {};\n`);
  try {
    const result = await listTestsTool.handler({}, ctxFor(root, { restricted: true }));
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.match(result.content[0].text, /source scan/);
    assert.equal(existsSync(`${root}/argv.json`) && JSON.parse(await readFile(`${root}/argv.json`, 'utf8')).includes('--list'), false);
    assert.equal(existsSync(marker), false);

    const moved = await listTestsTool.handler({ projectRoot: 'tests' }, ctxFor(root, { restricted: true }));
    assert.equal(moved.isError, true);
  } finally {
    await rm(`${root}/playwright.config.js`, { force: true });
  }
});

test('generate-e2e-test never writes through a symlink, dangling or not', async (t) => {
  const link = `${root}/tests/dangle.spec.ts`;
  try {
    await symlink(`${outside}/created-by-dangling.spec.ts`, link);
  } catch {
    t.skip('symlinks not permitted on this machine');
    return;
  }
  try {
    const result = await generateE2ETestTool.handler(
      { description: 'dangling', file: 'tests/dangle.spec.ts', liveInspect: false },
      ctxFor(root),
    );
    assert.equal(result.isError, true);
    assert.equal(existsSync(`${outside}/created-by-dangling.spec.ts`), false);
  } finally {
    await rm(link, { force: true });
  }
});

test('generate-e2e-test only overwrites files with its own header', async () => {
  const file = `${root}/tests/hand.spec.ts`;
  const original = "// Generated by playwright-e2e-mcp for: mentioned in a comment\ntest('mine', async () => {});\n";
  await writeFile(file, original);
  const result = await generateE2ETestTool.handler(
    { description: 'clobber', file: 'tests/hand.spec.ts', overwrite: true, liveInspect: false },
    ctxFor(root),
  );
  assert.equal(result.isError, true);
  assert.equal(await readFile(file, 'utf8'), original);
});

function zipWithSharedEntries(count, data) {
  const compressed = deflateRawSync(data);
  const name = Buffer.from('a.trace');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const body = Buffer.concat([local, name, compressed]);
  const centrals = [];
  for (let i = 0; i < count; i += 1) {
    const entryName = Buffer.from(`e${i}.trace`);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(entryName.length, 28);
    central.writeUInt32LE(0, 42); // every entry points at the same local header
    centrals.push(central, entryName);
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, eocd]);
}

test('zip entries sharing one stream are inflated once', () => {
  const entries = readZipEntries(zipWithSharedEntries(50, Buffer.alloc(1024 * 1024, 0x61)));
  assert.equal(entries.size, 1);
});

test('IPv6 forms that embed private IPv4 addresses are blocked', () => {
  for (const address of ['::7f00:1', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::a00:1', '2002:a00:1::1', '2001:0:4136:e378::1', '::ffff:0:7f00:1', 'fec0::1', '100::1']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '::ffff:8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test('scrubbed env drops allowlisted variables that carry URL credentials', () => {
  const saved = { ...process.env };
  try {
    process.env.npm_config_https_proxy = 'http://user:pass@proxy.internal:8080';
    process.env.npm_config_registry = 'https://registry.npmjs.org/';
    setScrubChildEnv(true);
    const env = childEnv();
    assert.equal(env.npm_config_https_proxy, undefined);
    assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/');
  } finally {
    setScrubChildEnv(false);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('the HTTP bridge refuses short tokens and unknown hosts when open', async () => {
  assert.throws(() => createMcpHttpHandler({ token: 'short' }), /at least 16/);
  const open = createMcpHttpHandler({ token: '' });
  const request = (host) =>
    open.fetch(
      new Request(`http://${host}/mcp`, {
        method: 'POST',
        headers: { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );
  assert.equal((await request('rebound.attacker.test')).status, 403);
  assert.equal((await request('localhost:3000')).status, 200);
  const any = createMcpHttpHandler({ token: '', allowedHosts: ['*'] });
  const res = await any.fetch(
    new Request('http://rebound.attacker.test/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(res.status, 200);
});

test('a client that disconnects frees its run slot', async () => {
  const token = 'disconnect-test-token-0123456789';
  const savedRoot = process.env.PW_MCP_PROJECT_ROOT;
  process.env.PW_MCP_PROJECT_ROOT = root;
  process.env.STUB_HANG = '1';
  process.env.PW_MCP_PASSTHROUGH_ENV = 'STUB_HANG';
  await rm(`${root}/argv.json`, { force: true });
  const handler = createMcpHttpHandler({ token, allowedHosts: ['*'] });
  const server = http.createServer((req, res) => void handleNodeRequest(handler, req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const controller = new AbortController();
    const call = fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run-test', arguments: { testFiles: ['tests/a.spec.ts'] } } }),
    }).catch(() => undefined);
    // Wait until the stub CLI is running, then hang up.
    for (let i = 0; i < 100 && !existsSync(`${root}/argv.json`); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(`${root}/argv.json`), 'run should have started');
    controller.abort();
    await call;
    await new Promise((r) => setTimeout(r, 1_500));
    assert.equal(killActiveChildren(), 0, 'the aborted run must already be gone');
  } finally {
    killActiveChildren();
    await new Promise((resolve) => server.close(resolve));
    await handler.close().catch(() => undefined);
    delete process.env.STUB_HANG;
    delete process.env.PW_MCP_PASSTHROUGH_ENV;
    if (savedRoot === undefined) delete process.env.PW_MCP_PROJECT_ROOT;
    else process.env.PW_MCP_PROJECT_ROOT = savedRoot;
    setScrubChildEnv(false);
    await rm(`${root}/argv.json`, { force: true });
  }
});
