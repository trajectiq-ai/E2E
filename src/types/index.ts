/**
 * Shared TypeScript interfaces and error types for playwright-e2e-mcp.
 *
 * Everything that other modules need to agree on lives here: tool
 * contracts, Playwright JSON report shapes, run/inspect results, and the
 * error taxonomy used to turn failures into actionable MCP responses.
 */

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type LogContext = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): Logger;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Machine-readable failure categories. Tools map these to clear user
 * facing messages instead of dumping raw stack traces.
 */
export type ErrorKind =
  | 'NO_PLAYWRIGHT'
  | 'NO_CONFIG'
  | 'MULTIPLE_CONFIGS'
  | 'INVALID_PATH'
  | 'SERVER_NOT_RUNNING'
  | 'TIMEOUT'
  | 'BROWSER_CRASH'
  | 'SYNTAX_ERROR'
  | 'DISK_FULL'
  | 'CLIENT_DISCONNECT'
  | 'SPAWN_FAILED'
  | 'REPORT_MISSING'
  | 'UNKNOWN';

export interface PlaywrightMcpErrorOptions {
  hint?: string;
  details?: string;
  cause?: unknown;
}

/**
 * Error type carrying an ErrorKind so the MCP layer can render a
 * helpful remediation hint instead of a raw exception.
 */
export class PlaywrightMcpError extends Error {
  readonly kind: ErrorKind;
  readonly hint?: string;
  readonly details?: string;

  constructor(
    message: string,
    kind: ErrorKind = 'UNKNOWN',
    options: PlaywrightMcpErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'PlaywrightMcpError';
    this.kind = kind;
    this.hint = options.hint;
    this.details = options.details;
  }
}

/** Wrap an unknown thrown value into a PlaywrightMcpError. */
export function toPlaywrightMcpError(
  err: unknown,
  fallbackKind: ErrorKind = 'UNKNOWN',
): PlaywrightMcpError {
  if (err instanceof PlaywrightMcpError) return err;
  if (err instanceof Error) {
    const wrapped = new PlaywrightMcpError(err.message, classifyMessage(err.message, fallbackKind), {
      cause: err,
    });
    wrapped.stack = err.stack;
    return wrapped;
  }
  return new PlaywrightMcpError(String(err), fallbackKind);
}

function classifyMessage(message: string, fallbackKind: ErrorKind): ErrorKind {
  const m = message.toLowerCase();
  if (m.includes('enoent') && m.includes('playwright')) return 'NO_PLAYWRIGHT';
  if (m.includes('syntaxerror') || m.includes('unexpected token')) return 'SYNTAX_ERROR';
  if (m.includes('enospc') || m.includes('no space left')) return 'DISK_FULL';
  if (m.includes('timed out') || m.includes('timeout')) return 'TIMEOUT';
  if (m.includes('target closed') || m.includes('browser has been closed')) return 'BROWSER_CRASH';
  return fallbackKind;
}

/* ------------------------------------------------------------------ */
/* Tool plumbing                                                       */
/* ------------------------------------------------------------------ */

/** Result of the most recent run-test invocation (feeds get-failure). */
export interface LastRunRecord {
  projectRoot: string;
  result: RunTestResult;
  at: number;
}

/** Minimal cross-tool state held by the server. */
export interface ToolStore {
  lastRun: LastRunRecord | null;
  setLastRun(record: LastRunRecord): void;
}

/** Per-invocation context passed from the server into each tool. */
export interface ToolContext {
  logger: Logger;
  /**
   * Aborted when the MCP client disconnects or cancels the request.
   * Tools must kill child processes / browsers when this fires.
   */
  signal?: AbortSignal;
  store: ToolStore;
  /** Default project root (server cwd or PW_MCP_PROJECT_ROOT). */
  projectRoot: string;
  /**
   * Set for unauthenticated HTTP callers: tools must not spawn processes
   * or run project code, and callers may not pick another project root.
   */
  restricted?: boolean;
  /**
   * Report progress to the client (MCP notifications/progress), when it
   * asked for it with a progress token.
   */
  progress?: (progress: number, total?: number, message?: string) => void;
}

/**
 * MCP tool return value (content blocks + optional structured payload).
 * The index signature keeps it assignable to the SDK's CallToolResult.
 */
export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Project detection                                                   */
/* ------------------------------------------------------------------ */

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown';

export interface ProjectDetection {
  /** Directory the search started from (normalized, absolute). */
  startDir: string;
  /** Project root: directory containing playwright.config.* if found. */
  root: string;
  /** Absolute path of the selected config, or null when none exists. */
  configPath: string | null;
  /** Every config found in the chosen directory (ask user if >1). */
  configCandidates: string[];
  /** Whether @playwright/test or playwright is resolvable in node_modules. */
  hasPlaywright: boolean;
  /** Which package satisfied the check: '@playwright/test' | 'playwright'. */
  playwrightPackage: string | null;
  playwrightVersion: string | null;
  /** Best-effort testDir parsed from the config file text. */
  testDir: string | null;
  packageManager: PackageManager;
}

/* ------------------------------------------------------------------ */
/* Playwright JSON report                                               */
/* ------------------------------------------------------------------ */

export interface ReportStats {
  expected: number;
  unexpected: number;
  flaky: number;
  skipped: number;
  duration: number;
}

export interface ReportError {
  message?: string;
  stack?: string;
  codeframe?: string;
  expected?: unknown;
  actual?: unknown;
  location?: { file?: string; line?: number; column?: number };
}

export interface ReportSpec {
  title: string;
  file?: string;
  line?: number;
  column?: number;
  ok?: boolean;
  tags?: string[];
  tests?: ReportTestCase[];
}

export interface ReportTestCase {
  projectName?: string;
  status?: string;
  results?: ReportTestResult[];
}

export interface ReportTestResult {
  status?: string;
  retry?: number;
  workerIndex?: number;
  duration?: number;
  startTime?: string;
  error?: ReportError;
  errors?: ReportError[];
  expected?: string;
  expectedStatus?: string;
  actual?: string;
  /** Trace/screenshot/console attachments produced for this attempt. */
  attachments?: Array<{ name?: string; path?: string; contentType?: string }>;
  /** Raw test console output captured by the JSON reporter. */
  stdout?: unknown[];
  stderr?: unknown[];
}

export interface ReportSuite {
  title?: string;
  file?: string;
  line?: number;
  suites?: ReportSuite[];
  specs?: ReportSpec[];
}

export interface PlaywrightJsonReport {
  config?: {
    rootDir?: string;
    configFile?: string;
    projects?: Array<{ name?: string }>;
  };
  suites?: ReportSuite[];
  errors?: ReportError[];
  stats?: ReportStats;
}

/* ------------------------------------------------------------------ */
/* run-test tool                                                        */
/* ------------------------------------------------------------------ */

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

export interface RunTestOptions {
  /** Absolute project root (already sanitized by the caller). */
  projectRoot: string;
  configPath?: string;
  /** Test files/paths relative to the project root, already sanitized. */
  testFiles?: string[];
  /** Playwright --grep expression. */
  grep?: string;
  browser?: BrowserName;
  /** Exact Playwright project name (e.g. the project a failure ran in); wins over `browser`. */
  project?: string;
  headed?: boolean;
  /** Hard wall-clock limit for the whole run; process group is killed. */
  timeoutMs?: number;
  /** Per-test timeout passed to Playwright (--timeout). */
  testTimeoutMs?: number;
  workers?: number;
  retries?: number;
  /** Extra CLI args appended verbatim (caller-sanitized). */
  extraArgs?: string[];
  /**
   * Automatically retry failed tests once before reporting failure
   * (default true — injected as --retries=1 when the config does not
   * already enable retries).
   */
  retryOnFailure?: boolean;
  /**
   * Playwright --last-failed: only re-run tests that failed in the
   * previous run — the fast fix → re-run loop.
   */
  lastFailed?: boolean;
  /** Abort when the MCP client disconnects. */
  signal?: AbortSignal;
  /** Called with Playwright's line-reporter progress while the run is going. */
  onProgress?: (progress: RunProgress) => void;
}

/** Live progress of a run, parsed from the line reporter. */
export interface RunProgress {
  done: number;
  total?: number;
  failed: number;
  /** Title of the most recently finished test. */
  last?: string;
}

export type TestStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'flaky' | 'unknown';

export type FailureKind =
  | 'assertion'
  | 'timeout'
  | 'browser-crash'
  | 'syntax'
  | 'config'
  | 'server-unreachable'
  | 'unknown';

export interface TestFailure {
  /** Project-relative file path, posix separators. */
  file: string;
  line?: number;
  /** Full test title path joined with ' › '. */
  title: string;
  project?: string;
  status: TestStatus;
  failureKind: FailureKind;
  retry?: number;
  message: string;
  stack?: string;
  codeframe?: string;
  expected?: string;
  actual?: string;
  durationMs?: number;
  /** Absolute path of the Playwright trace.zip captured for this attempt. */
  tracePath?: string;
  /** Test console output (stdout) captured for this attempt. */
  stdout?: string;
}

/** One test's final outcome in a run (every test, not only failures). */
export interface TestOutcome {
  file: string;
  line?: number;
  title: string;
  project?: string;
  status: TestStatus;
  durationMs?: number;
  failureKind?: FailureKind;
  /** First line of the error, for failed/flaky tests. */
  message?: string;
}

export interface RunTestResult {
  ok: boolean;
  /** Final outcome of every test in the run (feeds run history). */
  outcomes?: TestOutcome[];
  exitCode: number | null;
  signalName: string | null;
  durationMs: number;
  /** The wrapper timeout fired: process was killed, results are partial. */
  timedOut: boolean;
  killed: boolean;
  /** True when results are incomplete (timeout/crash/missing report). */
  partial: boolean;
  stats: ReportStats | null;
  failures: TestFailure[];
  stdoutTail: string;
  stderrTail: string;
  truncatedOutput: boolean;
  reportPath?: string;
  configPath?: string;
  command: string;
  /** True when more failures occurred than were included in `failures`. */
  failuresTruncated?: boolean;
  /** Server injected --retries=1 so flaky tests pass before reporting. */
  autoRetry?: boolean;
  /** Run was restricted to previously failed tests (--last-failed). */
  lastFailed?: boolean;
  errorKind?: ErrorKind;
  errorMessage?: string;
  hint?: string;
}

/* ------------------------------------------------------------------ */
/* list-tests tool                                                      */
/* ------------------------------------------------------------------ */

export interface ListTestsOptions {
  projectRoot: string;
  configPath?: string;
  testDir?: string | null;
  /** Case-insensitive substring filter applied to "file › title". */
  filter?: string;
  limit?: number;
  signal?: AbortSignal;
  /** Skip `playwright test --list` (which runs project code) and scan sources only. */
  noSpawn?: boolean;
}

export interface DiscoveredTest {
  file: string;
  title: string;
  line?: number;
  projects?: string[];
}

export interface ListTestsResult {
  tests: DiscoveredTest[];
  total: number;
  truncated: boolean;
  testDir: string | null;
  source: 'playwright-list' | 'file-scan';
  /** Why Playwright could not list tests, when the fallback scan was used. */
  error?: { kind: ErrorKind; message: string; hint?: string };
}

/* ------------------------------------------------------------------ */
/* inspect-page tool                                                    */
/* ------------------------------------------------------------------ */

export interface ElementInfo {
  /** Stable CSS selector that uniquely addresses the element. */
  selector: string;
  tag: string;
  id?: string;
  classes: string[];
  role?: string;
  text?: string;
  attributes: Record<string, string>;
  visible: boolean;
  box?: { x: number; y: number; width: number; height: number };
  /** Accessible name, when the element has a role. */
  name?: string;
  /**
   * Playwright locators proven (in the same page) to resolve to exactly this
   * element, best first: role + name, test id, label, placeholder, text, CSS.
   */
  locators?: import('../utils/locator-expr.js').LocatorCall[][];
  /** heal mode: how closely the element matches the broken locator. */
  score?: number;
}

export interface ConsoleMessageInfo {
  type: string;
  text: string;
}

export interface InspectPageOptions {
  projectRoot: string;
  url: string;
  /** When set, inspect matches for this selector instead of the whole DOM. */
  selector?: string;
  /** Extra wait condition: CSS selector or "text=..." to await first. */
  waitFor?: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  includeHtml?: boolean;
  maxHtmlChars?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PageInspection {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  elementCount: number;
  elements: ElementInfo[];
  html?: string;
  htmlTruncated?: boolean;
  consoleMessages: ConsoleMessageInfo[];
  viewport: { width: number; height: number };
  durationMs: number;
}

/* ------------------------------------------------------------------ */
/* validate-selector tool                                               */
/* ------------------------------------------------------------------ */

export interface ValidateSelectorOptions {
  projectRoot: string;
  url: string;
  selector: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ValidateSelectorResult {
  selector: string;
  valid: boolean;
  matchCount: number;
  /** First few matches, capped for readability. */
  matches: ElementInfo[];
  parseError?: string;
  hint?: string;
}
