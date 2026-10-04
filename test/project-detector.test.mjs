import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectProject,
  findTestFiles,
  missingPlaywrightMessage,
  resolveStartDir,
  selectConfig,
} from '../dist/utils/project-detector.js';
import { normalizePath } from '../dist/utils/path-utils.js';

let basic; // config + fake @playwright/test + pnpm lock + e2e dir
let multi; // two configs side by side
let bare; // package.json only, no Playwright

async function write(rel, content) {
  const target = path.join(basic, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

before(async () => {
  basic = normalizePath(await mkdtemp(path.join(os.tmpdir(), 'pw-mcp-basic-')));
  multi = normalizePath(await mkdtemp(path.join(os.tmpdir(), 'pw-mcp-multi-')));
  bare = normalizePath(await mkdtemp(path.join(os.tmpdir(), 'pw-mcp-bare-')));

  // basic fixture
  await writeFile(path.join(basic, 'package.json'), JSON.stringify({ name: 'basic' }));
  await writeFile(path.join(basic, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(path.join(basic, 'playwright.config.ts'), "export default { testDir: './e2e' };\n");
  await mkdir(path.join(basic, 'node_modules', '@playwright', 'test'), { recursive: true });
  await writeFile(
    path.join(basic, 'node_modules', '@playwright', 'test', 'package.json'),
    JSON.stringify({ name: '@playwright/test', version: '1.40.0' }),
  );
  await write('e2e/login.spec.ts', "test('login', async () => {});\n");
  await write('e2e/nested/deep.test.ts', "test('deep', async () => {});\n");
  await write('e2e/helper.ts', 'export const x = 1;\n');
  await write('node_modules/pkg/index.spec.ts', "test('should be ignored', async () => {});\n");
  await write('test-results/ignore.spec.ts', "test('should be ignored', async () => {});\n");
  await write('dist/bundle.spec.js', "test('should be ignored', async () => {});\n");

  // multi fixture
  await writeFile(path.join(multi, 'package.json'), JSON.stringify({ name: 'multi' }));
  await writeFile(path.join(multi, 'playwright.config.ts'), 'export default {};\n');
  await writeFile(path.join(multi, 'playwright.config.js'), 'module.exports = {};\n');

  // bare fixture
  await writeFile(path.join(bare, 'package.json'), JSON.stringify({ name: 'bare' }));
});

after(async () => {
  for (const dir of [basic, multi, bare]) {
    await rm(dir, { recursive: true, force: true });
  }
});

test('detectProject walks up and finds config, version, testDir and package manager', async () => {
  const start = path.join(basic, 'e2e', 'nested');
  const detection = await detectProject(start);

  assert.equal(detection.root, basic);
  assert.equal(detection.configPath, `${basic}/playwright.config.ts`);
  assert.deepEqual(detection.configCandidates, [`${basic}/playwright.config.ts`]);
  assert.equal(detection.hasPlaywright, true);
  assert.equal(detection.playwrightPackage, '@playwright/test');
  assert.equal(detection.playwrightVersion, '1.40.0');
  assert.equal(detection.testDir, `${basic}/e2e`);
  assert.equal(detection.packageManager, 'pnpm');
});

test('detectProject returns every candidate config side by side', async () => {
  const detection = await detectProject(multi);
  assert.equal(detection.configCandidates.length, 2);
  assert.ok(detection.configCandidates.includes(`${multi}/playwright.config.ts`));
  assert.ok(detection.configCandidates.includes(`${multi}/playwright.config.js`));
  assert.equal(detection.configPath, `${multi}/playwright.config.ts`);
});

test('detectProject reports a clear "no Playwright" state for plain folders', async () => {
  const detection = await detectProject(bare);
  assert.equal(detection.configPath, null);
  assert.equal(detection.configCandidates.length, 0);
  assert.equal(detection.hasPlaywright, false);
  assert.equal(detection.playwrightPackage, null);
  assert.equal(detection.playwrightVersion, null);
  assert.equal(detection.root, bare);
  assert.equal(detection.packageManager, 'unknown');

  const { message, hint } = missingPlaywrightMessage(detection);
  assert.match(message, /Playwright is not installed/i);
  assert.match(hint, /npm install -D @playwright\/test/);
  assert.match(hint, /npx playwright install/);

  const pnpm = missingPlaywrightMessage({ ...detection, packageManager: 'pnpm' });
  assert.match(pnpm.hint, /pnpm add -D @playwright\/test/);
});

test('resolveStartDir accepts dirs, files and unknown paths', async () => {
  assert.equal(await resolveStartDir(path.join(basic, 'e2e', 'nested')), `${basic}/e2e/nested`);
  assert.equal(await resolveStartDir(path.join(basic, 'playwright.config.ts')), basic);
  const unknown = await resolveStartDir(path.join(basic, 'does', 'not', 'exist'));
  assert.equal(unknown, basic);
  assert.equal(await resolveStartDir(undefined), normalizePath(process.cwd()));
});

test('selectConfig picks by index or by path', async () => {
  const candidates = [`${multi}/playwright.config.ts`, `${multi}/playwright.config.js`];
  assert.equal(selectConfig(candidates, 1), candidates[0]);
  assert.equal(selectConfig(candidates, 2), candidates[1]);
  assert.equal(selectConfig(candidates, 9), null);
  assert.equal(selectConfig(candidates, 'playwright.config.js'), candidates[1]);
  assert.equal(selectConfig(candidates, 'missing.config.ts'), null);
  // Single-candidate projects ignore the selection entirely.
  assert.equal(selectConfig([candidates[0]]), candidates[0]);
  assert.equal(selectConfig([]), null);
});

test('findTestFiles scans test files and skips build/vendor/result dirs', async () => {
  const files = await findTestFiles(basic, { testDir: `${basic}/e2e` });
  assert.deepEqual(files, ['e2e/login.spec.ts', 'e2e/nested/deep.test.ts']);

  const fromRoot = await findTestFiles(basic);
  assert.deepEqual(fromRoot, ['e2e/login.spec.ts', 'e2e/nested/deep.test.ts']);
  assert.ok(!fromRoot.some((f) => f.includes('node_modules')));
  assert.ok(!fromRoot.some((f) => f.includes('test-results')));
  assert.ok(!fromRoot.some((f) => f.startsWith('dist/')));

  const limited = await findTestFiles(basic, { limit: 1 });
  assert.equal(limited.length, 1);
});
