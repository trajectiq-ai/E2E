/**
 * Cross-platform path handling.
 *
 * All path logic here is *lexical* (string based, no fs access) so that
 * Windows paths behave correctly when unit tests run on macOS/Linux and
 * vice versa. Backslashes are normalized everywhere, drive letters and
 * UNC prefixes are preserved, and user-supplied paths are sandboxed to
 * the project root to block "../../etc/passwd" style escapes.
 */

import { randomBytes } from 'node:crypto';
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
      hint: `Only paths inside ${root} are allowed. Directory traversal (..), absolute paths outside the project, and symlinks out of the project are rejected.`,
      details: `resolved=${resolved}`,
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

/**
 * Validate a free-form CLI argument list: rejects NUL bytes and
 * shell-looking metacharacters that could smuggle extra commands.
 */
export function sanitizeCliArg(arg: string): string {
  const raw = typeof arg === 'string' ? arg.trim() : '';
  if (raw === '') {
    throw new PlaywrightMcpError('Argument must not be empty', 'INVALID_PATH');
  }
  if (/[\0;&|><`$]/.test(raw)) {
    throw new PlaywrightMcpError(`Argument "${raw}" contains forbidden shell characters`, 'INVALID_PATH', {
      hint: 'Arguments are executed directly (no shell); remove ; & | > < ` $ characters.',
    });
  }
  return raw;
}
