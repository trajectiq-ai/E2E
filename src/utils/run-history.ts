/**
 * Local run history: every run the server performs appends one line to
 * `<project>/.playwright-e2e-mcp/history.jsonl`, so flakiness and failure
 * patterns can be judged across runs instead of from one red build.
 *
 * Nothing leaves the machine. The folder gets its own `.gitignore` (`*`) so
 * it never lands in a commit, the file is trimmed to MAX_ENTRIES, and
 * PW_MCP_HISTORY=0 turns recording off.
 *
 * The analysis functions are pure (exported for unit tests).
 */

import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { FailureKind, RunTestResult, TestOutcome, TestStatus } from '../types/index.js';
import { PlaywrightMcpError } from '../types/index.js';
import { assertRealPathInside, joinProjectPath, toNativePath, writeFileInsideRoot } from './path-utils.js';

export const HISTORY_DIR = '.playwright-e2e-mcp';
const HISTORY_FILE = 'history.jsonl';
const MAX_ENTRIES = 500;
const MAX_TESTS_PER_ENTRY = 2_000;

export interface HistoryTest {
  file: string;
  title: string;
  project?: string;
  status: TestStatus;
  ms?: number;
  kind?: FailureKind;
  msg?: string;
}

export interface HistoryEntry {
  v: 1;
  at: string;
  source: string;
  command: string;
  ok: boolean;
  durationMs: number;
  stats: { passed: number; failed: number; flaky: number; skipped: number } | null;
  tests: HistoryTest[];
}

export function historyEnabled(): boolean {
  const flag = (process.env.PW_MCP_HISTORY ?? '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off');
}

export function historyPath(root: string): string {
  return joinProjectPath(root, HISTORY_DIR, HISTORY_FILE);
}

export function toHistoryEntry(result: RunTestResult, source: string, at = new Date()): HistoryEntry {
  const tests = (result.outcomes ?? []).slice(0, MAX_TESTS_PER_ENTRY).map((o: TestOutcome) => {
    const test: HistoryTest = { file: o.file, title: o.title, status: o.status };
    if (o.project) test.project = o.project;
    if (o.durationMs !== undefined) test.ms = Math.round(o.durationMs);
    if (o.failureKind) test.kind = o.failureKind;
    if (o.message) test.msg = o.message;
    return test;
  });
  return {
    v: 1,
    at: at.toISOString(),
    source,
    command: result.command,
    ok: result.ok,
    durationMs: result.durationMs,
    stats: result.stats
      ? { passed: result.stats.expected, failed: result.stats.unexpected, flaky: result.stats.flaky, skipped: result.stats.skipped }
      : null,
    tests,
  };
}

/** Append a run to the project's history (no-op when disabled or nothing ran). */
export async function recordRun(root: string, result: RunTestResult, source: string): Promise<boolean> {
  if (!historyEnabled()) return false;
  if (!result.outcomes || result.outcomes.length === 0) return false;
  const dir = joinProjectPath(root, HISTORY_DIR);
  await mkdir(toNativePath(dir), { recursive: true });
  // The folder could be a symlink planted in the project; keep writes inside.
  await assertRealPathInside(dir, root);
  const ignore = joinProjectPath(dir, '.gitignore');
  if (!(await lstat(toNativePath(ignore)).catch(() => null))) {
    await writeFileInsideRoot(ignore, '# Local run history written by playwright-e2e-mcp\n*\n', root);
  }
  const file = historyPath(root);
  const info = await lstat(toNativePath(file)).catch(() => null);
  if (info?.isSymbolicLink()) {
    throw new PlaywrightMcpError('Refusing to write run history through a symlink', 'INVALID_PATH');
  }
  await appendFile(toNativePath(file), `${JSON.stringify(toHistoryEntry(result, source))}\n`, 'utf8');
  // Trim now and then, not on every write.
  if (info && info.size > 4_000_000) {
    const lines = (await readFile(toNativePath(file), 'utf8')).split('\n').filter((line) => line.trim() !== '');
    if (lines.length > MAX_ENTRIES) await writeFile(toNativePath(file), `${lines.slice(-MAX_ENTRIES).join('\n')}\n`, 'utf8');
  }
  return true;
}

/** Parse history lines, skipping anything malformed. Oldest first. */
export function parseHistory(text: string): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const entry = JSON.parse(line) as HistoryEntry;
      if (entry && entry.v === 1 && Array.isArray(entry.tests)) out.push(entry);
    } catch {
      /* skip a torn or hand-edited line */
    }
  }
  return out;
}

export async function readHistory(root: string, lastRuns: number): Promise<HistoryEntry[]> {
  const file = historyPath(root);
  await assertRealPathInside(file, root);
  const text = await readFile(toNativePath(file), 'utf8').catch(() => '');
  return parseHistory(text).slice(-lastRuns);
}

/* ------------------------------------------------------------------ */
/* Analysis                                                            */
/* ------------------------------------------------------------------ */

export function testKey(test: { file: string; title: string; project?: string }): string {
  return `${test.file} › ${test.title}${test.project ? ` [${test.project}]` : ''}`;
}

const FAILED: ReadonlySet<TestStatus> = new Set<TestStatus>(['failed', 'timedOut']);

export interface TestStats {
  key: string;
  file: string;
  title: string;
  project?: string;
  runs: number;
  passed: number;
  failed: number;
  /** Passed only on a retry. */
  flaky: number;
  /** Changes between pass and fail across consecutive runs. */
  flips: number;
  /** (failed + flaky) / runs */
  failRate: number;
  /** flips / (runs - 1) */
  flipRate: number;
  /** Outcomes oldest first: P pass, F fail, ~ flaky, - skipped. */
  strip: string;
  lastStatus: TestStatus;
  lastAt: string;
  avgMs?: number;
}

function letter(status: TestStatus): string {
  if (status === 'passed') return 'P';
  if (FAILED.has(status)) return 'F';
  if (status === 'flaky') return '~';
  return '-';
}

/** Per-test statistics across the given runs (oldest first). */
export function testStats(entries: HistoryEntry[]): TestStats[] {
  const map = new Map<string, { test: HistoryTest; statuses: TestStatus[]; ms: number[]; lastAt: string }>();
  for (const entry of entries) {
    for (const test of entry.tests) {
      const key = testKey(test);
      const slot = map.get(key) ?? { test, statuses: [], ms: [], lastAt: entry.at };
      slot.statuses.push(test.status);
      if (test.ms !== undefined) slot.ms.push(test.ms);
      slot.lastAt = entry.at;
      map.set(key, slot);
    }
  }
  const out: TestStats[] = [];
  for (const [key, slot] of map) {
    const ran = slot.statuses.filter((s) => s !== 'skipped' && s !== 'unknown');
    const passed = ran.filter((s) => s === 'passed').length;
    const failed = ran.filter((s) => FAILED.has(s)).length;
    const flaky = ran.filter((s) => s === 'flaky').length;
    let flips = 0;
    for (let i = 1; i < ran.length; i += 1) {
      const prevBad = ran[i - 1] !== 'passed';
      const curBad = ran[i] !== 'passed';
      if (prevBad !== curBad) flips += 1;
    }
    out.push({
      key,
      file: slot.test.file,
      title: slot.test.title,
      project: slot.test.project,
      runs: ran.length,
      passed,
      failed,
      flaky,
      flips,
      failRate: ran.length > 0 ? (failed + flaky) / ran.length : 0,
      flipRate: ran.length > 1 ? flips / (ran.length - 1) : 0,
      strip: slot.statuses.map(letter).join(''),
      lastStatus: slot.statuses[slot.statuses.length - 1],
      lastAt: slot.lastAt,
      avgMs: slot.ms.length > 0 ? Math.round(slot.ms.reduce((a, b) => a + b, 0) / slot.ms.length) : undefined,
    });
  }
  return out;
}

export interface FlakyRanking {
  /** Goes back and forth: passed on a retry, or flipped pass/fail twice or more. */
  flaky: TestStats[];
  /** Failed every time it ran in the window (at least twice). */
  broken: TestStats[];
  /** Passed earlier in the window, failing since (one flip, last run failed). */
  regressed: TestStats[];
  /** Everything else, including tests that failed and were then fixed. */
  stable: number;
}

/**
 * Rank unstable tests. Flaky means the outcome changes back and forth, so a
 * test that failed and was then fixed (one flip, now passing) is not flaky,
 * and one that started failing and keeps failing is a regression. More
 * flips and a higher failure share rank a flaky test higher.
 */
export function rankFlaky(entries: HistoryEntry[]): FlakyRanking {
  const stats = testStats(entries);
  const lastFailed = (s: TestStats): boolean => FAILED.has(s.lastStatus);
  const flaky = stats
    .filter((s) => s.flaky > 0 || s.flips >= 2)
    .sort((a, b) => b.flipRate - a.flipRate || b.failRate - a.failRate || b.runs - a.runs || a.key.localeCompare(b.key));
  const broken = stats
    .filter((s) => s.runs >= 2 && s.failed === s.runs)
    .sort((a, b) => b.runs - a.runs || a.key.localeCompare(b.key));
  const regressed = stats
    .filter((s) => s.flaky === 0 && s.flips === 1 && lastFailed(s))
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || a.key.localeCompare(b.key));
  return { flaky, broken, regressed, stable: stats.length - flaky.length - broken.length - regressed.length };
}

/** Fold digits, quoted values and whitespace so equal causes group together. */
export function errorSignature(message: string | undefined): string {
  return (message ?? '')
    .toLowerCase()
    .replace(/(['"`]).*?\1/g, '"…"')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

export interface FailurePattern {
  kind: string;
  signature: string;
  example: string;
  count: number;
  tests: string[];
  lastAt: string;
}

/** Group failures across runs by kind + normalized error, biggest first. */
export function failurePatterns(entries: HistoryEntry[]): FailurePattern[] {
  const map = new Map<string, FailurePattern>();
  for (const entry of entries) {
    for (const test of entry.tests) {
      if (!FAILED.has(test.status) && test.status !== 'flaky') continue;
      if (!test.msg && test.status === 'flaky') continue;
      const kind = test.kind ?? 'unknown';
      const signature = errorSignature(test.msg);
      const id = `${kind}|${signature}`;
      const pattern = map.get(id) ?? { kind, signature, example: test.msg ?? '', count: 0, tests: [], lastAt: entry.at };
      pattern.count += 1;
      const key = testKey(test);
      if (!pattern.tests.includes(key)) pattern.tests.push(key);
      pattern.lastAt = entry.at;
      map.set(id, pattern);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.tests.length - a.tests.length);
}
