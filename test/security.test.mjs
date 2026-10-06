/**
 * Regression tests for the sandbox and code-generation hardening: a caller
 * must not be able to pick a project root outside the configured one,
 * escape it through a symlink, smuggle path-taking Playwright flags,
 * overwrite non-generated files, or inject code into a generated spec.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createToolStore, resolveProjectRoot } from '../dist/tools/shared.js';
import { generateE2ETestTool } from '../dist/tools/generate-e2e-test.js';
import { normalizePath, sanitizeCliArg } from '../dist/utils/path-utils.js';
import { logger } from '../dist/utils/logger.js';

let base;
let root;
let outside;

before(async () => {
  base = normalizePath(await mkdtemp(path.join(os.tmpdir(), 'pw-mcp-sec-')));
  root = `${base}/project`;
  outside = `${base}/outside`;
  await mkdir(`${root}/tests/sub`, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(`${root}/package.json`, '{"name":"victim"}\n');
  await writeFile(`${root}/tests/hand-written.spec.ts`, "test('mine', async () => {});\n");
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

const ctxFor = (projectRoot) => ({
  logger: logger.child({ tool: 'test' }),
  store: createToolStore(),
  projectRoot,
});

function withAllowedRoots(value, fn) {
  const original = process.env.PW_MCP_ALLOWED_ROOTS;
  if (value === undefined) delete process.env.PW_MCP_ALLOWED_ROOTS;
  else process.env.PW_MCP_ALLOWED_ROOTS = value;
  return fn().finally(() => {
    if (original === undefined) delete process.env.PW_MCP_ALLOWED_ROOTS;
    else process.env.PW_MCP_ALLOWED_ROOTS = original;
  });
}

test('projectRoot inside the configured root is accepted', async () => {
  assert.equal(await resolveProjectRoot('tests/sub', ctxFor(root)), `${root}/tests/sub`);
});

test('projectRoot outside the configured root is rejected', async () => {
  await withAllowedRoots(undefined, async () => {
    await assert.rejects(resolveProjectRoot(outside, ctxFor(root)), (err) => err.kind === 'INVALID_PATH');
    await assert.rejects(resolveProjectRoot('../outside', ctxFor(root)), (err) => err.kind === 'INVALID_PATH');
  });
});

test('PW_MCP_ALLOWED_ROOTS opts extra directories in', async () => {
  await withAllowedRoots(outside, async () => {
    assert.equal(await resolveProjectRoot(outside, ctxFor(root)), outside);
  });
});

test('a symlink inside the root that points outside is rejected', async (t) => {
  const link = `${root}/escape`;
  try {
    await symlink(outside, link, 'dir');
  } catch {
    t.skip('symlinks not permitted on this machine');
    return;
  }
  try {
    await assert.rejects(resolveProjectRoot('escape', ctxFor(root)), (err) => err.kind === 'INVALID_PATH');
  } finally {
    await rm(link, { force: true });
  }
});

test('extra CLI args are limited to an allowlist of Playwright flags', () => {
  assert.equal(sanitizeCliArg('--repeat-each=3'), '--repeat-each=3');
  assert.equal(sanitizeCliArg('--update-snapshots'), '--update-snapshots');
  for (const bad of ['--config=/tmp/evil.ts', '-c', '--output=/tmp', '--tsconfig=x', '--reporter=html', '--ui', 'tests/a.spec.ts']) {
    assert.throws(() => sanitizeCliArg(bad), (err) => err.kind === 'INVALID_PATH', bad);
  }
});

async function generate(args) {
  return generateE2ETestTool.handler({ liveInspect: false, ...args }, ctxFor(root));
}

test('generate-e2e-test refuses to write non-spec files', async () => {
  const result = await generate({ description: 'overwrite manifest', file: 'package.json', overwrite: true });
  assert.equal(result.isError, true);
  assert.equal(await readFile(`${root}/package.json`, 'utf8'), '{"name":"victim"}\n');
});

test('generate-e2e-test never overwrites a hand-written spec', async () => {
  const result = await generate({ description: 'clobber', file: 'tests/hand-written.spec.ts', overwrite: true });
  assert.equal(result.isError, true);
  assert.match(await readFile(`${root}/tests/hand-written.spec.ts`, 'utf8'), /mine/);
});

test('generate-e2e-test may overwrite a spec it generated', async () => {
  const first = await generate({ description: 'regenerate me', file: 'tests/regen.spec.ts' });
  assert.notEqual(first.isError, true);
  const second = await generate({ description: 'regenerate me again', file: 'tests/regen.spec.ts', overwrite: true });
  assert.notEqual(second.isError, true);
  assert.match(await readFile(`${root}/tests/regen.spec.ts`, 'utf8'), /regenerate me again/);
});

test('a crafted description cannot inject code into the generated spec', async () => {
  const description = 'x */ globalThis.PWNED = 1; /* \u2028 \' " `';
  const result = await generate({ description, file: 'tests/inject.spec.ts' });
  assert.notEqual(result.isError, true);
  const spec = await readFile(`${root}/tests/inject.spec.ts`, 'utf8');
  // Replace the Playwright import so the module can run standalone, then
  // execute it: the payload must stay inert text.
  const runnable = spec.replace(
    "import { test, expect } from '@playwright/test';",
    'const test = (_n, fn) => typeof fn === "function" && undefined; test.describe = (_n, fn) => fn(); const expect = () => ({});',
  );
  await writeFile(`${base}/inject-check.mjs`, `${runnable}\nconsole.log(globalThis.PWNED === undefined ? 'inert' : 'injected');\n`);
  const run = spawnSync(process.execPath, [`${base}/inject-check.mjs`], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), 'inert');
});
