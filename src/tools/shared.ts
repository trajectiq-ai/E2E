/**
 * Shared plumbing for the five MCP tools: response formatting, project
 * root/config resolution, failure rendering, and the browser-inspection
 * child script used by inspect-page and validate-selector.
 *
 * (This file is an implementation detail; the five tool modules remain
 * the public surface documented in the README.)
 */

import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  ErrorKind,
  FailureKind,
  LastRunRecord,
  ProjectDetection,
  TestFailure,
  ToolContext,
  ToolResponse,
  ToolStore,
} from '../types/index.js';
import { PlaywrightMcpError, toPlaywrightMcpError } from '../types/index.js';
import {
  assertRealPathInside,
  isPathInside,
  normalizePath,
  resolvePath,
  relativeToRoot,
  sanitizeUserPath,
  tempFilePath,
  toNativePath,
} from '../utils/path-utils.js';
import { formatLocator, parseLocator } from '../utils/locator-expr.js';
import type { LocatorCall } from '../utils/locator-expr.js';
import { PROBE_SCRIPT } from './probe-script.js';
import { selectConfig } from '../utils/project-detector.js';
import { childEnv, runProcess } from '../utils/playwright-runner.js';
import { extractJsonFromText } from '../utils/report-parser.js';
import { BLOCKED_RANGES, assertUrlAllowed, blockPrivateUrls } from '../utils/url-policy.js';

/* ------------------------------------------------------------------ */
/* State + responses                                                   */
/* ------------------------------------------------------------------ */

export function createToolStore(): ToolStore {
  let lastRun: LastRunRecord | null = null;
  return {
    get lastRun(): LastRunRecord | null {
      return lastRun;
    },
    setLastRun(record: LastRunRecord): void {
      lastRun = record;
    },
  };
}

export function toolText(markdown: string): ToolResponse {
  return { content: [{ type: 'text', text: markdown }] };
}

export function toolError(
  kind: ErrorKind | 'ERROR',
  message: string,
  hint?: string,
  details?: string,
): ToolResponse {
  const lines = [`## ❌ ${kind}`, '', message];
  if (hint) lines.push('', '**How to fix:**', hint);
  if (details) lines.push('', '```text', details.trim(), '```');
  return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
}

/** Run a tool body, converting any thrown error into a tool response. */
export async function guard(label: string, fn: () => Promise<ToolResponse>): Promise<ToolResponse> {
  try {
    return await fn();
  } catch (err) {
    const error = toPlaywrightMcpError(err);
    return toolError(error.kind, `**${label}** failed: ${error.message}`, error.hint, error.details);
  }
}

/* ------------------------------------------------------------------ */
/* Project root + config resolution                                    */
/* ------------------------------------------------------------------ */

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Directories a caller may pick as `projectRoot`: the server's default root
 * plus any listed in PW_MCP_ALLOWED_ROOTS (separated by the platform's
 * path delimiter, `:` or `;`).
 */
export function allowedProjectRoots(defaultRoot: string): string[] {
  const extra = (process.env.PW_MCP_ALLOWED_ROOTS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return [defaultRoot, ...extra].map((entry) => normalizePath(entry));
}

/**
 * Resolve the project root: defaults to the server's working directory;
 * an explicit value is resolved against it, must exist, and must sit
 * inside the default root or a PW_MCP_ALLOWED_ROOTS entry (symlinks
 * resolved), so a caller cannot point the tools at an arbitrary directory.
 */
export async function resolveProjectRoot(
  input: string | undefined,
  ctx: ToolContext,
): Promise<string> {
  const base = normalizePath(ctx.projectRoot);
  if (input === undefined || input.trim() === '') return base;
  if (ctx.restricted) {
    throw new PlaywrightMcpError('projectRoot cannot be changed on this server', 'INVALID_PATH', {
      hint: 'Omit projectRoot; this endpoint only serves its configured project.',
    });
  }
  const resolved = normalizePath(resolvePath(base, input.trim()));
  const allowed = allowedProjectRoots(base);
  // Check the allowlist before existence, so the error does not reveal
  // which directories exist outside the allowed roots.
  if (!allowed.some((root) => isPathInside(resolved, root))) {
    throw new PlaywrightMcpError(`Project root ${resolved} is outside the allowed roots`, 'INVALID_PATH', {
      hint: 'projectRoot must be inside the server\'s project root or a PW_MCP_ALLOWED_ROOTS entry.',
    });
  }
  if (!(await isDirectory(resolved))) {
    throw new PlaywrightMcpError(`Project root not found: ${resolved}`, 'INVALID_PATH', {
      hint: 'Pass `projectRoot` as an existing directory (absolute, or relative to the server working directory).',
    });
  }
  for (const root of allowed) {
    if (!isPathInside(resolved, root)) continue;
    try {
      await assertRealPathInside(resolved, root);
      return resolved;
    } catch {
      /* try the next allowed root */
    }
  }
  throw new PlaywrightMcpError(`Project root ${resolved} is outside the allowed roots`, 'INVALID_PATH', {
    hint: 'projectRoot resolves (through a symlink) outside the server\'s project root and PW_MCP_ALLOWED_ROOTS.',
  });
}

/**
 * Choose the playwright.config for a run/list. Throws MULTIPLE_CONFIGS
 * (with a numbered menu) when the project has several and none chosen.
 */
export function resolveConfigSelection(
  detection: ProjectDetection,
  selection?: string,
): string | undefined {
  const candidates = detection.configCandidates;
  if (candidates.length === 0) {
    if (selection) {
      throw new PlaywrightMcpError(`No config file exists to match "${selection}"`, 'NO_CONFIG', {
        hint: `This project has no playwright.config.* file. Looked in ${detection.root}.`,
      });
    }
    return undefined;
  }

  if (selection !== undefined && selection.trim() !== '') {
    const trimmed = selection.trim();
    // Numeric selections are 1-based indexes into the candidate list.
    const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
    const picked = numeric !== undefined ? selectConfig(candidates, numeric) : selectConfig(candidates, trimmed);
    if (!picked) {
      const sanitized = sanitizeUserPath(trimmed, detection.root);
      if (!candidates.includes(sanitized)) {
        throw new PlaywrightMcpError(`No config file matches "${selection}"`, 'NO_CONFIG', {
          hint: `Available configs:\n${candidates.map((c, i) => `  ${i + 1}. ${normalizePath(c)}`).join('\n')}`,
        });
      }
      return sanitized;
    }
    return picked;
  }

  if (candidates.length === 1) return candidates[0];

  const menu = candidates
    .map((c, i) => `${i + 1}. ${normalizePath(c).replace(`${detection.root}/`, '')}`)
    .join('\n');
  throw new PlaywrightMcpError(
    `Multiple playwright.config files found in ${detection.root}`,
    'MULTIPLE_CONFIGS',
    {
      hint: `Pass \`config\` with the number or path of the one to use:\n${menu}`,
      details: candidates.join('\n'),
    },
  );
}

/** Validate a user-supplied test path (supports the `file:line` suffix). */
export function sanitizeTestPathArgument(input: string, root: string): string {
  const trimmed = input.trim();
  const lineMatch = /:(\d+)$/.exec(trimmed);
  const pathPart = lineMatch ? trimmed.slice(0, -lineMatch[0].length) : trimmed;
  const suffix = lineMatch ? lineMatch[0] : '';
  const absolute = sanitizeUserPath(pathPart, root);
  return `${absolute}${suffix}`;
}

/** True when the path portion of a `file:line` argument exists. */
export async function testPathExists(argument: string, root: string): Promise<boolean> {
  const lineMatch = /:(\d+)$/.exec(argument);
  const pathPart = lineMatch ? argument.slice(0, -lineMatch[0].length) : argument;
  try {
    await stat(resolvePath(root, pathPart));
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export function codeFence(text: string, lang = ''): string {
  const body = text.trim();
  const safe = body.includes('```') ? body.replace(/```/g, "'''") : body;
  return ['```' + lang, safe, '```'].join('\n');
}

export function clipLines(text: string, maxLines: number, maxChars = 4_000): string {
  const lines = text.split(/\r?\n/);
  const clipped = lines.length > maxLines ? lines.slice(0, maxLines).join('\n') : text;
  const final =
    lines.length > maxLines
      ? `${clipped}\n… (${lines.length - maxLines} more line${lines.length - maxLines === 1 ? '' : 's'})`
      : clipped;
  return final.length > maxChars ? `${final.slice(0, maxChars)}…` : final;
}

export function renderFailure(failure: TestFailure, index: number, total: number): string {
  const location = failure.file ? `\`${failure.file}${failure.line ? `:${failure.line}` : ''}\`` : '_config_';
  const meta = [
    failure.status,
    failure.failureKind !== 'unknown' ? failure.failureKind : undefined,
    failure.project,
    failure.retry !== undefined && failure.retry > 0 ? `retry ${failure.retry + 1}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [
    `### ${index + 1} of ${total}. ${failure.title}`,
    `**File:** ${location}  |  **${meta}**`,
  ];
  lines.push('', codeFence(clipLines(failure.message, 25), 'text'));
  if (failure.expected !== undefined || failure.actual !== undefined) {
    lines.push(
      '',
      `- **Expected:** ${failure.expected === undefined ? '—' : `\`${clipLines(failure.expected, 5, 300)}\``}`,
      `- **Actual:** ${failure.actual === undefined ? '—' : `\`${clipLines(failure.actual, 5, 300)}\``}`,
    );
  }
  return lines.join('\n');
}

const KIND_HINTS: Record<FailureKind, string> = {
  assertion:
    'The assertion failed. Compare expected vs actual above, and check the code frame for the exact line.',
  timeout:
    'The step never completed. Look for a missing `await`, an element that never appears, or a page that hangs — raise the timeout only if the app really needs longer.',
  'browser-crash':
    'The browser crashed or closed early. Retry the run; if it persists run `npx playwright install --force` and close other automation browsers.',
  syntax: 'Fix the syntax error in the file shown above, then re-run.',
  config:
    'Playwright rejected the configuration or found no tests. Check `playwright.config.*` (projects, testDir, grep) and try again.',
  'server-unreachable':
    'The app under test was not reachable. Start your dev server (e.g. `npm run dev`) and keep it running, or configure `webServer` in playwright.config.*.',
  unknown: 'Inspect the stack trace and run the single test with `headed: true` to watch it live.',
};

export function failureHint(kind: FailureKind): string {
  return KIND_HINTS[kind] ?? KIND_HINTS.unknown;
}

/* ------------------------------------------------------------------ */
/* Page state: login sessions and steps to reach a UI state            */
/* ------------------------------------------------------------------ */

const ACTION_TYPES = ['goto', 'click', 'dblclick', 'hover', 'fill', 'press', 'check', 'uncheck', 'select', 'wait'] as const;

export const pageActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  locator: z.string().optional().describe("Locator or selector, e.g. getByRole('button', { name: 'Next' })"),
  value: z.string().optional().describe('fill text, press key, select option'),
  url: z.string().optional().describe('goto target (may be relative)'),
  ms: z.number().int().min(0).max(10_000).optional().describe('wait without locator'),
});

/** Signed-in session inputs. */
export const sessionShape = {
  storageState: z
    .string()
    .optional()
    .describe('Logged-in session: storageState JSON inside the project, e.g. playwright/.auth/user.json'),
  headers: z.record(z.string(), z.string()).optional().describe('Extra HTTP headers, e.g. Authorization'),
};

/** Inputs shared by every tool that opens a page. */
export const pageStateShape = {
  ...sessionShape,
  actions: z.array(pageActionSchema).max(20).optional().describe('Steps run after load to reach a state (modal, step 3)'),
  viewport: z
    .object({ width: z.number().int().min(200).max(4_000), height: z.number().int().min(200).max(4_000) })
    .optional(),
};

export interface PageStateInput {
  storageState?: string;
  headers?: Record<string, string>;
  actions?: Array<z.infer<typeof pageActionSchema>>;
  viewport?: { width: number; height: number };
}

export interface ResolvedPageState {
  storageState?: string;
  headers?: Record<string, string>;
  actions?: Array<{ type: string; label: string; locator?: LocatorCall[]; value?: string; url?: string; ms?: number }>;
  viewport?: { width: number; height: number };
}

const NEEDS_LOCATOR = new Set(['click', 'dblclick', 'hover', 'fill', 'check', 'uncheck', 'select']);

/**
 * Validate page-state inputs: the storageState file must sit inside the
 * project root (symlinks resolved) and parse as JSON, every goto URL passes
 * the same URL policy as the entry URL, and locators are parsed into
 * whitelisted call chains (never evaluated as code).
 */
export async function resolvePageState(
  input: PageStateInput,
  root: string,
  entryUrl: string,
  ctx: ToolContext,
): Promise<ResolvedPageState> {
  const out: ResolvedPageState = {};
  const statePath = input.storageState ?? (process.env.PW_MCP_STORAGE_STATE || undefined);
  if (statePath !== undefined && statePath.trim() !== '') {
    if (ctx.restricted) {
      throw new PlaywrightMcpError('storageState is not available on this server', 'INVALID_PATH', {
        hint: 'This endpoint does not read files from the project.',
      });
    }
    const absolute = sanitizeUserPath(statePath.trim(), root);
    await assertRealPathInside(absolute, root);
    let raw: string;
    try {
      raw = await readFile(absolute, 'utf8');
    } catch {
      throw new PlaywrightMcpError(`storageState file not found: ${relativeToRoot(root, absolute)}`, 'INVALID_PATH', {
        hint: 'Create it with a Playwright setup project (await page.context().storageState({ path })) or `npx playwright codegen --save-storage=playwright/.auth/user.json <url>`.',
      });
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    } catch {
      throw new PlaywrightMcpError(`storageState is not valid JSON: ${relativeToRoot(root, absolute)}`, 'INVALID_PATH', {
        hint: 'Pass the JSON file Playwright writes with context.storageState({ path }).',
      });
    }
    out.storageState = toNativePath(absolute);
  }
  if (input.headers && Object.keys(input.headers).length > 0) {
    for (const [name, value] of Object.entries(input.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) {
        throw new PlaywrightMcpError(`Invalid HTTP header "${name}"`, 'INVALID_PATH', {
          hint: 'Header names must be tokens and values must be single-line.',
        });
      }
    }
    out.headers = input.headers;
  }
  if (input.viewport) out.viewport = input.viewport;
  if (input.actions && input.actions.length > 0) {
    out.actions = [];
    let current = entryUrl;
    for (const [i, action] of input.actions.entries()) {
      const step = `actions[${i}] (${action.type})`;
      if (action.type === 'goto') {
        if (!action.url) throw new PlaywrightMcpError(`${step} needs a url`, 'INVALID_PATH');
        let next: string;
        try {
          next = new URL(action.url, current).toString();
        } catch {
          throw new PlaywrightMcpError(`${step}: "${action.url}" is not a valid URL`, 'INVALID_PATH');
        }
        assertHttpUrl(next);
        await assertUrlAllowed(next);
        current = next;
        out.actions.push({ type: 'goto', label: `goto ${next}`, url: next });
        continue;
      }
      if (NEEDS_LOCATOR.has(action.type) && !action.locator) {
        throw new PlaywrightMcpError(`${step} needs a locator`, 'INVALID_PATH');
      }
      if ((action.type === 'press' || action.type === 'select') && action.value === undefined) {
        throw new PlaywrightMcpError(`${step} needs a value`, 'INVALID_PATH');
      }
      const locator = action.locator ? parseLocator(action.locator) : undefined;
      out.actions.push({
        type: action.type,
        label: `${action.type}${locator ? ` ${formatLocator(locator)}` : ''}${action.type === 'press' ? ` ${action.value}` : ''}`,
        locator,
        value: action.value,
        ms: action.ms,
      });
    }
  }
  return out;
}

/** One line describing the page state, for tool output headers. */
export function describePageState(state: ResolvedPageState, root: string): string | undefined {
  const parts: string[] = [];
  if (state.storageState) parts.push(`session \`${relativeToRoot(root, state.storageState)}\``);
  if (state.headers) parts.push(`${Object.keys(state.headers).length} extra header(s)`);
  if (state.actions?.length) parts.push(`${state.actions.length} step(s) run first`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** A hint when an unauthenticated page landed on a login screen. */
export function loginHint(finalUrl: string | undefined, state: ResolvedPageState): string | undefined {
  if (state.storageState || !finalUrl) return undefined;
  if (!/(log-?in|sign-?in|auth|sso|oauth)/i.test(new URL(finalUrl).pathname)) return undefined;
  return 'This looks like a login page. Pass `storageState` (a Playwright session file such as playwright/.auth/user.json) to inspect the page as a signed-in user, or `actions` to log in first.';
}

/* ------------------------------------------------------------------ */
/* Browser child script                                                */
/* ------------------------------------------------------------------ */

export interface BrowserScriptConfig extends Omit<ResolvedPageState, never> {
  mode: 'inspect' | 'validate' | 'screenshot' | 'heal';
  projectRoot: string;
  /** Page to open; omitted when rendering a snapshot. */
  url?: string;
  /** Render this DOM snapshot file instead of navigating (all requests blocked). */
  snapshotHtmlPath?: string;
  /** CSS selector for inspect mode. */
  selector?: string;
  /** Parsed locator chain for validate / screenshot modes. */
  selectorChain?: LocatorCall[];
  /** inspect: 'elements' (DOM inventory) or 'locators' (compact locator map). */
  view?: 'elements' | 'locators';
  /** heal: words from the broken locator, and its role when it had one. */
  healTokens?: string[];
  healRole?: string;
  waitFor?: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  includeHtml?: boolean;
  maxHtmlChars?: number;
  gotoTimeout?: number;
  waitTimeout?: number;
  actionTimeout?: number;
  /** Screenshot target path (mode: 'screenshot'). */
  screenshotPath?: string;
  /** Capture the full scrollable page (mode: 'screenshot'). */
  fullPage?: boolean;
  startedAt: number;
}

export interface BrowserScriptData {
  title?: string;
  finalUrl?: string;
  screenshotPath?: string;
  elementCount: number;
  matchCount: number;
  elements: import('../types/index.js').ElementInfo[];
  html?: string;
  htmlTruncated?: boolean;
  viewport?: { width: number; height: number };
  parseError?: string;
  consoleMessages?: import('../types/index.js').ConsoleMessageInfo[];
  /** Page actions that completed before inspection. */
  actionsDone?: string[];
  durationMs?: number;
}

/** Best verified locator for an element, as source text. */
export function bestLocator(element: import('../types/index.js').ElementInfo): string | undefined {
  const chain = element.locators?.[0];
  return chain ? formatLocator(chain) : undefined;
}

export interface BrowserScriptOutcome {
  ok: boolean;
  /** Page actions that completed before a failure. */
  actionsDone?: string[];
  data?: BrowserScriptData;
  kind?: ErrorKind;
  error?: string;
  hint?: string;
  stderrTail?: string;
}

/**
 * Write the probe script to a temp file and run it with the project's
 * Playwright, killing the whole tree on timeout or client disconnect.
 */
export async function runBrowserScript(
  config: BrowserScriptConfig,
  options: { timeoutMs?: number; signal?: AbortSignal },
): Promise<BrowserScriptOutcome> {
  const scriptPath = tempFilePath('pw-mcp-probe', '.cjs');
  const configPath = tempFilePath('pw-mcp-probe', '.json');
  await writeFile(scriptPath, PROBE_SCRIPT, 'utf8');
  // The config travels in a file: actions and snapshot paths can outgrow
  // the Windows command-line limit.
  await writeFile(
    configPath,
    JSON.stringify({ ...config, blockPrivate: blockPrivateUrls(), blockedRanges: BLOCKED_RANGES }),
    'utf8',
  );

  try {
    const outcome = await runProcess(
      process.execPath,
      [scriptPath, configPath],
      {
        cwd: config.projectRoot,
        env: childEnv({ FORCE_COLOR: '0' }),
        timeoutMs: options.timeoutMs ?? 45_000,
        signal: options.signal,
      },
    );

    if (outcome.spawnError) {
      return {
        ok: false,
        kind: 'SPAWN_FAILED',
        error: outcome.spawnError.message,
        hint: 'Could not start a Node child process to inspect the page.',
      };
    }
    if (outcome.aborted) {
      return { ok: false, kind: 'CLIENT_DISCONNECT', error: 'Inspection aborted (client disconnected).' };
    }

    const json = extractJsonFromText(outcome.stdout);
    if (json !== null) {
      try {
        const parsed = JSON.parse(json) as
          | { ok: true; data: BrowserScriptData }
          | { ok: false; kind?: ErrorKind; error?: string; hint?: string; actionsDone?: string[] };
        if (parsed.ok) return { ok: true, data: parsed.data };
        return {
          ok: false,
          kind: parsed.kind ?? 'UNKNOWN',
          error: parsed.error ?? 'Inspection failed.',
          hint: parsed.hint,
          actionsDone: parsed.actionsDone,
          stderrTail: tailText(outcome.stderr),
        };
      } catch {
        /* fall through to generic handling */
      }
    }

    if (outcome.timedOut) {
      return {
        ok: false,
        kind: 'TIMEOUT',
        error: `Page inspection exceeded ${options.timeoutMs ?? 45_000}ms and was killed.`,
        hint: 'The page may be blocking on network requests. Raise timeoutMs or use waitUntil: "domcontentloaded".',
        stderrTail: tailText(outcome.stderr),
      };
    }
    return {
      ok: false,
      kind: 'UNKNOWN',
      error: 'The inspection process produced no parseable output.',
      hint: 'Check that the page loads and that Playwright is installed correctly.',
      stderrTail: tailText(outcome.stderr),
    };
  } finally {
    await rm(scriptPath, { force: true }).catch(() => undefined);
    await rm(configPath, { force: true }).catch(() => undefined);
  }
}

function tailText(text: string, limit = 2_000): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? trimmed.slice(-limit) : trimmed;
}

/** Accept only http(s) URLs for page-facing tools. */
export function assertHttpUrl(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new PlaywrightMcpError(`"${url}" is not a valid URL`, 'INVALID_PATH', {
      hint: 'Use a full URL, e.g. http://localhost:3000/login',
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PlaywrightMcpError(`Unsupported URL scheme "${parsed.protocol}"`, 'INVALID_PATH', {
      hint: 'Only http:// and https:// URLs are supported.',
    });
  }
  return parsed.toString();
}
