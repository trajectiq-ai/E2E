/**
 * Project detection: locate playwright.config.*, verify Playwright is
 * installed, identify the package manager, and discover test files.
 *
 * Supports monorepos by walking up to the filesystem root and picking
 * the *nearest* directory containing a Playwright config. When several
 * configs live side by side every candidate is returned so the caller
 * can ask the user which one to use.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PackageManager, ProjectDetection } from '../types/index.js';
import { isTestFile, normalizePath, resolvePath } from './path-utils.js';

const CONFIG_FILES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
] as const;

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.hg',
  '.svn',
  'test-results',
  'playwright-report',
  'blob-report',
  'coverage',
  '.next',
  '.cache',
  '.turbo',
]);

const LOCKFILES: Array<{ file: string; pm: PackageManager }> = [
  { file: 'pnpm-lock.yaml', pm: 'pnpm' },
  { file: 'yarn.lock', pm: 'yarn' },
  { file: 'bun.lockb', pm: 'bun' },
  { file: 'bun.lock', pm: 'bun' },
  { file: 'package-lock.json', pm: 'npm' },
  { file: 'npm-shrinkwrap.json', pm: 'npm' },
];

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(p, 'utf8');
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the starting directory: accepts an existing dir, an existing
 * file (uses its parent), a not-yet-existing path (nearest existing
 * ancestor), and falls back to cwd.
 */
export async function resolveStartDir(input?: string): Promise<string> {
  const candidate = normalizePath(input && input.trim() !== '' ? input : process.cwd());
  if (await isDirectory(candidate)) return candidate;
  if (await isFile(candidate)) return normalizePath(path.dirname(candidate));

  let dir = candidate;
  for (let i = 0; i < 64; i += 1) {
    const parent = normalizePath(path.dirname(dir));
    if (parent === dir) break;
    dir = parent;
    if (await isDirectory(dir)) return dir;
  }
  return normalizePath(process.cwd());
}

async function findPlaywrightInstall(
  dir: string,
): Promise<{ pkg: string; version: string | null } | null> {
  for (const pkg of ['@playwright/test', 'playwright'] as const) {
    const manifest = path.join(dir, 'node_modules', ...pkg.split('/'), 'package.json');
    if (await isFile(manifest)) {
      const json = await readJson(manifest);
      const version = typeof json?.version === 'string' ? json.version : null;
      return { pkg, version };
    }
  }
  return null;
}

async function detectPackageManager(root: string): Promise<PackageManager> {
  for (const { file, pm } of LOCKFILES) {
    if (await isFile(path.join(root, file))) return pm;
  }
  return 'unknown';
}

/**
 * Best-effort `testDir` extraction from the config file source.
 * Handles `testDir: 'tests'` / `testDir: "e2e"` / `testDir: "./tests"`.
 */
async function readTestDir(configPath: string, root: string): Promise<string | null> {
  try {
    const source = await readFile(configPath, 'utf8');
    const match = /testDir\s*:\s*(['"])([^'"]+)\1/.exec(source);
    if (!match) return null;
    const resolved = resolvePath(root, match[2]);
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Detect the Playwright project around `startDir`.
 *
 * Walks upward looking for (in order of precedence) the nearest
 * playwright.config.*, any package.json as a root fallback, and
 * node_modules installs of @playwright/test or playwright.
 */
export async function detectProject(startDir?: string): Promise<ProjectDetection> {
  const start = await resolveStartDir(startDir);

  let packageRoot: string | null = null;
  let playwright: { pkg: string; version: string | null } | null = null;
  let configDir: string | null = null;
  const configCandidates: string[] = [];
  const visited = new Set<string>();

  let dir = start;
  for (let depth = 0; depth < 64; depth += 1) {
    if (visited.has(dir)) break;
    visited.add(dir);

    if (configDir === null) {
      for (const name of CONFIG_FILES) {
        const candidate = path.join(dir, name);
        if (await isFile(candidate)) {
          configDir = dir;
          configCandidates.push(normalizePath(candidate));
        }
      }
    }

    if (packageRoot === null && (await isFile(path.join(dir, 'package.json')))) {
      packageRoot = dir;
    }

    if (playwright === null) {
      playwright = await findPlaywrightInstall(dir);
    }

    const parent = normalizePath(path.dirname(dir));
    if (parent === dir) break;
    dir = parent;
  }

  const root = normalizePath(configDir ?? packageRoot ?? start);
  const configPath = configCandidates[0] ?? null;
  const testDir = configPath ? await readTestDir(configPath, root) : null;
  const packageManager = await detectPackageManager(root);

  return {
    startDir: start,
    root,
    configPath,
    configCandidates,
    hasPlaywright: playwright !== null,
    playwrightPackage: playwright?.pkg ?? null,
    playwrightVersion: playwright?.version ?? null,
    testDir,
    packageManager,
  };
}

/** Pick a config by 1-based index or exact path from the candidates list. */
export function selectConfig(candidates: string[], selection?: string | number): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (typeof selection === 'number') {
    const index = selection - 1;
    return index >= 0 && index < candidates.length ? candidates[index] : null;
  }
  if (typeof selection === 'string' && selection.trim() !== '') {
    const wanted = normalizePath(selection).toLowerCase();
    const hit = candidates.find(
      (c) => c.toLowerCase() === wanted || normalizePath(c).endsWith(`/${wanted}`),
    );
    return hit ?? null;
  }
  return null;
}

/** Install instructions for a project where Playwright is missing. */
export function missingPlaywrightMessage(detection: ProjectDetection): {
  message: string;
  hint: string;
} {
  const install =
    detection.packageManager === 'pnpm'
      ? 'pnpm add -D @playwright/test'
      : detection.packageManager === 'yarn'
        ? 'yarn add -D @playwright/test'
        : detection.packageManager === 'bun'
          ? 'bun add -d @playwright/test'
          : 'npm install -D @playwright/test';
  const browsers =
    detection.packageManager === 'unknown'
      ? 'npx playwright install'
      : `${detection.packageManager === 'npm' ? 'npx' : detection.packageManager} playwright install`;
  return {
    message: 'Playwright is not installed in this project (no @playwright/test or playwright found in node_modules).',
    hint: `Run:\n  ${install}\n  ${browsers}\nthen retry.`,
  };
}

export interface FindTestFilesOptions {
  /** Scan only this directory (already validated to be inside the root). */
  testDir?: string | null;
  maxDepth?: number;
  limit?: number;
}

/**
 * Recursively find Playwright spec files under `root`, skipping
 * node_modules/build/report directories. Returns sorted, project-relative
 * posix paths.
 */
export async function findTestFiles(
  root: string,
  options: FindTestFilesOptions = {},
): Promise<string[]> {
  const normalizedRoot = normalizePath(root);
  const startDir = options.testDir ? normalizePath(options.testDir) : normalizedRoot;
  const maxDepth = options.maxDepth ?? 8;
  const limit = options.limit ?? 1000;
  const results: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || results.length >= limit) return;
    const entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' }).catch(() => null);
    if (entries === null) return;
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (results.length >= limit) return;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile() && isTestFile(entry.name)) {
        const relative = full.slice(normalizedRoot.endsWith('/') ? normalizedRoot.length : normalizedRoot.length + 1);
        results.push(normalizePath(relative));
      }
    }
  };

  if (await isDirectory(startDir)) {
    await walk(startDir, 0);
  }
  return results.sort((a, b) => a.localeCompare(b));
}
