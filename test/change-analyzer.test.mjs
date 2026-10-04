import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeRecentChanges,
  detectEntryUrl,
  extractSelectors,
} from '../dist/utils/change-analyzer.js';

const execFileAsync = promisify(execFile);

const JSX_SOURCE = `export function LoginForm() {
  return (
    <form data-testid="login-form" aria-label="Sign in" id="login-card">
      <input name="username" placeholder="Enter username" />
      <button type="submit">Sign in</button>
    </form>
  );
}
`;

test('extractSelectors finds locators declared in component source', () => {
  const selectors = extractSelectors(JSX_SOURCE, 'src/LoginForm.tsx');
  const find = (kind, value) => selectors.find((s) => s.kind === kind && s.value === value);

  const testId = find('test-id', 'login-form');
  assert.ok(testId, 'data-testid extracted');
  assert.equal(testId.locator, "getByTestId('login-form')");
  assert.equal(testId.file, 'src/LoginForm.tsx');
  assert.ok(testId.line >= 3);

  assert.equal(find('aria', 'Sign in').locator, "getByLabel('Sign in')");
  assert.equal(find('placeholder', 'Enter username').locator, "getByPlaceholder('Enter username')");
  assert.equal(find('id', 'login-card').locator, "locator('#login-card')");
  assert.equal(find('name', 'username').locator, "locator('[name=\"username\"]')");
  assert.equal(
    find('text', 'Sign in').locator,
    "getByRole('button', { name: 'Sign in' })",
  );
});

test('extractSelectors reads locators already used in test files', () => {
  const source = [
    "test('login', async ({ page }) => {",
    "  await expect(page.getByRole('button', { name: 'Log in' })).toBeVisible();",
    "  await page.getByTestId('nav-bar').click();",
    '});',
  ].join('\n');
  const selectors = extractSelectors(source, 'tests/login.spec.ts');
  assert.ok(selectors.some((s) => s.kind === 'role' && s.value === 'Log in'));
  assert.ok(selectors.some((s) => s.kind === 'test-id' && s.value === 'nav-bar'));
  const role = selectors.find((s) => s.kind === 'role');
  assert.equal(role.line, 2);
});

test('extractSelectors handles data-cy / data-test variants and dedupes', () => {
  const source = '<div data-cy="checkout" data-testid="checkout" data-testid="checkout"></div>';
  const selectors = extractSelectors(source, 'src/Cart.tsx');
  const testIds = selectors.filter((s) => s.kind === 'test-id');
  // data-cy and data-testid both count; duplicates of the same value are dropped.
  assert.deepEqual(
    testIds.map((s) => s.value).sort(),
    ['checkout'],
  );
  assert.equal(testIds.length, 1);
});

test('detectEntryUrl pulls baseURL and webServer url from a config', () => {
  const entry = detectEntryUrl(
    `export default { use: { baseURL: 'http://localhost:4173' }, webServer: { url: 'http://localhost:3000/health' } };`,
  );
  assert.equal(entry.baseURL, 'http://localhost:4173');
  assert.equal(entry.webServerUrl, 'http://localhost:3000/health');
  assert.deepEqual(detectEntryUrl('export default {}'), {});
});

let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pw-changes-'));
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await mkdir(path.join(dir, 'tests'), { recursive: true });
  await writeFile(
    path.join(dir, 'src', 'LoginForm.tsx'),
    JSX_SOURCE,
  );
  await writeFile(
    path.join(dir, 'tests', 'login.spec.ts'),
    "import { test } from '@playwright/test';\ntest('smoke', async ({ page }) => {\n  await page.goto('/');\n});\n",
  );
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture' }));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('analyzeRecentChanges falls back to mtime outside git', async () => {
  const analysis = await analyzeRecentChanges(dir, { limit: 5 });
  assert.equal(analysis.changeSource, 'mtime');
  assert.ok(analysis.files.length >= 2, 'both recently written files listed');
  assert.ok(analysis.files.every((f) => !path.isAbsolute(f.path)), 'paths are project-relative');
  assert.ok(analysis.files.some((f) => f.path === 'src/LoginForm.tsx'));
  assert.equal(analysis.truncated, false);
  assert.ok(analysis.scanned >= 1);

  const testId = analysis.selectors.find((s) => s.kind === 'test-id' && s.value === 'login-form');
  assert.ok(testId, 'component selectors discovered');
  assert.equal(testId.file, 'src/LoginForm.tsx');
  assert.equal(analysis.selectors[0].locator.length > 0, true);
});

test('analyzeRecentChanges uses git status when the project is a repo', async (t) => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'pw-git-'));
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: repo });
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await writeFile(path.join(repo, 'src', 'Button.tsx'), '<button data-testid="save">Save</button>\n');
    await writeFile(path.join(repo, '.gitignore'), 'node_modules/\n');

    const analysis = await analyzeRecentChanges(repo, { limit: 5 });
    assert.equal(analysis.changeSource, 'git-status');
    assert.ok(
      analysis.files.some((f) => f.path === 'src/Button.tsx'),
      'untracked change reported by git status',
    );
    assert.ok(analysis.selectors.some((s) => s.value === 'Save' && s.kind === 'text'));
  } catch (err) {
    if (String(err).includes('ENOENT')) {
      t.skip('git is not installed');
      return;
    }
    throw err;
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
