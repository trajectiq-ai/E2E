/**
 * Core Playwright execution logic.
 *
 * Runs the project's local Playwright CLI as a child process (never a
 * shell), streams and caps its output, enforces a hard wall-clock
 * timeout with process-*group* cleanup, collects the JSON report, and
 * converts every failure mode — missing install, dead dev server,
 * syntax error, browser crash, full disk, client disconnect — into a
 * structured result.
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PlaywrightMcpError } from '../types/index.js';
import type {
  DiscoveredTest,
  ErrorKind,
  ListTestsOptions,
  ListTestsResult,
  RunTestOptions,
  RunTestResult,
} from '../types/index.js';
import {
  findTestFiles,
  missingPlaywrightMessage,
  detectProject,
} from './project-detector.js';
import {
  extractJsonFromText,
  extractTestTitles,
  diagnoseOutput,
  parseReportJson,
  parseProjectNames,
} from './report-parser.js';
import {
  hasOptionLikeSegment,
  isAbsolutePath,
  isPathInside,
  normalizePath,
  relativeToRoot,
  sanitizeCliArg,
  tempFilePath,
  toNativePath,
} from './path-utils.js';
import { logger } from './logger.js';

const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_LIST_TIMEOUT_MS = 60_000;
/** Keep only the tail of combined child output in memory. */
const OUTPUT_CAP_CHARS = 400_000;
/** Characters of stdout/stderr echoed back in the tool result. */
const TAIL_CHARS = 8_000;
const GRACEFUL_KILL_MS = 3_000;
const ABORT_KILL_MS = 1_000;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function readFileText(p: string): Promise<string | null> {
  try {
    return await readFile(p, 'utf8');
  } catch {
    return null;
  }
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function sanitizeGrep(grep: string): string {
  const raw = grep.trim();
  if (raw === '' || /[\0\n\r]/.test(raw) || raw.length > 500) {
    throw new PlaywrightMcpError('Invalid --grep expression', 'INVALID_PATH', {
      hint: 'Provide a plain regular expression without NUL/newline characters (max 500 chars).',
    });
  }
  return raw;
}

function tail(text: string, limit = TAIL_CHARS): string {
  if (text.length <= limit) return text;
  return `…(truncated)…\n${text.slice(text.length - limit)}`;
}

/**
 * Locate the project's local Playwright CLI (playwright/cli.js), which
 * we invoke directly with `node` — no shell, no npx, cross-platform.
 */
export async function resolvePlaywrightCli(projectRoot: string): Promise<string | null> {
  let dir = normalizePath(projectRoot);
  for (let depth = 0; depth < 64; depth += 1) {
    for (const pkg of ['playwright', '@playwright/test']) {
      const cli = path.join(dir, 'node_modules', ...pkg.split('/'), 'cli.js');
      if (await fileExists(cli)) return cli;
    }
    const parent = normalizePath(path.dirname(dir));
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Process execution                                                   */
/* ------------------------------------------------------------------ */

export interface RunProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ProcessOutcome {
  code: number | null;
  signalName: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError: { code: string; message: string } | null;
}

/**
 * Kill a child and its descendants. POSIX: signal the whole process
 * group (child is spawned detached). Windows: taskkill /T walks the
 * tree, /F only on the forced pass.
 */
function killTree(child: ChildProcess, force: boolean): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      const args = ['/pid', String(pid), '/T'];
      if (force) args.push('/F');
      const killer = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true });
      killer.on('error', () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already exited */
        }
      });
    } else {
      try {
        process.kill(-pid, force ? 'SIGKILL' : 'SIGINT');
      } catch {
        try {
          child.kill(force ? 'SIGKILL' : 'SIGINT');
        } catch {
          /* already exited */
        }
      }
    }
  } catch {
    /* process already gone */
  }
}

/**
 * Spawn a process with output capping, tree-kill timeout and abort.
 * Children are tracked so shutdown/disconnect can never orphan them.
 */
export function runProcess(command: string, args: string[], options: RunProcessOptions): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let capturedChars = 0;

    const push = (chunks: string[], chunk: string): void => {
      chunks.push(chunk);
      capturedChars += chunk.length;
      while (capturedChars > OUTPUT_CAP_CHARS && chunks.length > 1) {
        capturedChars -= chunks[0].length;
        chunks.shift();
      }
    };

    if (maxChildren > 0 && activeChildren.size >= maxChildren) {
      resolve({
        code: null,
        signalName: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        spawnError: {
          code: 'EBUSY',
          message: `Too many runs in progress (limit ${maxChildren}). Try again when one finishes.`,
        },
      });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
      activeChildren.add(child);
    } catch (err) {
      resolve({
        code: null,
        signalName: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        spawnError: {
          code: 'ESPAWN',
          message: err instanceof Error ? err.message : String(err),
        },
      });
      return;
    }

    const shutdown = (graceMs: number): void => {
      // Windows has no SIGINT semantics for console children — taskkill
      // /T /F straight away; POSIX gets a graceful SIGINT first.
      killTree(child, process.platform === 'win32');
      if (forceTimer === undefined) {
        forceTimer = setTimeout(() => {
          killTree(child, true);
        }, graceMs);
        forceTimer.unref?.();
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => push(stdoutChunks, chunk));
    child.stderr?.on('data', (chunk: string) => push(stderrChunks, chunk));

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      shutdown(ABORT_KILL_MS);
    };
    if (options.signal) {
      if (options.signal.aborted) {
        aborted = true;
        shutdown(ABORT_KILL_MS);
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      shutdown(GRACEFUL_KILL_MS);
    }, options.timeoutMs);
    timeoutTimer.unref?.();

    let spawnError: ProcessOutcome['spawnError'] = null;
    const finish = (code: number | null, signalName: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signalName,
        stdout: stdoutChunks.join(''),
        stderr: stderrChunks.join(''),
        timedOut,
        aborted,
        spawnError,
      });
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = { code: err.code ?? 'ESPAWN', message: err.message };
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** Every child spawned by runProcess that has not settled yet. */
const activeChildren = new Set<ChildProcess>();

let maxChildren = 0;

/**
 * Cap how many children may run at once; 0 means no cap. The HTTP bridge
 * sets one (PW_MCP_MAX_CHILDREN, default 4) so remote callers cannot
 * start an unbounded number of browsers and test runs.
 */
export function setMaxChildren(limit: number): void {
  maxChildren = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
}

let scrubChildEnv = false;

/**
 * When on (the HTTP bridge turns it on), children get only an allowlisted
 * environment, so code run on behalf of a remote caller cannot read
 * deployment credentials.
 */
export function setScrubChildEnv(enabled: boolean): void {
  scrubChildEnv = enabled;
}

/** Variables a child keeps in scrubbed mode (compared upper-case). */
const CHILD_ENV_ALLOW = new Set([
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LANGUAGE',
  'TZ',
  'CI',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_RUNTIME_DIR',
  'DISPLAY',
]);
const CHILD_ENV_ALLOW_PREFIXES = ['LC_', 'NPM_CONFIG_', 'PLAYWRIGHT_'];
/** Even allowlisted names are dropped when they look like a secret. */
const SECRET_ENV_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|AUTH|SESSION|COOKIE|DATABASE_URL|_DSN$)/i;

/** Names listed in PW_MCP_PASSTHROUGH_ENV (comma-separated), never the bridge token. */
function passthroughNames(): Set<string> {
  return new Set(
    (process.env.PW_MCP_PASSTHROUGH_ENV ?? '')
      .split(',')
      .map((name) => name.trim().toUpperCase())
      .filter((name) => name && name !== 'PW_MCP_HTTP_TOKEN'),
  );
}

/** A URL with userinfo (`scheme://user:pass@host`), e.g. an authenticated proxy. */
const URL_CREDENTIALS_RE = /:\/\/[^/\s@]*@/;

function keepInScrubbedEnv(key: string, value: string | undefined, passthrough: Set<string>): boolean {
  const upper = key.toUpperCase();
  if (upper === 'PW_MCP_HTTP_TOKEN') return false;
  if (passthrough.has(upper)) return true;
  if (SECRET_ENV_RE.test(key)) return false;
  if (value !== undefined && URL_CREDENTIALS_RE.test(value)) return false;
  return CHILD_ENV_ALLOW.has(upper) || CHILD_ENV_ALLOW_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** Environment for a spawned child: process.env plus overrides, allowlisted when scrubbing. */
export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const passthrough = scrubChildEnv ? passthroughNames() : new Set<string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (scrubChildEnv && !keepInScrubbedEnv(key, value, passthrough)) continue;
    env[key] = value;
  }
  return { ...env, ...overrides };
}

/**
 * Force-kill every child still running (and its tree). Called on
 * shutdown and when the MCP client disconnects so no browser or test
 * worker outlives the server.
 */
export function killActiveChildren(): number {
  const children = [...activeChildren];
  for (const child of children) killTree(child, true);
  activeChildren.clear();
  return children.length;
}

/* ------------------------------------------------------------------ */
/* run-test                                                            */
/* ------------------------------------------------------------------ */

function sanitizeTestFile(file: string, root: string): string {
  const resolved = normalizePath(isAbsolutePath(file) ? file : path.join(root, file));
  if (!isPathInside(resolved, root)) {
    throw new PlaywrightMcpError(`Test path "${file}" is outside the project root`, 'INVALID_PATH', {
      hint: `Only test paths inside ${root} are allowed.`,
    });
  }
  // Test files go on the command line as positionals; a segment like
  // "--output=/x" would be parsed by Playwright as an option.
  if (hasOptionLikeSegment(relativeToRoot(root, resolved))) {
    throw new PlaywrightMcpError(`Test path "${file}" has a segment starting with "-"`, 'INVALID_PATH', {
      hint: 'Rename the file or folder so no path segment starts with "-".',
    });
  }
  return resolved;
}

/** Best-effort `retries: N` from the config source text. */
async function readConfigRetries(configPath: string | undefined): Promise<number | null> {
  if (!configPath) return null;
  const source = await readFileText(configPath);
  if (source === null) return null;
  const match = /\bretries\s*:\s*(\d+)/.exec(source);
  return match ? Number(match[1]) : null;
}

interface AutoRetryDecision {
  apply: boolean;
  reason: string;
}

/**
 * The blueprint's "flakiness" cure: unless the caller asks otherwise,
 * retry failing tests once (--retries=1) before telling the agent they
 * failed. A test that passes on that retry is reported as *flaky*, not
 * failed. Explicit `retries` or retryOnFailure: false win; a config
 * that already enables retries is left alone.
 */
async function resolveAutoRetry(
  configPath: string | undefined,
  options: RunTestOptions,
): Promise<AutoRetryDecision> {
  if (options.retries !== undefined) {
    return { apply: false, reason: 'caller set retries explicitly' };
  }
  if (options.retryOnFailure === false) {
    return { apply: false, reason: 'retryOnFailure disabled by caller' };
  }
  const configRetries = await readConfigRetries(configPath);
  if (configRetries !== null && configRetries > 0) {
    return { apply: false, reason: `config already sets retries: ${configRetries}` };
  }
  return { apply: true, reason: 'server-level auto retry-once enabled' };
}

async function resolveProjectFlag(
  configPath: string | undefined,
  browser: RunTestOptions['browser'],
): Promise<{ project?: string; hint?: string }> {
  if (!browser) return {};
  const source = configPath ? await readFileText(configPath) : null;
  if (source === null) {
    return browser === 'chromium'
      ? {}
      : {
          hint: `No config file was found to verify project names, so the run used the default browser (chromium) instead of ${browser}.`,
        };
  }
  const names = parseProjectNames(source);
  if (names.includes(browser)) return { project: browser };
  if (names.length === 0) {
    return browser === 'chromium'
      ? {}
      : {
          hint: `playwright.config does not define a project named "${browser}", so the run used the default browser (chromium). Add a "${browser}" project to test it.`,
        };
  }
  return {
    hint: `playwright.config has no project named "${browser}" (found: ${names.join(', ')}); the run used the config's default project(s).`,
  };
}

/**
 * Execute Playwright tests and return a structured result. Throws
 * PlaywrightMcpError only for precondition failures (no Playwright
 * installed, bad paths); test failures come back as data.
 */
export async function runTests(options: RunTestOptions): Promise<RunTestResult> {
  const root = normalizePath(options.projectRoot);

  if (options.signal?.aborted) {
    throw new PlaywrightMcpError('Request cancelled before the run started', 'CLIENT_DISCONNECT', {
      hint: 'The MCP client disconnected.',
    });
  }

  const cli = await resolvePlaywrightCli(root);
  if (cli === null) {
    const detection = await detectProject(root);
    const { message, hint } = missingPlaywrightMessage(detection);
    throw new PlaywrightMcpError(message, 'NO_PLAYWRIGHT', { hint });
  }

  let configPath: string | undefined;
  if (options.configPath) {
    configPath = normalizePath(options.configPath);
    if (!isPathInside(configPath, root)) {
      throw new PlaywrightMcpError('Config path is outside the project root', 'INVALID_PATH', {
        hint: `The playwright.config must live inside ${root}.`,
      });
    }
    if (!(await fileExists(configPath))) {
      throw new PlaywrightMcpError(`Config file not found: ${configPath}`, 'NO_CONFIG', {
        hint: 'Check the config path, or omit it to let Playwright auto-detect playwright.config.*.',
      });
    }
  }

  const testFiles = (options.testFiles ?? []).map((file) => sanitizeTestFile(file, root));
  const reportPath = tempFilePath('pw-report', '.json');
  const { project, hint: projectHint } = await resolveProjectFlag(configPath, options.browser);
  const autoRetryState = await resolveAutoRetry(configPath, options);

  const args: string[] = ['test'];
  if (configPath) args.push('--config', toNativePath(configPath));
  for (const file of testFiles) {
    args.push(relativeToRoot(root, file));
  }
  if (options.grep) args.push(`--grep=${sanitizeGrep(options.grep)}`);
  if (options.lastFailed) args.push('--last-failed');
  if (project) args.push(`--project=${project}`);
  if (options.headed) args.push('--headed');
  const workers = clampInt(options.workers, 1, 64);
  if (workers !== undefined) args.push(`--workers=${workers}`);
  const retries = clampInt(options.retries, 0, 10);
  if (retries !== undefined) args.push(`--retries=${retries}`);
  else if (autoRetryState.apply) args.push(`--retries=1`);
  const testTimeout = clampInt(options.testTimeoutMs, 1_000, 3_600_000);
  if (testTimeout !== undefined) args.push(`--timeout=${testTimeout}`);
  const hasTraceFlag = (options.extraArgs ?? []).some((extra) => extra.startsWith('--trace'));
  if (!hasTraceFlag) args.push('--trace=retain-on-failure');
  for (const extra of options.extraArgs ?? []) args.push(sanitizeCliArg(extra));
  // The JSON reporter must be the only reporter and come last: results are
  // parsed from its output. sanitizeCliArg rejects --reporter; this keeps
  // the invariant if that ever changes.
  if (args.some((arg) => arg.startsWith('--reporter'))) {
    throw new PlaywrightMcpError('Caller arguments may not set --reporter', 'INVALID_PATH');
  }
  args.push('--reporter=json');

  const env = childEnv({
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
    FORCE_COLOR: '0',
    PW_TEST_HTML_REPORT_OPEN: 'never',
  });

  const timeoutMs = clampInt(options.timeoutMs, 1_000, 3_600_000) ?? DEFAULT_RUN_TIMEOUT_MS;
  const startedAt = Date.now();
  logger.debug('Starting Playwright run', { args: args.join(' '), cwd: root, timeoutMs });

  const outcome = await runProcess(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    timeoutMs,
    signal: options.signal,
  });

  const durationMs = Date.now() - startedAt;
  const displayCommand = ['playwright', ...args].join(' ');

  const rawReport = (await readFileText(reportPath)) ?? extractJsonFromText(outcome.stdout);
  const parsed = rawReport
    ? parseReportJson(rawReport, root)
    : {
        stats: null,
        failures: [],
        failuresTruncated: false,
        tests: [],
        specCount: 0,
        projects: [],
        configPath: null,
        parseError: 'No JSON report was produced.',
      };

  const combined = `${outcome.stderr}\n${outcome.stdout}`;
  const diagnosis = diagnoseOutput(combined);

  let errorKind: ErrorKind | undefined;
  let errorMessage: string | undefined;
  let hint = projectHint;

  if (outcome.spawnError) {
    errorKind = 'SPAWN_FAILED';
    errorMessage = outcome.spawnError.message;
    hint =
      outcome.spawnError.code === 'ENOENT'
        ? 'Node.js could not be located on PATH. Reinstall Node >= 18 and retry.'
        : outcome.spawnError.code === 'EBUSY'
          ? 'The server is at its limit of concurrent runs; retry when one finishes.'
          : `Failed to start Playwright: ${outcome.spawnError.message}`;
  } else if (outcome.aborted) {
    errorKind = 'CLIENT_DISCONNECT';
    errorMessage = 'Run aborted because the MCP client disconnected.';
    hint = 'Child processes and browsers were terminated.';
  } else if (outcome.timedOut) {
    errorKind = 'TIMEOUT';
    errorMessage = `Run exceeded the ${timeoutMs}ms limit and was killed.`;
    const timeoutHint =
      'Partial results are shown below. Raise timeoutMs, reduce workers, or run a single test file. Playwright may also be configured with `timeout` in playwright.config.*.';
    hint = [timeoutHint, diagnosis?.hint].filter(Boolean).join('\n');
  } else if (diagnosis && (outcome.code !== 0 || parsed.failures.length === 0)) {
    errorKind = diagnosis.errorKind;
    errorMessage = diagnosis.errorMessage;
    hint = [hint, diagnosis.hint].filter(Boolean).join('\n');
  } else if (parsed.parseError && outcome.code !== 0) {
    errorKind = 'REPORT_MISSING';
    errorMessage = parsed.parseError;
    hint = 'Playwright exited with an error before writing a report. See stderr below.';
  }

  const ok = outcome.code === 0 && !outcome.timedOut && !outcome.aborted && !outcome.spawnError;
  const partial =
    outcome.timedOut ||
    outcome.aborted ||
    (outcome.code !== 0 && parsed.failures.length === 0 && rawReport === null);

  return {
    ok,
    exitCode: outcome.code,
    signalName: outcome.signalName,
    durationMs,
    timedOut: outcome.timedOut,
    killed: outcome.timedOut || outcome.aborted,
    partial,
    stats: parsed.stats,
    failures: parsed.failures,
    failuresTruncated: parsed.failuresTruncated,
    stdoutTail: tail(outcome.stdout),
    stderrTail: tail(outcome.stderr),
    truncatedOutput: outcome.stdout.length + outcome.stderr.length > TAIL_CHARS,
    reportPath: rawReport ? reportPath : undefined,
    configPath: configPath ?? (parsed.configPath ? normalizePath(parsed.configPath) : undefined),
    command: displayCommand,
    autoRetry: autoRetryState.apply,
    lastFailed: options.lastFailed === true,
    errorKind,
    errorMessage,
    hint,
  };
}

/* ------------------------------------------------------------------ */
/* list-tests                                                          */
/* ------------------------------------------------------------------ */

async function runPlaywrightList(
  cli: string,
  options: ListTestsOptions,
  configPath: string | undefined,
): Promise<DiscoveredTest[]> {
  const root = normalizePath(options.projectRoot);
  const listReportPath = tempFilePath('pw-list', '.json');
  const args: string[] = ['test', '--list'];
  if (configPath) args.push('--config', toNativePath(configPath));
  args.push('--reporter=json');

  const env = childEnv({
    PLAYWRIGHT_JSON_OUTPUT_NAME: listReportPath,
    FORCE_COLOR: '0',
  });

  const outcome = await runProcess(process.execPath, [cli, ...args], {
    cwd: root,
    env,
    timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
    signal: options.signal,
  });

  if (outcome.spawnError) {
    throw new PlaywrightMcpError(outcome.spawnError.message, 'SPAWN_FAILED', {
      hint:
        outcome.spawnError.code === 'EBUSY'
          ? 'The server is at its limit of concurrent runs; retry when one finishes.'
          : 'Could not start Playwright.',
    });
  }

  const raw =
    (await readFileText(listReportPath)) ?? extractJsonFromText(outcome.stdout) ?? undefined;

  if (raw === undefined) {
    const diagnosis = diagnoseOutput(outcome.stderr || outcome.stdout);
    throw new PlaywrightMcpError(
      diagnosis?.errorMessage ?? '`playwright test --list` produced no output.',
      diagnosis?.errorKind ?? 'REPORT_MISSING',
      { hint: diagnosis?.hint ?? 'Check that the config compiles and at least one test file exists.' },
    );
  }

  const parsed = parseReportJson(raw, root);
  if (parsed.tests.length === 0 && outcome.code !== 0) {
    const diagnosis = diagnoseOutput(outcome.stderr || outcome.stdout);
    throw new PlaywrightMcpError(
      diagnosis?.errorMessage ?? parsed.parseError ?? '`playwright test --list` failed.',
      diagnosis?.errorKind ?? 'REPORT_MISSING',
      { hint: diagnosis?.hint ?? 'See stderr for details.' },
    );
  }
  return parsed.tests;
}

/** List tests via `playwright test --list`, falling back to file scan. */
export async function listTests(options: ListTestsOptions): Promise<ListTestsResult> {
  const root = normalizePath(options.projectRoot);
  const limit = clampInt(options.limit, 1, 5_000) ?? 500;
  const testDir = options.testDir ?? null;
  let error: ListTestsResult['error'];
  let collected: DiscoveredTest[] = [];
  let source: ListTestsResult['source'] = 'file-scan';
  let listedOk = false;

  let configPath: string | undefined;
  if (options.configPath) {
    configPath = normalizePath(options.configPath);
    if (!(await fileExists(configPath))) {
      throw new PlaywrightMcpError(`Config file not found: ${configPath}`, 'NO_CONFIG');
    }
  }

  const cli = options.noSpawn ? null : await resolvePlaywrightCli(root);
  if (options.noSpawn) {
    // Source scan only (restricted callers); not an error.
  } else if (cli === null) {
    const detection = await detectProject(root);
    const { message, hint } = missingPlaywrightMessage(detection);
    error = { kind: 'NO_PLAYWRIGHT', message, hint };
  } else {
    try {
      collected = await runPlaywrightList(cli, options, configPath);
      source = 'playwright-list';
      listedOk = true;
    } catch (err) {
      const mcpError =
        err instanceof PlaywrightMcpError
          ? err
          : new PlaywrightMcpError(err instanceof Error ? err.message : String(err), 'UNKNOWN');
      error = { kind: mcpError.kind, message: mcpError.message, hint: mcpError.hint };
      logger.warn('playwright --list failed; falling back to file scan', { error: mcpError.message });
    }
  }

  if (!listedOk) {
    const files = await findTestFiles(root, { testDir, limit: 200 });
    for (const file of files) {
      const content = await readFileText(path.join(root, file));
      if (content === null) continue;
      for (const entry of extractTestTitles(content)) {
        collected.push({ file, title: entry.title, line: entry.line });
      }
    }
    source = 'file-scan';
  }

  const filter = options.filter?.trim().toLowerCase();
  const filtered = filter
    ? collected.filter((test) => `${test.file} › ${test.title}`.toLowerCase().includes(filter))
    : collected;

  const tests = filtered.slice(0, limit);
  return {
    tests,
    total: filtered.length,
    truncated: filtered.length > tests.length,
    testDir,
    source,
    error,
  };
}
