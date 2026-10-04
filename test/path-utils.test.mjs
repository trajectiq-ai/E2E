import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  normalizePath,
  normalizeSeparators,
  isAbsolutePath,
  isWindowsPath,
  isPathInside,
  resolvePath,
  relativeToRoot,
  sanitizeUserPath,
  sanitizeCliArg,
  toPosixPath,
  isTestFile,
  joinProjectPath,
  tempFilePath,
} from '../dist/utils/path-utils.js';

test('normalizePath collapses Windows backslash paths with . and ..', () => {
  assert.equal(
    normalizePath('C:\\Users\\dev\\..\\proj\\tests\\a.spec.ts'),
    'C:/Users/proj/tests/a.spec.ts',
  );
  assert.equal(normalizePath('D:/work/./app\\..\\e2e\\login.spec.ts'), 'D:/work/e2e/login.spec.ts');
  assert.equal(normalizePath('C:\\'), 'C:/');
  assert.equal(normalizePath('C:\\proj\\'), 'C:/proj');
});

test('normalizePath handles macOS/POSIX paths', () => {
  assert.equal(
    normalizePath('/Users/mac/dev/../app/tests/a.spec.ts'),
    '/Users/mac/app/tests/a.spec.ts',
  );
  assert.equal(normalizePath('/Users/mac/./app//tests///a.spec.ts'), '/Users/mac/app/tests/a.spec.ts');
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath('../../rel/path'), '../../rel/path');
});

test('normalizePath preserves UNC prefixes and drive roots', () => {
  assert.equal(normalizePath('\\\\server\\share\\..\\x'), '//server/x');
  assert.equal(normalizePath('//server/share/folder'), '//server/share/folder');
  // Escapes above the root are dropped, not climbing out of C:/
  assert.equal(normalizePath('C:/proj/../../evil'), 'C:/evil');
  assert.equal(normalizePath('/../etc/passwd'), '/etc/passwd');
});

test('normalizeSeparators and platform detection', () => {
  assert.equal(normalizeSeparators('a\\b\\\\c'), 'a/b/c');
  assert.equal(isWindowsPath('C:\\x'), true);
  assert.equal(isWindowsPath('\\\\srv\\share'), true);
  assert.equal(isWindowsPath('/Users/mac/x'), false);
  assert.equal(isAbsolutePath('C:/x'), true);
  assert.equal(isAbsolutePath('C:x'), false);
  assert.equal(isAbsolutePath('/x'), true);
  assert.equal(isAbsolutePath('rel/x'), false);
});

test('resolvePath joins against a base on either platform', () => {
  assert.equal(resolvePath('C:/proj', 'tests\\a.spec.ts'), 'C:/proj/tests/a.spec.ts');
  assert.equal(resolvePath('/Users/mac/proj', 'tests/a.spec.ts'), '/Users/mac/proj/tests/a.spec.ts');
  assert.equal(resolvePath('/Users/mac/proj', '/abs/file.ts'), '/abs/file.ts');
  assert.equal(resolvePath('C:/proj', '../outside.ts'), 'C:/outside.ts');
  assert.equal(joinProjectPath('/app', 'tests', 'b.spec.ts'), '/app/tests/b.spec.ts');
});

test('isPathInside is case-insensitive for Windows drive paths', () => {
  assert.equal(isPathInside('C:/proj/tests/a.ts', 'C:/proj'), true);
  assert.equal(isPathInside('c:/PROJ/tests/a.ts', 'C:/proj'), true);
  assert.equal(isPathInside('C:/projother/a.ts', 'C:/proj'), false);
  assert.equal(isPathInside('C:/proj', 'C:/proj'), true);
  assert.equal(isPathInside('/etc/passwd', '/home/user'), false);
  assert.equal(isPathInside('/home/user/proj/x.ts', '/home/user/proj'), true);
  assert.equal(isPathInside('/home/userEvil/x.ts', '/home/user'), false);
});

test('relativeToRoot produces posix-relative paths', () => {
  assert.equal(relativeToRoot('C:/proj', 'C:/proj\\tests\\a.spec.ts'), 'tests/a.spec.ts');
  assert.equal(relativeToRoot('/app', '/app/tests/a.spec.ts'), 'tests/a.spec.ts');
  assert.equal(relativeToRoot('/app', '/other/x.ts'), '/other/x.ts');
  assert.equal(toPosixPath('a\\b'), 'a/b');
});

test('sanitizeUserPath blocks traversal, absolute escapes, URLs and null bytes', () => {
  const root = '/home/user/project';
  for (const evil of [
    '../../etc/passwd',
    '..\\..\\windows\\system32',
    '/etc/passwd',
    'C:\\Windows\\System32\\config\\SAM',
    'https://evil.example/x',
    '',
    '   ',
    'a\0b',
  ]) {
    assert.throws(
      () => sanitizeUserPath(evil, root),
      (err) => err.kind === 'INVALID_PATH',
      `expected rejection for ${JSON.stringify(evil)}`,
    );
  }
});

test('sanitizeUserPath accepts and normalizes safe paths', () => {
  assert.equal(sanitizeUserPath('tests\\a.spec.ts', 'C:/proj'), 'C:/proj/tests/a.spec.ts');
  assert.equal(sanitizeUserPath('./tests/b.spec.ts', '/app'), '/app/tests/b.spec.ts');
  assert.equal(sanitizeUserPath('tests/./c.spec.ts', '/app'), '/app/tests/c.spec.ts');
  // An absolute path that IS inside the root is allowed.
  assert.equal(sanitizeUserPath('/app/tests/d.spec.ts', '/app'), '/app/tests/d.spec.ts');
  // The root itself is allowed.
  assert.equal(sanitizeUserPath('.', '/app'), '/app');
  // Non-string inputs are rejected.
  assert.throws(() => sanitizeUserPath(undefined, '/app'), (err) => err.kind === 'INVALID_PATH');
  assert.throws(() => sanitizeUserPath(42, '/app'), (err) => err.kind === 'INVALID_PATH');
});

test('sanitizeCliArg rejects shell metacharacters but allows regex-ish args', () => {
  assert.equal(sanitizeCliArg('--headed'), '--headed');
  assert.equal(sanitizeCliArg('--project=chromium'), '--project=chromium');
  for (const evil of ['a;rm -rf /', 'a && whoami', 'a | cat', 'a > out', 'a`id`', 'a$(id)', '']) {
    assert.throws(() => sanitizeCliArg(evil), (err) => err.kind === 'INVALID_PATH');
  }
});

test('isTestFile recognizes Playwright spec names and nothing else', () => {
  assert.equal(isTestFile('tests/login.spec.ts'), true);
  assert.equal(isTestFile('tests/login.test.js'), true);
  assert.equal(isTestFile('tests/login.spec.tsx'), true);
  assert.equal(isTestFile('src/tests/deep.e2e.ts'), false);
  assert.equal(isTestFile('src/components/Button.tsx'), false);
  assert.equal(isTestFile('README.md'), false);
});

test('tempFilePath creates unique paths inside the OS temp dir', () => {
  const a = tempFilePath('pw-report');
  const b = tempFilePath('pw-report');
  assert.notEqual(a, b);
  assert.ok(a.includes('pw-report-'));
  assert.ok(a.endsWith('.json'));
  const tmp = normalizePath(os.tmpdir());
  assert.equal(isPathInside(a, tmp), true);
  assert.equal(isPathInside(b, tmp), true);
});
