/**
 * Parsing of Playwright's JSON reporter output plus text diagnostics.
 *
 * The JSON report is the source of truth for pass/fail stats and
 * failures; when the run dies before a report exists (timeout, crash,
 * syntax error, full disk…) `diagnoseOutput` turns raw stdout/stderr
 * into an ErrorKind + actionable hint.
 */

import type {
  DiscoveredTest,
  ErrorKind,
  FailureKind,
  PlaywrightJsonReport,
  ReportError,
  ReportSpec,
  ReportStats,
  ReportSuite,
  TestFailure,
  TestOutcome,
  TestStatus,
} from '../types/index.js';
import { isAbsolutePath, isPathInside, normalizePath, relativeToRoot, resolvePath } from './path-utils.js';

/** Cap so one pathological run cannot produce a megabyte tool payload. */
const MAX_FAILURES = 25;

const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export interface ParsedReport {
  stats: ReportStats | null;
  failures: TestFailure[];
  failuresTruncated: boolean;
  /** Every test case in the report (used by --list parsing). */
  tests: DiscoveredTest[];
  /** Final outcome per test case and project (used by run history). */
  outcomes: TestOutcome[];
  specCount: number;
  projects: string[];
  configPath: string | null;
  parseError?: string;
}

export interface Diagnosis {
  errorKind: ErrorKind;
  errorMessage: string;
  hint: string;
}

/** Remove ANSI color/control sequences from captured output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function emptyStats(): ReportStats {
  return { expected: 0, unexpected: 0, flaky: 0, skipped: 0, duration: 0 };
}

function stringifyMaybe(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

/** JSON-report stdout entries are strings (or {text} chunks). */
function flattenOutput(entries: unknown[] | undefined): string | undefined {
  if (!entries || entries.length === 0) return undefined;
  const parts: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') parts.push(entry);
    else if (entry && typeof entry === 'object' && 'text' in entry) {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  const joined = parts.join('\n').trim();
  return joined === '' ? undefined : joined;
}

/** Locate the trace.zip attachment for a failed attempt, if any. */
function resolveTracePath(
  attachments: Array<{ name?: string; path?: string; contentType?: string }> | undefined,
  ctx: WalkContext,
): string | undefined {
  for (const attachment of attachments ?? []) {
    const name = attachment.name ?? '';
    const contentType = attachment.contentType ?? '';
    const isTrace =
      name === 'trace' || name.endsWith('.zip') || contentType.includes('zip') || contentType.includes('trace');
    if (!isTrace || !attachment.path) continue;
    const p = normalizePath(attachment.path);
    const base = ctx.rootDir ?? ctx.root;
    const resolved = isAbsolutePath(p) ? p : resolvePath(base, p);
    // The report is project-controlled: only follow trace paths that stay
    // inside the project root, so get-failure cannot be pointed at other files.
    if (!isPathInside(resolved, ctx.root)) continue;
    return resolved;
  }
  return undefined;
}

function mapStatus(status?: string): TestStatus {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timedOut':
      return 'timedOut';
    case 'skipped':
      return 'skipped';
    case 'interrupted':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** Classify a failure from its message/stack plus normalized status. */
export function classifyFailure(text: string, status: TestStatus): FailureKind {
  const t = stripAnsi(text);
  if (/SyntaxError|Unexpected token|Cannot find module|ERR_MODULE_NOT_FOUND/i.test(t)) return 'syntax';
  if (/Invalid configuration|Unknown option|--project.*not found|No tests found/i.test(t)) return 'config';
  if (
    /Target closed|browser has been closed|Target page, context or browser has been closed|Page crashed|Protocol error|browserType\.\w+:\s*Closed/i.test(t)
  ) {
    return 'browser-crash';
  }
  if (
    /ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|getaddrinfo ENOTFOUND|Process from config\.webServer|webServer/i.test(t)
  ) {
    return 'server-unreachable';
  }
  if (status === 'timedOut' || /timeout\s+\d+\s*m?s?\s*exceeded|timed out after|test timed out/i.test(t)) {
    return 'timeout';
  }
  if (/expect\(|Expected:|Received:|toEqual|toBe\(|assertion failed|locator\./i.test(t)) {
    return 'assertion';
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/* Report walking                                                      */
/* ------------------------------------------------------------------ */

interface WalkOutcome {
  project?: string;
  status: TestStatus;
  retry?: number;
  error?: ReportError;
  durationMs?: number;
  attachments?: Array<{ name?: string; path?: string; contentType?: string }>;
  stdout?: string;
}

interface SpecRecord {
  titlePath: string[];
  file: string;
  line?: number;
  projects: string[];
  outcomes: WalkOutcome[];
}

interface WalkContext {
  root: string;
  rootDir: string | null;
  records: SpecRecord[];
  totalDuration: number;
  projectsSeen: Set<string>;
}

function normalizeSpecFile(file: string | undefined, ctx: WalkContext): string {
  if (!file) return '';
  const normalized = normalizePath(file);
  // Playwright addresses spec files relative to config.rootDir (the
  // testDir), while every consumer here — run-test, diagnose-flaky,
  // get-failure's next steps, list-tests — needs paths relative to the
  // project root. Rebase: relative → resolve against rootDir, absolute →
  // keep; then relativize against the project root when it is inside.
  const absolute = isAbsolutePath(normalized)
    ? normalized
    : resolvePath(ctx.rootDir ?? ctx.root, normalized);
  if (isPathInside(absolute, ctx.root)) return relativeToRoot(ctx.root, absolute);
  return normalized;
}

function walkSpec(spec: ReportSpec, prefix: string[], ctx: WalkContext): void {
  const titlePath = spec.title ? [...prefix, spec.title] : [...prefix];
  if (titlePath.length === 0) return;
  const file = normalizeSpecFile(spec.file, ctx);
  const line = spec.line;
  const cases = spec.tests ?? [];

  if (cases.length === 0) {
    ctx.records.push({ titlePath, file, line, projects: [], outcomes: [] });
    return;
  }

  for (const testCase of cases) {
    const project = testCase.projectName;
    if (project) ctx.projectsSeen.add(project);
    const results = testCase.results ?? [];
    let outcome: WalkOutcome;

    if (results.length === 0) {
      outcome = { project, status: mapStatus(testCase.status) };
    } else {
      const last = results[results.length - 1];
      let status = mapStatus(last.status);
      if (status === 'passed' && results.length > 1) {
        const earlierFailed = results
          .slice(0, -1)
          .some((r) => mapStatus(r.status) === 'failed' || mapStatus(r.status) === 'timedOut');
        if (earlierFailed) status = 'flaky';
      }
      outcome = {
        project,
        status,
        retry: last.retry,
        error: last.error ?? last.errors?.[0],
        durationMs: last.duration,
        attachments: last.attachments,
        stdout: flattenOutput(last.stdout),
      };
      if (typeof last.duration === 'number') ctx.totalDuration += last.duration;
    }
    ctx.records.push({ titlePath, file, line, projects: project ? [project] : [], outcomes: [outcome] });
  }
}

function walkSuite(suite: ReportSuite, prefix: string[], ctx: WalkContext): void {
  const titlePath = suite.title ? [...prefix, suite.title] : [...prefix];
  for (const spec of suite.specs ?? []) walkSpec(spec, titlePath, ctx);
  for (const child of suite.suites ?? []) walkSuite(child, titlePath, ctx);
}

function computeStats(records: SpecRecord[], duration: number): ReportStats {
  const stats = emptyStats();
  stats.duration = duration;
  for (const record of records) {
    for (const outcome of record.outcomes) {
      switch (outcome.status) {
        case 'passed':
          stats.expected += 1;
          break;
        case 'flaky':
          stats.flaky += 1;
          break;
        case 'failed':
        case 'timedOut':
          stats.unexpected += 1;
          break;
        case 'skipped':
          stats.skipped += 1;
          break;
        default:
          break;
      }
    }
  }
  return stats;
}

function mergeStats(reported: Partial<ReportStats> | undefined, computed: ReportStats): ReportStats {
  const num = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return {
    expected: num(reported?.expected, computed.expected),
    unexpected: num(reported?.unexpected, computed.unexpected),
    flaky: num(reported?.flaky, computed.flaky),
    skipped: num(reported?.skipped, computed.skipped),
    duration: num(reported?.duration, computed.duration),
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Parse a JSON report from a raw string. Never throws. */
export function parseReportJson(raw: string, root = '', maxFailures = MAX_FAILURES): ParsedReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      stats: null,
      failures: [],
      failuresTruncated: false,
      tests: [],
      outcomes: [],
      specCount: 0,
      projects: [],
      configPath: null,
      parseError: `Playwright JSON report could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return parseReport(parsed, root, maxFailures);
}

/**
 * Parse an already-deserialized Playwright JSON report into normalized
 * stats, failures, and a flat test listing.
 */
export function parseReport(report: unknown, root = '', maxFailures = MAX_FAILURES): ParsedReport {
  const base: ParsedReport = {
    stats: null,
    failures: [],
    failuresTruncated: false,
    tests: [],
    outcomes: [],
    specCount: 0,
    projects: [],
    configPath: null,
  };

  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    return { ...base, parseError: 'Playwright report was not a JSON object.' };
  }

  const typed = report as PlaywrightJsonReport;
  const hasSuites = Array.isArray(typed.suites);
  const hasErrors = Array.isArray(typed.errors);
  const hasStats = typed.stats !== undefined && typed.stats !== null;
  if (!hasSuites && !hasErrors && !hasStats) {
    return { ...base, parseError: 'Playwright report contained no suites, errors, or stats.' };
  }

  const ctx: WalkContext = {
    root: normalizePath(root || '.'),
    rootDir: typeof typed.config?.rootDir === 'string' ? normalizePath(typed.config.rootDir) : null,
    records: [],
    totalDuration: 0,
    projectsSeen: new Set<string>(),
  };

  for (const suite of typed.suites ?? []) walkSuite(suite, [], ctx);

  const computed = computeStats(ctx.records, ctx.totalDuration);
  const stats = mergeStats(typed.stats, computed);

  const configPath = typed.config?.configFile
    ? normalizeSpecFile(typed.config.configFile, ctx) || null
    : null;

  const failing: Array<{ record: SpecRecord; outcome: WalkOutcome }> = [];
  for (const record of ctx.records) {
    for (const outcome of record.outcomes) {
      if (outcome.status === 'failed' || outcome.status === 'timedOut') {
        failing.push({ record, outcome });
      }
    }
  }

  const failures: TestFailure[] = [];
  for (const { record, outcome } of failing.slice(0, maxFailures)) {
      const err = outcome.error;
      const message =
        stripAnsi(err?.message ?? '').trim() ||
        (outcome.status === 'timedOut' ? 'Test timed out.' : 'Test failed.');
      const stack = stripAnsi(err?.stack ?? '').trim() || undefined;
      const failureKind = classifyFailure(`${message}\n${stack ?? ''}`, outcome.status);
      failures.push({
        file: record.file,
        line: record.line,
        title: record.titlePath.join(' › '),
        project: outcome.project,
        status: outcome.status,
        failureKind,
        retry: outcome.retry,
        message,
        stack,
        codeframe: err?.codeframe ? stripAnsi(err.codeframe) : undefined,
        expected: stringifyMaybe(err?.expected),
        actual: stringifyMaybe(err?.actual),
        durationMs: outcome.durationMs,
        tracePath: resolveTracePath(outcome.attachments, ctx),
        stdout: outcome.stdout,
      });
  }

  let failuresTruncated = failing.length > maxFailures;
  let topLevelFailures = 0;

  // Top-level errors (bad config, "no tests found", …) when no per-test
  // failures were produced.
  if (failures.length === 0 && (typed.errors?.length ?? 0) > 0) {
    for (const err of (typed.errors ?? []).slice(0, maxFailures)) {
      topLevelFailures += 1;
      const message = stripAnsi(err?.message ?? '').trim() || 'Unknown top-level error.';
      failures.push({
        file: configPath ?? '',
        line: err.location?.line,
        title: 'configuration',
        status: 'failed',
        failureKind: classifyFailure(message, 'failed'),
        message,
        stack: stripAnsi(err?.stack ?? '').trim() || undefined,
        codeframe: err?.codeframe ? stripAnsi(err.codeframe) : undefined,
        expected: stringifyMaybe(err?.expected),
        actual: stringifyMaybe(err?.actual),
      });
    }
  }

  const tests: DiscoveredTest[] = ctx.records.map((record) => ({
    file: record.file,
    title: record.titlePath.join(' › '),
    line: record.line,
    projects: record.projects.length > 0 ? record.projects : undefined,
  }));

  for (const project of typed.config?.projects ?? []) {
    if (project?.name) ctx.projectsSeen.add(project.name);
  }

  const outcomes: TestOutcome[] = [];
  for (const record of ctx.records) {
    for (const outcome of record.outcomes) {
      const entry: TestOutcome = {
        file: record.file,
        line: record.line,
        title: record.titlePath.join(' › '),
        project: outcome.project,
        status: outcome.status,
        durationMs: outcome.durationMs,
      };
      if (outcome.status === 'failed' || outcome.status === 'timedOut' || outcome.status === 'flaky') {
        const message = stripAnsi(outcome.error?.message ?? '').trim();
        entry.message = (message.split('\n')[0] ?? '').slice(0, 200) || undefined;
        entry.failureKind = classifyFailure(`${message}\n${stripAnsi(outcome.error?.stack ?? '')}`, outcome.status);
      }
      outcomes.push(entry);
    }
  }

  const totalTestCases = ctx.records.reduce((sum, record) => {
    return sum + (record.outcomes.length > 0 ? record.outcomes.length : 1);
  }, 0);

  failuresTruncated = failuresTruncated || (typed.errors?.length ?? 0) > maxFailures;
  if (topLevelFailures > 0) stats.unexpected += topLevelFailures;

  return {
    stats,
    failures,
    failuresTruncated,
    tests,
    outcomes,
    specCount: totalTestCases,
    projects: [...ctx.projectsSeen],
    configPath,
  };
}

/**
 * Best-effort extraction of a JSON object from mixed text (stdout that
 * interleaves logs with the JSON reporter output).
 */
export function extractJsonFromText(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let end = text.lastIndexOf('}');
  let attempts = 0;
  while (end > start && attempts < 6) {
    const candidate = text.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      end = text.lastIndexOf('}', end - 1);
      attempts += 1;
    }
  }
  return null;
}

/** First line that looks like an actual error, else first content line. */
export function firstMeaningfulLine(text: string): string | undefined {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^(at |[-+]{3}|>)/.test(line));

  const clip = (line: string): string => (line.length > 400 ? `${line.slice(0, 400)}…` : line);

  const errorLine = lines.find((line) =>
    /error|exception|refused|not found|failed|timed out|timeout|enospc|enotfound|invalid|unexpected/i.test(line),
  );
  if (errorLine) return clip(errorLine);
  return lines.length > 0 ? clip(lines[0]) : undefined;
}

/**
 * Turn raw process output into an ErrorKind + hint when no structured
 * report exists. Returns null when nothing recognizable was found.
 */
export function diagnoseOutput(text: string): Diagnosis | null {
  const t = stripAnsi(text);
  if (t.trim() === '') return null;
  const first = firstMeaningfulLine(t) ?? 'Unknown error';

  if (/ENOSPC|no space left on device|disk (is )?full|not enough space/i.test(t)) {
    return {
      errorKind: 'DISK_FULL',
      errorMessage: first,
      hint: 'The disk is full (or the report directory is not writable). Free up space and retry — traces/reports could not be written.',
    };
  }

  if (
    /Executable doesn't exist|Please run the following command to install new browsers|browserType\.\w+:\s*Executable doesn't exist/i.test(t)
  ) {
    return {
      errorKind: 'NO_PLAYWRIGHT',
      errorMessage: first,
      hint: 'Playwright browsers are not installed for this project. Run: npx playwright install chromium',
    };
  }

  const syntax = /SyntaxError:([^\n]*)/.exec(t);
  if (syntax) {
    const loc = /at [^\n]*?((?:[A-Za-z]:)?[\w./\\-]+\.[cm]?[jt]sx?):(\d+)/.exec(t);
    const where = loc ? ` (${loc[1]}:${loc[2]})` : '';
    return {
      errorKind: 'SYNTAX_ERROR',
      errorMessage: `SyntaxError: ${syntax[1].trim()}${where}`,
      hint: 'A test or config file has a syntax error. Fix it and re-run; the stack trace above points at the file and line.',
    };
  }

  const cannotFindModule = /Cannot find module([^\n]*)/.exec(t);
  if (cannotFindModule) {
    return {
      errorKind: 'SYNTAX_ERROR',
      errorMessage: `Cannot find module${cannotFindModule[1].trim()}`,
      hint: 'A required module is missing. Check import paths and run npm install (or the equivalent for your package manager).',
    };
  }

  if (
    /ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|getaddrinfo ENOTFOUND|Process from config\.webServer|webServer|did not start/i.test(t)
  ) {
    return {
      errorKind: 'SERVER_NOT_RUNNING',
      errorMessage: first,
      hint: 'Your app (dev server) does not appear to be reachable. Start it in another terminal (e.g. npm run dev / npm start), keep it running, then retry — or configure `webServer` in playwright.config.* so Playwright starts it automatically.',
    };
  }

  if (
    /Target closed|browser has been closed|Target page, context or browser has been closed|Page crashed|Protocol error.*Target/i.test(t)
  ) {
    return {
      errorKind: 'BROWSER_CRASH',
      errorMessage: first,
      hint: 'The browser process crashed or was closed unexpectedly. Retry the run; if it keeps happening run `npx playwright install --force` and make sure no other automation browser holds the profile.',
    };
  }

  if (/timeout\s+\d+\s*m?s?\s*exceeded|timed out after|test timed out/i.test(t)) {
    return {
      errorKind: 'TIMEOUT',
      errorMessage: first,
      hint: 'The operation exceeded its timeout. Raise the timeout (timeoutMs on this tool, or test.setTimeout() in the spec) or investigate why the app/test hangs.',
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Config / test-file helpers                                          */
/* ------------------------------------------------------------------ */

/** Extract `name: '…'` values from a playwright.config source. */
export function parseProjectNames(source: string): string[] {
  const names = new Set<string>();
  const re = /\bname\s*:\s*(['"])([^'"]{1,64})\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    names.add(match[2]);
  }
  return [...names];
}

const CALL_RE =
  /(?<![\w$.])test\s*(?:\.\s*(describe(?:\s*\.\s*(?:only|serial|parallel|each))?|only|skip|fixme|fail))?\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\\n])*)\2/g;

/**
 * Regex-based extraction of `test(...)` / `test.describe(...)` titles
 * from a spec file. Used only as a fallback when Playwright itself
 * cannot list tests (not installed, config broken, syntax error).
 */
export function extractTestTitles(source: string): Array<{ title: string; line: number }> {
  const out: Array<{ title: string; line: number }> = [];
  const stack: Array<{ title: string; indent: number }> = [];
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const indent = line.length - line.trimStart().length;

    CALL_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CALL_RE.exec(line)) !== null) {
      const kind = match[1];
      const title = match[3].replace(/\\(['"`])/g, '$1');
      if (title === '') continue;
      if (kind !== undefined && kind.startsWith('describe')) {
        stack.push({ title, indent });
      } else {
        // Plain test(), plus test.only / test.skip / test.fixme / test.fail.
        const path = [...stack.map((entry) => entry.title), title].join(' › ');
        out.push({ title: path, line: i + 1 });
      }
    }

    // Pop describes whose block ends on this line: `});` / `}`.
    if (/^\s*[)}\]]+;?\s*$/.test(line)) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        stack.pop();
      }
    }
  }

  return out;
}
