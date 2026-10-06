/**
 * Shared plumbing for the five MCP tools: response formatting, project
 * root/config resolution, failure rendering, and the browser-inspection
 * child script used by inspect-page and validate-selector.
 *
 * (This file is an implementation detail; the five tool modules remain
 * the public surface documented in the README.)
 */

import { rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
  sanitizeUserPath,
  tempFilePath,
} from '../utils/path-utils.js';
import { selectConfig } from '../utils/project-detector.js';
import { childEnv, runProcess } from '../utils/playwright-runner.js';
import { extractJsonFromText } from '../utils/report-parser.js';

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
  const resolved = normalizePath(resolvePath(base, input.trim()));
  if (!(await isDirectory(resolved))) {
    throw new PlaywrightMcpError(`Project root not found: ${resolved}`, 'INVALID_PATH', {
      hint: 'Pass `projectRoot` as an existing directory (absolute, or relative to the server working directory).',
    });
  }
  const allowed = allowedProjectRoots(base);
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
    hint: `projectRoot must be inside ${allowed.join(' or ')}. Start the server with PW_MCP_PROJECT_ROOT, or add the directory to PW_MCP_ALLOWED_ROOTS.`,
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

export function isInsideRoot(path: string, root: string): boolean {
  return isPathInside(path, root);
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
/* Browser child script (inspect-page / validate-selector)             */
/* ------------------------------------------------------------------ */

/**
 * Runs inside a child `node` process with cwd = project root so that
 * `createRequire(projectRoot/package.json)` resolves the *user's*
 * Playwright install (browsers included). Writes one JSON document to
 * stdout and always exits, so it can never wedge the server.
 */
const PROBE_SCRIPT = String.raw`
'use strict';
const cfg = JSON.parse(process.argv[2]);

function send(payload) {
  try { process.stdout.write(JSON.stringify(payload)); } catch (err) { /* ignore */ }
}

function classifyError(message) {
  const m = String(message);
  if (/Executable doesn't exist|Please run the following command to install/i.test(m)) {
    return { kind: 'NO_PLAYWRIGHT', hint: 'Playwright browsers are not installed for this project. Run: npx playwright install chromium' };
  }
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_EMPTY_RESPONSE|getaddrinfo|net::ERR_/i.test(m)) {
    return { kind: 'SERVER_NOT_RUNNING', hint: 'The URL is not reachable. Start your dev server (e.g. npm run dev / npm start) and retry.' };
  }
  if (/Timeout \d+ms exceeded|timed out/i.test(m)) {
    return { kind: 'TIMEOUT', hint: 'Raise timeoutMs, or make the page load faster.' };
  }
  if (/Target closed|browser has been closed|browser has crashed|Page crashed/i.test(m)) {
    return { kind: 'BROWSER_CRASH', hint: 'The browser crashed during inspection. Retry; if it persists run: npx playwright install --force' };
  }
  if (/Unknown selector|error evaluating selector/i.test(m)) {
    return { kind: 'INVALID_PATH', hint: 'The selector could not be evaluated.' };
  }
  return { kind: 'UNKNOWN', hint: undefined };
}

(async () => {
  const { createRequire } = require('node:module');
  const req = createRequire(cfg.projectRoot + '/package.json');
  let pw = null;
  try {
    pw = req('playwright');
  } catch (errA) {
    try {
      pw = req('@playwright/test');
    } catch (errB) {
      send({
        ok: false,
        kind: 'NO_PLAYWRIGHT',
        error: 'Playwright is not installed in ' + cfg.projectRoot,
        hint: 'Run: npm install -D @playwright/test && npx playwright install',
      });
      process.exit(1);
    }
  }

  let browser = null;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    const consoleMessages = [];
    page.on('console', (msg) => {
      if (consoleMessages.length < 50) consoleMessages.push({ type: msg.type(), text: String(msg.text()).slice(0, 300) });
    });
    page.on('pageerror', (err) => {
      if (consoleMessages.length < 50) consoleMessages.push({ type: 'pageerror', text: String(err).slice(0, 300) });
    });

    await page.goto(cfg.url, { waitUntil: cfg.waitUntil || 'domcontentloaded', timeout: cfg.gotoTimeout || 15000 });
    if (cfg.waitFor) await page.waitForSelector(cfg.waitFor, { timeout: cfg.waitTimeout || 5000 });

    if (cfg.mode === 'screenshot') {
      if (cfg.selector) {
        await page.locator(cfg.selector).first().screenshot({ path: cfg.screenshotPath });
      } else {
        await page.screenshot({ path: cfg.screenshotPath, fullPage: !!cfg.fullPage });
      }
      send({
        ok: true,
        data: {
          screenshotPath: cfg.screenshotPath,
          title: await page.title(),
          finalUrl: page.url(),
          viewport: page.viewportSize() || { width: 1280, height: 720 },
          elementCount: 0,
          matchCount: 0,
          elements: [],
          durationMs: Date.now() - cfg.startedAt,
        },
      });
      await browser.close();
      process.exit(0);
    }

    const data = await page.evaluate((input) => {
      function uniqueSelector(el) {
        if (el.id) {
          const css = '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
          try { if (document.querySelectorAll(css).length === 1) return css; } catch (err) { /* fall through */ }
        }
        const parts = [];
        let node = el;
        while (node && node.nodeType === 1 && parts.length < 6) {
          if (node === document.documentElement) { parts.unshift('html'); break; }
          let part = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.prototype.filter.call(parent.children, (child) => child.tagName === node.tagName);
            if (siblings.length > 1) {
              const index = Array.prototype.indexOf.call(siblings, node) + 1;
              part = part + ':nth-of-type(' + index + ')';
            }
          }
          parts.unshift(part);
          const candidate = parts.join(' > ');
          try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (err) { /* keep walking */ }
          node = node.parentElement;
        }
        return parts.join(' > ');
      }

      function describe(el) {
        const rect = el.getBoundingClientRect();
        let visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        try {
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') visible = false;
        } catch (err) { /* ignore */ }
        const attributes = {};
        const attrCount = Math.min(el.attributes.length, 30);
        for (let i = 0; i < attrCount; i += 1) {
          const attr = el.attributes[i];
          attributes[attr.name] = String(attr.value).slice(0, 200);
        }
        const classes = Array.prototype.slice.call(el.classList).slice(0, 10);
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
        return {
          selector: uniqueSelector(el),
          tag: el.tagName.toLowerCase(),
          id: el.id || undefined,
          classes: classes,
          role: el.getAttribute('role') || undefined,
          text: text || undefined,
          attributes: attributes,
          visible: visible,
          box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        };
      }

      const result = { matchCount: 0, elementCount: 0, elements: [], parseError: undefined };
      let source = [];
      if (input.selector) {
        try {
          source = Array.prototype.slice.call(document.querySelectorAll(input.selector));
        } catch (err) {
          result.parseError = err && err.message ? err.message : String(err);
        }
      } else {
        source = Array.prototype.slice.call(document.querySelectorAll('*'));
      }
      if (result.parseError) return result;

      result.matchCount = source.length;
      result.elementCount = source.length;
      const limit = input.mode === 'validate' ? 5 : 100;
      result.elements = source.slice(0, limit).map(describe);

      if (input.mode === 'inspect') {
        result.title = document.title;
        result.finalUrl = location.href;
        result.viewport = { width: window.innerWidth, height: window.innerHeight };
        if (input.includeHtml) {
          const html = document.documentElement.outerHTML;
          result.html = html.slice(0, input.maxHtml);
          result.htmlTruncated = html.length > input.maxHtml;
        }
      }
      return result;
    }, {
      mode: cfg.mode,
      selector: cfg.selector,
      includeHtml: !!cfg.includeHtml,
      maxHtml: cfg.maxHtmlChars || 20000,
    });

    data.consoleMessages = consoleMessages;
    data.durationMs = Date.now() - cfg.startedAt;
    send({ ok: true, data: data });
    await browser.close();
    process.exit(0);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const classified = classifyError(message);
    send({ ok: false, kind: classified.kind, error: message, hint: classified.hint });
    try { if (browser) await browser.close(); } catch (closeErr) { /* ignore */ }
    process.exit(1);
  }
})().catch((err) => {
  send({ ok: false, kind: 'UNKNOWN', error: err && err.message ? err.message : String(err) });
  process.exit(1);
});
`;

export interface BrowserScriptConfig {
  mode: 'inspect' | 'validate' | 'screenshot';
  projectRoot: string;
  url: string;
  selector?: string;
  waitFor?: string;
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle';
  includeHtml?: boolean;
  maxHtmlChars?: number;
  gotoTimeout?: number;
  waitTimeout?: number;
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
  durationMs?: number;
}

export interface BrowserScriptOutcome {
  ok: boolean;
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
  await writeFile(scriptPath, PROBE_SCRIPT, 'utf8');

  try {
    const outcome = await runProcess(
      process.execPath,
      [scriptPath, JSON.stringify(config)],
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
          | { ok: false; kind?: ErrorKind; error?: string; hint?: string };
        if (parsed.ok) return { ok: true, data: parsed.data };
        return {
          ok: false,
          kind: parsed.kind ?? 'UNKNOWN',
          error: parsed.error ?? 'Inspection failed.',
          hint: parsed.hint,
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
