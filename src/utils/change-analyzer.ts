/**
 * Change + selector analysis for the generate-e2e-test tool.
 *
 * "Look at the agent's recent file changes, identify the components,
 * and scaffold a test using the correct selectors" (blueprint). This
 * module answers the first two parts: which files changed (git working
 * tree, last commit, or mtime fallback) and which locators those files
 * actually declare (data-testid, roles, labels, ids…).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizePath, relativeToRoot } from './path-utils.js';

const execFileAsync = promisify(execFile);

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|less|html)$/;
const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'test-results',
  'playwright-report',
  'blob-report',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.turbo',
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SELECTORS = 40;
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type SelectorKind =
  | 'test-id'
  | 'role'
  | 'aria'
  | 'placeholder'
  | 'id'
  | 'name'
  | 'text';

export interface SelectorCandidate {
  kind: SelectorKind;
  /** The raw value (test id, label, role name…). */
  value: string;
  /** Ready-to-paste Playwright locator fragment. */
  locator: string;
  file: string;
  line: number;
}

export interface ChangedFile {
  /** Project-relative posix path. */
  path: string;
  source: 'git' | 'mtime';
}

export interface ChangeAnalysis {
  changeSource: 'git-status' | 'git-last-commit' | 'mtime';
  files: ChangedFile[];
  selectors: SelectorCandidate[];
  scanned: number;
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/* Recent changes                                                      */
/* ------------------------------------------------------------------ */

function cleanPorcelainPath(raw: string): string {
  let p = raw.trim();
  if (p.includes(' -> ')) p = p.split(' -> ').pop() ?? p;
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return normalizePath(p);
}

/** Drop build/vendor paths git may report (e.g. no .gitignore yet). */
function isIgnoredPath(file: string): boolean {
  const segments = file.split('/');
  if (segments.length > 1 && segments.some((segment) => IGNORED_DIRS.has(segment))) return true;
  return segments.slice(0, -1).some((segment) => segment === '.git');
}

async function gitStatusFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-uall', '--untracked-files=all'],
      { cwd: root, timeout: 4_000, maxBuffer: 1024 * 1024 },
    );
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.length > 3)
      .map((line) => cleanPorcelainPath(line.slice(3)));
  } catch {
    return null;
  }
}

async function gitLastCommitFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--name-only', 'HEAD~1'], {
      cwd: root,
      timeout: 4_000,
      maxBuffer: 1024 * 1024,
    });
    const files = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => normalizePath(line));
    return files.length > 0 ? files : null;
  } catch {
    return null;
  }
}

async function recentMtimeFiles(root: string, windowMs: number, limit: number): Promise<string[]> {
  const cutoff = Date.now() - windowMs;
  const found: Array<{ file: string; mtime: number }> = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || found.length > 500) return;
    const entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' }).catch(() => null);
    if (!entries) return;
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        try {
          const info = await stat(full);
          if (info.mtimeMs >= cutoff && info.size <= MAX_FILE_BYTES) {
            found.push({ file: normalizePath(full), mtime: info.mtimeMs });
          }
        } catch {
          /* ignore */
        }
      }
    }
  };

  await walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map((entry) => entry.file);
}

/* ------------------------------------------------------------------ */
/* Selector extraction                                                 */
/* ------------------------------------------------------------------ */

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/** Single-quoted JS string literal; escapes rather than trusting the value. */
function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/[\r\n\u2028\u2029]+/g, ' ');
  return `'${escaped}'`;
}

interface ExtractionPattern {
  kind: SelectorKind;
  re: RegExp;
  toLocator: (match: RegExpExecArray) => string | null;
}

const PATTERNS: ExtractionPattern[] = [
  {
    kind: 'test-id',
    re: /\bdata-testid\s*=\s*["']([^"']{1,80})["']/g,
    toLocator: (m) => `getByTestId(${quote(m[1])})`,
  },
  {
    kind: 'test-id',
    re: /\bdata-(test-id|test|cy)\s*=\s*["']([^"']{1,80})["']/g,
    toLocator: (m) => `locator(${quote(`[data-${m[1]}="${m[2]}"]`)})`,
  },
  {
    kind: 'test-id',
    re: /\bgetByTestId\(\s*["'`]([^"'`]{1,80})["'`]/g,
    toLocator: (m) => `getByTestId(${quote(m[1])})`,
  },
  {
    kind: 'role',
    re: /\bgetByRole\(\s*["'`]([a-zA-Z]+)["'`]\s*,\s*\{\s*name:\s*["'`]([^"'`]{1,80})["'`]/g,
    toLocator: (m) => `getByRole(${quote(m[1])}, { name: ${quote(m[2])} })`,
  },
  {
    kind: 'aria',
    re: /\baria-label\s*=\s*["']([^"']{1,80})["']/g,
    toLocator: (m) => `getByLabel(${quote(m[1])})`,
  },
  {
    kind: 'placeholder',
    re: /\bplaceholder\s*=\s*["']([^"']{1,80})["']/g,
    toLocator: (m) => `getByPlaceholder(${quote(m[1])})`,
  },
  {
    kind: 'id',
    re: /(?<![\w.])id\s*=\s*["']([\w-]{1,60})["']/g,
    toLocator: (m) => `locator(${quote(`#${m[1]}`)})`,
  },
  {
    kind: 'name',
    re: /(?<![\w.])name\s*=\s*["']([\w:-]{1,60})["']/g,
    toLocator: (m) => `locator(${quote(`[name="${m[1]}"]`)})`,
  },
  {
    kind: 'text',
    re: /<(button|a)\b[^>]*>\s*([^<>{}\n]{2,60}?)\s*<\/\1>/g,
    toLocator: (m) =>
      `getByRole(${quote(m[1] === 'a' ? 'link' : 'button')}, { name: ${quote(m[2].trim())} })`,
  },
  {
    kind: 'text',
    re: /\bgetByText\(\s*["'`]([^"'`]{1,80})["'`]/g,
    toLocator: (m) => `getByText(${quote(m[1])})`,
  },
];

/** Extract locators declared in one source file. */
export function extractSelectors(source: string, file: string): SelectorCandidate[] {
  const out: SelectorCandidate[] = [];
  const seen = new Set<string>();
  const bounded = source.length > MAX_FILE_BYTES ? source.slice(0, MAX_FILE_BYTES) : source;

  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(bounded)) !== null) {
      const locator = pattern.toLocator(match);
      if (!locator) continue;
      // The meaningful value is always the pattern's last capture group.
      const value = match[match.length - 1] ?? '';
      if (value === '') continue;
      const key = `${pattern.kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: pattern.kind,
        value,
        locator,
        file,
        line: lineOf(bounded, match.index),
      });
      if (out.length >= MAX_SELECTORS) return out;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export interface AnalyzeOptions {
  /** Max files to read and scan. */
  limit?: number;
  /** mtime window for the non-git fallback. */
  windowMs?: number;
}

export async function analyzeRecentChanges(
  projectRoot: string,
  options: AnalyzeOptions = {},
): Promise<ChangeAnalysis> {
  const root = normalizePath(projectRoot);
  const limit = options.limit ?? 12;

  let changeSource: ChangeAnalysis['changeSource'] = 'mtime';
  let files: string[] | null = (await gitStatusFiles(root))?.filter((file) => !isIgnoredPath(file)) ?? null;
  if (files !== null && files.length === 0) {
    files = (await gitLastCommitFiles(root))?.filter((file) => !isIgnoredPath(file)) ?? null;
    if (files !== null) changeSource = 'git-last-commit';
  } else if (files !== null) {
    changeSource = 'git-status';
  }
  if (files === null) {
    files = (await recentMtimeFiles(root, options.windowMs ?? DEFAULT_WINDOW_MS, limit)).filter(
      (file) => !isIgnoredPath(file),
    );
    changeSource = 'mtime';
  }

  const selectors: SelectorCandidate[] = [];
  const seen = new Set<string>();
  const scanned: string[] = [];
  let truncated = false;

  for (const file of files) {
    if (scanned.length >= limit) {
      truncated = true;
      break;
    }
    const absolute = path.isAbsolute(file) ? file : path.join(root, file);
    let source: string;
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      source = await readFile(absolute, 'utf8');
    } catch {
      continue;
    }
    if (!SOURCE_EXT.test(absolute)) continue;
    scanned.push(relativeToRoot(root, absolute));
    for (const candidate of extractSelectors(source, relativeToRoot(root, absolute))) {
      const key = `${candidate.kind}:${candidate.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      selectors.push(candidate);
      if (selectors.length >= MAX_SELECTORS) {
        truncated = true;
        break;
      }
    }
    if (selectors.length >= MAX_SELECTORS) break;
  }

  return {
    changeSource,
    files: files.map((file) => ({
      path: path.isAbsolute(file) ? relativeToRoot(root, file) : normalizePath(file),
      source: changeSource === 'mtime' ? 'mtime' : 'git',
    })),
    selectors,
    scanned: scanned.length,
    truncated,
  };
}

export interface EntryUrl {
  baseURL?: string;
  webServerUrl?: string;
}

/** Pull `baseURL` / `webServer.url` out of a playwright.config source. */
export function detectEntryUrl(configSource: string): EntryUrl {
  const out: EntryUrl = {};
  const base = /baseURL\s*:\s*["']([^"']{3,200})["']/.exec(configSource);
  if (base) out.baseURL = base[1];
  const server = /\burl\s*:\s*["'](https?:\/\/[^"']{3,200})["']/.exec(configSource);
  if (server) out.webServerUrl = server[1];
  return out;
}
