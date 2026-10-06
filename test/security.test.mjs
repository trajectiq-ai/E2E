/**
 * Regression tests for the sandbox and code-generation hardening: a caller
 * must not be able to pick a project root outside the configured one,
 * escape it through a symlink, smuggle path-taking Playwright flags,
 * overwrite non-generated files, inject code into a generated spec, or
 * (with the SSRF guard on) point the URL tools at a private address.
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
import { assertUrlAllowed, isBlockedAddress, setBlockPrivateUrls } from '../dist/utils/url-policy.js';
import { inspectPageTool } from '../dist/tools/inspect-page.js';
import { childEnv, runProcess, setMaxChildren, setScrubChildEnv } from '../dist/utils/playwright-runner.js';
import { decodePng } from '../dist/utils/image-diff.js';
import { deflateSync } from 'node:zlib';

let base;
let root;
let outside;

/**
 * Environment variables keep whatever casing the OS gave them — Windows
 * names PATH `Path` — but `childEnv()` returns a plain object, where lookups
 * are case-sensitive. Match names case-insensitively so this suite behaves
 * the same on a Git Bash shell (PATH) and a Windows runner (Path).
 */
function envValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

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

test('private, loopback and metadata addresses are recognized', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test('URL tools refuse private addresses only when the guard is on', async () => {
  setBlockPrivateUrls(false);
  await assertUrlAllowed('http://localhost:3000/');
  setBlockPrivateUrls(true);
  try {
    for (const url of ['http://localhost:3000/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.5:8080/']) {
      await assert.rejects(assertUrlAllowed(url), (err) => err.kind === 'INVALID_PATH', url);
    }
    const result = await inspectPageTool.handler({ url: 'http://169.254.169.254/' }, ctxFor(root));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /private or reserved address/);
  } finally {
    setBlockPrivateUrls(false);
  }
});

test('scrubbed child env keeps only allowlisted variables plus opt-ins', () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      PATH: '/usr/bin',
      PLAYWRIGHT_BROWSERS_PATH: '/pw',
      VERCEL_OIDC_TOKEN: 'secret-1',
      MY_SERVICE_KEY: 'secret-2',
      BASE_URL: 'https://app.example',
      PW_MCP_HTTP_TOKEN: 'bridge-token',
      PW_MCP_PASSTHROUGH_ENV: 'BASE_URL, PW_MCP_HTTP_TOKEN',
    });
    setScrubChildEnv(true);
    const env = childEnv({ FORCE_COLOR: '0' });
    assert.equal(envValue(env, 'PATH'), '/usr/bin');
    assert.equal(envValue(env, 'PLAYWRIGHT_BROWSERS_PATH'), '/pw');
    assert.equal(envValue(env, 'BASE_URL'), 'https://app.example');
    assert.equal(envValue(env, 'FORCE_COLOR'), '0');
    for (const name of ['VERCEL_OIDC_TOKEN', 'MY_SERVICE_KEY', 'PW_MCP_HTTP_TOKEN', 'PW_MCP_PASSTHROUGH_ENV']) {
      assert.equal(envValue(env, name), undefined, name);
    }
    setScrubChildEnv(false);
    assert.equal(envValue(childEnv(), 'MY_SERVICE_KEY'), 'secret-2');
  } finally {
    setScrubChildEnv(false);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('the child cap refuses runs beyond the limit', async () => {
  setMaxChildren(1);
  try {
    const slow = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { timeoutMs: 5_000 });
    const refused = await runProcess(process.execPath, ['-e', ''], { timeoutMs: 5_000 });
    assert.equal(refused.spawnError?.code, 'EBUSY');
    assert.equal((await slow).code, 0);
  } finally {
    setMaxChildren(0);
  }
});

function pngWith(width, height, colorType, idat = deflateSync(Buffer.alloc(0))) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    return out; // CRC is not checked by the decoder
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG decoder rejects oversized, malformed and unknown-type images', () => {
  assert.throws(() => decodePng(pngWith(20_000, 1, 6)), /too large/);
  assert.throws(() => decodePng(pngWith(8_000, 8_000, 6)), /too large/);
  assert.throws(() => decodePng(pngWith(1, 1, 5)), /color type 5/);
  const truncated = pngWith(1, 1, 6);
  truncated.writeUInt32BE(0x7fffffff, 8 + 8 + 13 + 4); // IDAT length far past EOF
  assert.throws(() => decodePng(truncated), /overruns/);
  const ok = decodePng(pngWith(1, 1, 6, deflateSync(Buffer.from([0, 1, 2, 3, 4]))));
  assert.deepEqual([...ok.data], [1, 2, 3, 4]);
});

test('every reporter flag is refused as a caller argument', () => {
  for (const bad of ['--reporter=line', '--reporter', '--reporter=json,html']) {
    assert.throws(() => sanitizeCliArg(bad), (err) => err.kind === 'INVALID_PATH', bad);
  }
});
