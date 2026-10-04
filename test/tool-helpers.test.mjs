import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertHttpUrl,
  clipLines,
  createToolStore,
  failureHint,
  formatDuration,
  resolveConfigSelection,
  sanitizeTestPathArgument,
  testPathExists,
  toolError,
  toolText,
} from '../dist/tools/shared.js';
import { normalizePath } from '../dist/utils/path-utils.js';

let root;

before(async () => {
  root = normalizePath(await mkdtemp(path.join(os.tmpdir(), 'pw-mcp-tools-')));
  await writeFile(path.join(root, 'playwright.config.ts'), 'export default {};\n');
  await writeFile(path.join(root, 'playwright.config.js'), 'module.exports = {};\n');
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'a.spec.ts'), "test('a', async () => {});\n");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const detection = (overrides = {}) => ({
  startDir: root,
  root,
  configPath: `${root}/playwright.config.ts`,
  configCandidates: [`${root}/playwright.config.ts`, `${root}/playwright.config.js`],
  hasPlaywright: true,
  playwrightPackage: '@playwright/test',
  playwrightVersion: '1.40.0',
  testDir: null,
  packageManager: 'npm',
  ...overrides,
});

test('resolveConfigSelection asks which config when several exist', () => {
  assert.throws(
    () => resolveConfigSelection(detection()),
    (err) => {
      assert.equal(err.kind, 'MULTIPLE_CONFIGS');
      assert.match(err.hint, /playwright\.config\.ts/);
      assert.match(err.hint, /playwright\.config\.js/);
      return true;
    },
  );
});

test('resolveConfigSelection accepts a 1-based index or a path', () => {
  assert.equal(resolveConfigSelection(detection(), '1'), `${root}/playwright.config.ts`);
  assert.equal(resolveConfigSelection(detection(), '2'), `${root}/playwright.config.js`);
  assert.equal(
    resolveConfigSelection(detection(), 'playwright.config.js'),
    `${root}/playwright.config.js`,
  );
  assert.throws(
    () => resolveConfigSelection(detection(), '7'),
    (err) => err.kind === 'NO_CONFIG',
  );
});

test('resolveConfigSelection handles single and missing configs', () => {
  const single = detection({ configCandidates: [`${root}/playwright.config.ts`] });
  assert.equal(resolveConfigSelection(single), `${root}/playwright.config.ts`);
  assert.equal(resolveConfigSelection(single, undefined), `${root}/playwright.config.ts`);

  const none = detection({ configCandidates: [], configPath: null });
  assert.equal(resolveConfigSelection(none), undefined);
  assert.throws(() => resolveConfigSelection(none, 'playwright.config.ts'), (err) => err.kind === 'NO_CONFIG');
});

test('sanitizeTestPathArgument supports file:line and blocks escapes', async () => {
  assert.equal(
    sanitizeTestPathArgument('tests/a.spec.ts:12', root),
    `${root}/tests/a.spec.ts:12`,
  );
  assert.equal(sanitizeTestPathArgument('tests\\a.spec.ts', root), `${root}/tests/a.spec.ts`);

  assert.throws(
    () => sanitizeTestPathArgument('../../etc/passwd', root),
    (err) => err.kind === 'INVALID_PATH',
  );

  assert.equal(await testPathExists(`${root}/tests/a.spec.ts:12`, root), true);
  assert.equal(await testPathExists('tests/missing.spec.ts', root), false);
});

test('assertHttpUrl accepts http(s) and rejects everything else', () => {
  assert.equal(assertHttpUrl('http://localhost:3000/login'), 'http://localhost:3000/login');
  assert.throws(() => assertHttpUrl('ftp://example.com'), (err) => err.kind === 'INVALID_PATH');
  assert.throws(() => assertHttpUrl('not a url'), (err) => err.kind === 'INVALID_PATH');
});

test('tool responses are well-formed MCP content blocks', () => {
  const ok = toolText('## hello');
  assert.deepEqual(ok.content, [{ type: 'text', text: '## hello' }]);
  assert.equal(ok.isError, undefined);

  const bad = toolError('INVALID_PATH', 'bad path', 'do this instead', 'details here');
  assert.equal(bad.isError, true);
  const text = bad.content[0].text;
  assert.match(text, /INVALID_PATH/);
  assert.match(text, /bad path/);
  assert.match(text, /do this instead/);
  assert.match(text, /details here/);
});

test('tool store keeps only the latest run', () => {
  const store = createToolStore();
  assert.equal(store.lastRun, null);
  const result = { failures: [], ok: true };
  store.setLastRun({ projectRoot: root, result, at: 1 });
  assert.equal(store.lastRun.result, result);
  const newer = { failures: [], ok: false };
  store.setLastRun({ projectRoot: root, result: newer, at: 2 });
  assert.equal(store.lastRun.result, newer);
});

test('formatDuration and clipLines keep output readable', () => {
  assert.equal(formatDuration(500), '500ms');
  assert.equal(formatDuration(4_200), '4.2s');
  assert.equal(formatDuration(125_000), '2m 5s');
  assert.equal(clipLines('a\nb\nc', 5), 'a\nb\nc');
  assert.match(clipLines('a\nb\nc', 2), /1 more line/);
  assert.match(clipLines('a\nb\nc\nd\ne', 2), /3 more lines/);
  assert.ok(clipLines('x'.repeat(500), 10, 50).length <= 51);
});

test('every failure kind maps to an actionable hint', () => {
  for (const kind of [
    'assertion',
    'timeout',
    'browser-crash',
    'syntax',
    'config',
    'server-unreachable',
    'unknown',
  ]) {
    const hint = failureHint(kind);
    assert.ok(hint.length > 20, `hint too short for ${kind}`);
  }
});
