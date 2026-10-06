/**
 * Cross-platform path handling.
 *
 * Most path logic here is *lexical* (string based, no fs access) so that
 * Windows paths behave correctly when unit tests run on macOS/Linux and
 * vice versa. Backslashes are normalized everywhere, drive letters and
 * UNC prefixes are preserved, and user-supplied paths are sandboxed to
 * the project root to block "../../etc/passwd" style escapes.
 * realPathLenient / assertRealPathInside add the symlink-aware check.
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlaywrightMcpError } from '../types/index.js';

const DRIVE_RE = /^[a-zA-Z]:\//;
/** Schemes like http:// — two+ chars so "C://" (drive) is not caught. */
const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]+:\/\//;

const TEST_FILE_RE = /\.(spec|test)\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/i;

/** Replace backslashes with slashes, collapsing duplicate separators. */
export function normalizeSeparators(p: string): string {
  const slashed = p.replace(/\\/g, '/');
  const isUnc = slashed.startsWith('//');
  const collapsed = slashed.replace(/\/{2,}/g, '/');
  if (isUnc && !DRIVE_RE.test(collapsed)) return `/${collapsed}`;
  return collapsed;
}

/** True when the path is Windows-style (drive letter or UNC). */
export function isWindowsPath(p: string): boolean {
  const s = normalizeSeparators(p);
  return DRIVE_RE.test(s) || s.startsWith('//');
}

function isCaseInsensitive(p: string): boolean {
  const s = normalizeSeparators(p);
  return DRIVE_RE.test(s) || s.startsWith('//');
}

/** True for absolute paths on either platform (/, C:/ or //unc). */
export function isAbsolutePath(p: string): boolean {
  const s = normalizeSeparators(p);
  return s.startsWith('/') || DRIVE_RE.test(s);
}

/**
 * Normalize separators and collapse `.` / `..` segments lexically.
 * Leading `..` on relative paths is preserved; escapes above an absolute
 * root (/, C:/, //server) are dropped.
 */
export function normalizePath(p: string): string {
  const s = normalizeSeparators(p);

  let root = '';
  let rest = s;
  if (DRIVE_RE.test(s)) {
    root = s.slice(0, 3); // "C:/"
    rest = s.slice(3);
  } else if (s.startsWith('//')) {
    root = '//';
    rest = s.slice(2);
  } else if (s.startsWith('/')) {
    root = '/';
    rest = s.slice(1);
  }

  const out: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const top = out[out.length - 1];
      if (out.length > 0 && top !== '..') {
        out.pop();
      } else if (root === '') {
        out.push('..');
      }
      continue;
    }
    out.push(segment);
  }

  return root + out.join('/');
}

/** Resolve `target` against `base` (both normalized lexically). */
export function resolvePath(base: string, target: string): string {
  const normalizedTarget = normalizePath(target);
  if (isAbsolutePath(normalizedTarget)) return normalizedTarget;
  const normalizedBase = normalizePath(base);
  if (normalizedBase === '') return normalizedPathJoin(normalizedTarget);
  return normalizePath(`${normalizedBase}/${normalizedTarget}`);
}

function normalizedPathJoin(p: string): string {
  return p === '' ? '.' : p;
}

/** Lexical containment check (case-insensitive for drive/UNC paths). */
export function isPathInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === '' || p === '') return false;
  const insensitive = isCaseInsensitive(c) || isCaseInsensitive(p);
  const cc = insensitive ? c.toLowerCase() : c;
  const pp = insensitive ? p.toLowerCase() : p;
  if (cc === pp) return true;
  const prefix = pp.endsWith('/') ? pp : `${pp}/`;
  return cc.startsWith(prefix);
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return os.homedir() + p.slice(1);
  }
  return p;
}

/** True when any segment of `p` starts with '-' (it could be parsed as a CLI option). */
export function hasOptionLikeSegment(p: string): boolean {
  return normalizeSeparators(p)
    .split('/')
    .some((segment) => segment.startsWith('-'));
}

/**
 * Sandbox a user-supplied path to the project root.
 *
 * Accepts relative or absolute inputs, expands `~`, normalizes
 * separators, then verifies the result stays inside `projectRoot`.
 * Throws PlaywrightMcpError(INVALID_PATH) for traversal escapes,
 * absolute paths outside the root, URLs, null bytes, and empty values.
 *
 * @returns Normalized absolute path with forward slashes.
 */
export function sanitizeUserPath(input: unknown, projectRoot: string): string {
  if (typeof input !== 'string') {
    throw new PlaywrightMcpError('Path must be a string', 'INVALID_PATH', {
      hint: 'Pass a path relative to the project root, e.g. "tests/login.spec.ts".',
    });
  }
  const raw = input.trim();
  if (raw === '') {
    throw new PlaywrightMcpError('Path must not be empty', 'INVALID_PATH', {
      hint: 'Pass a path relative to the project root, e.g. "tests/login.spec.ts".',
    });
  }
  if (raw.includes('\0')) {
    throw new PlaywrightMcpError('Path contains a null byte', 'INVALID_PATH', {
      hint: 'Remove null bytes from the path.',
    });
  }
  if (URL_RE.test(raw)) {
    throw new PlaywrightMcpError(`"${raw}" looks like a URL, not a filesystem path`, 'INVALID_PATH', {
      hint: 'Pass a local path relative to the project root.',
    });
  }

  const root = normalizePath(projectRoot);
  if (!isAbsolutePath(root)) {
    throw new PlaywrightMcpError(`Project root must be absolute, got "${projectRoot}"`, 'INVALID_PATH');
  }

  const expanded = normalizePath(expandHome(raw));
  const resolved = resolvePath(root, expanded);

  if (!isPathInside(resolved, root)) {
    throw new PlaywrightMcpError(`Path "${raw}" resolves outside the project root`, 'INVALID_PATH', {
      hint: `Only paths inside ${root} are allowed. Directory traversal (..) and absolute paths outside the project are rejected.`,
      details: `resolved=${resolved}`,
    });
  }
  // Checked below the root only, so a root that itself has such a segment still works.
  if (hasOptionLikeSegment(relativeToRoot(root, resolved))) {
    throw new PlaywrightMcpError(`Path "${raw}" has a segment starting with "-"`, 'INVALID_PATH', {
      hint: 'Path segments may not start with "-": the path could be read as a command-line option.',
    });
  }
  return resolved;
}

/** Convert a normalized path to the host platform's native form. */
export function toNativePath(p: string): string {
  const normalized = normalizePath(p);
  return process.platform === 'win32' ? path.win32.normalize(normalized) : path.posix.normalize(normalized);
}

/** Always-forward-slash form (used in messages and tool output). */
export function toPosixPath(p: string): string {
  return normalizePath(p);
}

/** Path of `p` relative to `root`, posix style; absolute if not inside. */
export function relativeToRoot(root: string, p: string): string {
  const r = normalizePath(root);
  const c = normalizePath(p);
  if (!isPathInside(c, r)) return c;
  if (c === r) return '';
  const base = r.endsWith('/') ? r : `${r}/`;
  return c.slice(base.length);
}

/** Build an absolute path under the project root. */
export function joinProjectPath(root: string, ...segments: string[]): string {
  return resolvePath(root, segments.join('/'));
}

/** A unique path inside the OS temp dir (used for JSON reports). */
export function tempFilePath(prefix: string, extension = '.json'): string {
  const unique = `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
  return normalizePath(path.join(os.tmpdir(), `${prefix}-${unique}${extension}`));
}

/** True when a filename looks like a Playwright test/spec file. */
export function isTestFile(p: string): boolean {
  return TEST_FILE_RE.test(normalizeSeparators(p));
}

/** How a pass-through flag's value is checked; `null` means the flag takes no value. */
type FlagValueCheck = null | { optional?: boolean; test: (value: string) => boolean; describe: string };

const intIn = (min: number, max: number) => (value: string) =>
  /^\d+$/.test(value) && Number(value) >= min && Number(value) <= max;
const oneOf = (...values: string[]) => (value: string) => values.includes(value);
/** No leading '-' (would be read as another option), no control characters. */
const plainText = (value: string) => value !== '' && !value.startsWith('-') && !/[\x00-\x1f\x7f]/.test(value);

/**
 * Playwright CLI flags callers may pass through `args`, each with the only
 * values it accepts. Anything that points Playwright at another file or
 * directory (--config, --output, --tsconfig, --reporter…), blocks the run
 * (--ui, --debug) or hands a value to another program unchecked is absent.
 * Value-taking flags must use `--flag=value`, so a bare flag can never
 * swallow the arguments appended after it.
 */
const ALLOWED_CLI_FLAGS = new Map<string, FlagValueCheck>([
  ['--headed', null],
  ['-x', null],
  ['--fail-on-flaky-tests', null],
  ['--forbid-only', null],
  ['--fully-parallel', null],
  ['--pass-with-no-tests', null],
  ['--quiet', null],
  ['--ignore-snapshots', null],
  ['--no-deps', null],
  ['--list', null],
  ['--project', { test: (v) => plainText(v) && /^[\w .@:+/-]+$/.test(v), describe: 'a project name' }],
  ['--repeat-each', { test: intIn(1, 100), describe: 'an integer 1-100' }],
  ['--max-failures', { test: intIn(0, 1000), describe: 'an integer 0-1000' }],
  ['--global-timeout', { test: intIn(0, 3_600_000), describe: 'milliseconds, at most 3600000' }],
  ['--timeout', { test: intIn(0, 3_600_000), describe: 'milliseconds, at most 3600000' }],
  ['--retries', { test: intIn(0, 10), describe: 'an integer 0-10' }],
  ['--workers', { test: (v) => intIn(1, 64)(v) || /^([1-9]\d?|100)%$/.test(v), describe: '1-64 or a percentage' }],
  ['-j', { test: (v) => intIn(1, 64)(v) || /^([1-9]\d?|100)%$/.test(v), describe: '1-64 or a percentage' }],
  ['--shard', { test: (v) => /^[1-9]\d{0,3}\/[1-9]\d{0,3}$/.test(v), describe: 'current/total, e.g. 1/3' }],
  ['--grep-invert', { test: plainText, describe: 'a pattern not starting with "-"' }],
  [
    '--trace',
    {
      test: oneOf('on', 'off', 'on-first-retry', 'on-all-retries', 'retain-on-failure', 'retain-on-first-failure', 'retain-on-failure-and-retries'),
      describe: 'a Playwright trace mode',
    },
  ],
  ['--update-snapshots', { optional: true, test: oneOf('all', 'changed', 'missing', 'none'), describe: 'all, changed, missing or none' }],
  ['-u', { optional: true, test: oneOf('all', 'changed', 'missing', 'none'), describe: 'all, changed, missing or none' }],
  // The value is handed to `git diff`, so it must be a plain ref, never an option.
  [
    '--only-changed',
    { optional: true, test: (v) => /^[A-Za-z0-9._/~^@{}][A-Za-z0-9._/~^@{}-]*$/.test(v) && v.length <= 200, describe: 'a git ref' },
  ],
]);

/**
 * Validate one extra Playwright CLI argument: only flags from
 * ALLOWED_CLI_FLAGS get through, in `--flag` or `--flag=value` form, and
 * each value must pass that flag's check.
 */
export function sanitizeCliArg(arg: string): string {
  const raw = typeof arg === 'string' ? arg.trim() : '';
  if (raw === '') {
    throw new PlaywrightMcpError('Argument must not be empty', 'INVALID_PATH');
  }
  if (/[\0;&|><`$]/.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) {
    throw new PlaywrightMcpError(`Argument "${raw}" contains forbidden characters`, 'INVALID_PATH', {
      hint: 'Arguments are executed directly (no shell); remove control characters and ; & | > < ` $.',
    });
  }
  const eq = raw.indexOf('=');
  const flag = eq === -1 ? raw : raw.slice(0, eq);
  const value = eq === -1 ? undefined : raw.slice(eq + 1);
  if (!ALLOWED_CLI_FLAGS.has(flag)) {
    throw new PlaywrightMcpError(`Argument "${raw}" is not an allowed Playwright flag`, 'INVALID_PATH', {
      hint: `Allowed flags: ${[...ALLOWED_CLI_FLAGS.keys()].join(', ')}. Pass test files via testFiles and the config via config.`,
    });
  }
  const check = ALLOWED_CLI_FLAGS.get(flag) ?? null;
  if (check === null) {
    if (value !== undefined) {
      throw new PlaywrightMcpError(`Flag "${flag}" does not take a value`, 'INVALID_PATH');
    }
    return raw;
  }
  if (value === undefined) {
    if (check.optional) return raw;
    throw new PlaywrightMcpError(`Flag "${flag}" needs a value: use ${flag}=<value>`, 'INVALID_PATH', {
      hint: `${flag} takes ${check.describe}.`,
    });
  }
  if (!check.test(value)) {
    throw new PlaywrightMcpError(`Invalid value for ${flag}: "${value}"`, 'INVALID_PATH', {
      hint: `${flag} takes ${check.describe}.`,
    });
  }
  return raw;
}

/**
 * Symlink-resolved form of `p`. When `p` does not exist yet (a file about
 * to be written), its nearest existing ancestor is resolved and the
 * missing tail re-appended, so a symlinked parent directory is still seen.
 */
export async function realPathLenient(p: string): Promise<string> {
  const normalized = normalizePath(p);
  const tail: string[] = [];
  let current = normalized;
  for (;;) {
    try {
      const real = normalizePath(await realpath(toNativePath(current)));
      return tail.length === 0 ? real : normalizePath(`${real}/${tail.reverse().join('/')}`);
    } catch {
      const parent = normalizePath(path.posix.dirname(current));
      if (parent === current || parent === '' || parent === '.') return normalized;
      tail.push(path.posix.basename(current));
      current = parent;
    }
  }
}

/**
 * Write `data` to `target` inside `root` without following a symlink at
 * the final path component (a planted link, even a dangling one, could
 * otherwise redirect the write outside the root). Parent directories are
 * created and re-checked against the root after creation.
 */
export async function writeFileInsideRoot(target: string, data: string | Uint8Array, root: string): Promise<void> {
  const native = toNativePath(target);
  const info = await lstat(native).catch(() => null);
  if (info?.isSymbolicLink()) {
    throw new PlaywrightMcpError(`Refusing to write through a symlink: ${normalizePath(target)}`, 'INVALID_PATH', {
      hint: 'Replace the symlink with a regular file or pick another path.',
    });
  }
  await mkdir(path.dirname(native), { recursive: true });
  await assertRealPathInside(path.posix.dirname(normalizePath(target)), root);
  // O_NOFOLLOW closes the gap between the lstat above and the open (POSIX only).
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(native, flags, 0o644);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/**
 * Filesystem-aware companion to sanitizeUserPath: throws INVALID_PATH when
 * `target`, after resolving symlinks, is not inside `root` (also resolved).
 */
export async function assertRealPathInside(target: string, root: string): Promise<void> {
  const [realTarget, realRoot] = await Promise.all([realPathLenient(target), realPathLenient(root)]);
  if (!isPathInside(realTarget, realRoot)) {
    throw new PlaywrightMcpError(`Path "${normalizePath(target)}" resolves outside the project root`, 'INVALID_PATH', {
      hint: `A symlink points outside ${normalizePath(root)}. Only paths inside the project root are allowed.`,
    });
  }
}
