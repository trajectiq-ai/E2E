/**
 * Tool 9 — suggest-fix: turn a failure from the last run into a concrete
 * patch for the spec, optionally apply it, and prove it by re-running the
 * test (reverting the file when the re-run still fails).
 *
 * Handles the two most common E2E breakages:
 * - Locator drift: the element is still on the page but its test id, text
 *   or structure changed. The broken locator's words are matched against
 *   the DOM at failure (from the Playwright trace, or a live URL), and the
 *   best match gets a Playwright locator proven unique on that page.
 * - Copy changes in text assertions (toHaveText & co): the expected string
 *   is replaced with what the page shows. That can hide a real regression,
 *   so it is applied only with allowExpectationUpdate.
 *
 * When no element plausibly matches, the tool says so: a missing element is
 * usually an app bug, and "healing" it would hide the bug.
 */

import { readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { ElementInfo, RunTestResult, TestFailure, ToolContext, ToolResponse } from '../types/index.js';
import { readFailureTrace } from '../utils/trace-reader.js';
import { runTests } from '../utils/playwright-runner.js';
import { detectProject } from '../utils/project-detector.js';
import { recordRun } from '../utils/run-history.js';
import {
  assertRealPathInside,
  isTestFile,
  sanitizeUserPath,
  tempFilePath,
  writeFileInsideRoot,
} from '../utils/path-utils.js';
import { formatLocator, parseLocator, quote } from '../utils/locator-expr.js';
import type { LocatorCall } from '../utils/locator-expr.js';
import { assertUrlAllowed } from '../utils/url-policy.js';
import {
  assertHttpUrl,
  bestLocator,
  clipLines,
  codeFence,
  formatDuration,
  guard,
  resolveConfigSelection,
  resolvePageState,
  resolveProjectRoot,
  runBrowserScript,
  sessionShape,
  toolText,
} from './shared.js';
import { allFailures } from './get-failure.js';

const suggestFixInput = z.object({
  index: z.number().int().min(1).optional().describe('1-based failure index (default 1)'),
  projectRoot: z.string().optional(),
  url: z.string().optional().describe('Heal against this live page instead of the trace snapshot'),
  ...sessionShape,
  apply: z.boolean().optional().describe('Write the fix (default: diff only)'),
  verify: z.boolean().optional().describe('Re-run after applying; revert if still failing (default true)'),
  allowExpectationUpdate: z.boolean().optional().describe('Allow applying changed expected text (can hide regressions)'),
  config: z.string().optional().describe('playwright.config path or 1-based index'),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional().describe('Verification run limit (default 120000)'),
});

export type SuggestFixInput = z.infer<typeof suggestFixInput>;
export const suggestFixSchema = suggestFixInput;

/* ------------------------------------------------------------------ */
/* Pure helpers (unit-tested)                                          */
/* ------------------------------------------------------------------ */

/** Pull the locator Playwright printed in the error ("Locator: …", "waiting for …"). */
export function brokenLocatorFromMessage(message: string): string | undefined {
  const lines = message.split(/\r?\n/);
  for (const line of lines) {
    const m = /(?:^|\s)(?:Locator:|waiting for)\s+((?:getBy\w+|locator)\(.*)$/.exec(line.trim());
    if (!m) continue;
    const text = m[1].trim();
    try {
      parseLocator(text);
      return text;
    } catch {
      /* not a clean expression; keep looking */
    }
  }
  return undefined;
}

const SYNONYMS: Record<string, string[]> = {
  btn: ['button'],
  nav: ['navigation'],
  img: ['image'],
  pwd: ['password'],
  msg: ['message'],
  qty: ['quantity'],
  cta: ['call', 'action'],
  submit: ['save', 'send'],
  signin: ['sign', 'login'],
  login: ['sign', 'signin'],
};

/** Words that say what kind of element it is, not which one. */
const GENERIC = new Set([
  'button', 'btn', 'link', 'input', 'field', 'text', 'label', 'icon', 'item', 'container', 'wrapper', 'div', 'span',
  'el', 'element', 'box', 'form', 'page', 'main', 'section', 'the', 'and', 'name', 'exact', 'true', 'false', 'id',
  'test', 'testid', 'data', 'role', 'heading', 'textbox', 'checkbox', 'option', 'locator', 'get', 'by', 'css',
]);

export interface HealTokens {
  /** All words to score elements with. */
  tokens: string[];
  /** The words that identify the element (what must match for a confident fix). */
  distinctive: string[];
  role?: string;
}

/** Split a broken locator into scoring words. */
export function healTokensFor(chain: LocatorCall[]): HealTokens {
  const words: string[] = [];
  let role: string | undefined;
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      words.push(
        ...value
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 1),
      );
    } else if (value && typeof value === 'object' && !('$regex' in value)) {
      for (const inner of Object.values(value)) collect(inner);
    } else if (value && typeof value === 'object' && '$regex' in value) {
      collect((value as { $regex: string }).$regex);
    }
  };
  for (const call of chain) {
    if (call.method === 'getByRole' && typeof call.args[0] === 'string') {
      role = call.args[0];
      for (const arg of call.args.slice(1)) collect(arg);
      continue;
    }
    if (call.method === 'locator' && typeof call.args[0] === 'string') {
      // Keep attribute values and ids/classes; drop CSS syntax and tag names.
      const css = call.args[0];
      const parts = [...css.matchAll(/[#.]([\w-]+)|=\s*["']?([^"'\]]+)/g)].map((m) => m[1] ?? m[2]);
      collect(parts.join(' '));
      continue;
    }
    for (const arg of call.args) collect(arg);
  }
  const expanded = new Set<string>();
  for (const word of words) {
    expanded.add(word);
    for (const syn of SYNONYMS[word] ?? []) expanded.add(syn);
  }
  const tokens = [...expanded];
  const distinctive = [...new Set(words.filter((w) => !GENERIC.has(w) && !/^\d+$/.test(w)))];
  return { tokens, distinctive, role };
}

export interface Confidence {
  level: 'high' | 'medium' | 'none';
  matched: string[];
}

/** How sure we are that `element` is what the broken locator meant. */
export function healConfidence(element: ElementInfo, heal: HealTokens, runnerUp?: ElementInfo): Confidence {
  const hay = [
    element.id,
    element.attributes['data-testid'],
    element.attributes['data-test-id'],
    element.attributes['data-test'],
    element.attributes.name,
    element.attributes['aria-label'],
    element.attributes.placeholder,
    element.attributes.title,
    element.attributes.alt,
    element.name,
    element.text,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  const words = new Set(hay.split(/[^a-z0-9]+/).filter(Boolean));
  const matched = heal.distinctive.filter(
    (token) => words.has(token) || [...words].some((w) => w.length > 2 && (w.startsWith(token) || token.startsWith(w))),
  );
  if (heal.distinctive.length === 0 || matched.length === 0) return { level: 'none', matched };
  const share = matched.length / heal.distinctive.length;
  const roleOk = heal.role === undefined || element.role === heal.role;
  const clearWinner = runnerUp === undefined || (element.score ?? 0) > (runnerUp.score ?? 0);
  if (share >= 0.5 && roleOk && clearWinner) return { level: 'high', matched };
  if (share >= 0.5 || (matched.length >= 1 && roleOk)) return { level: 'medium', matched };
  return { level: 'none', matched };
}

/** Find the source span of a locator's first call on a line, tolerant of quote style and spacing. */
export function findCallSpan(line: string, call: LocatorCall): { start: number; end: number } | undefined {
  const first = call.args[0];
  if (typeof first !== 'string') return undefined;
  const escaped = first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "(?:'|\\\\')").replace(/"/g, '(?:"|\\\\")');
  const re = new RegExp(`\\b${call.method}\\s*\\(\\s*(['"\`])${escaped}\\1`);
  const m = re.exec(line);
  if (!m) return undefined;
  // Walk to the matching close paren, skipping string contents.
  let depth = 0;
  let quoteChar: string | null = null;
  for (let i = m.index + call.method.length; i < line.length; i += 1) {
    const ch = line[i];
    if (quoteChar) {
      if (ch === '\\') i += 1;
      else if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quoteChar = ch;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { start: m.index, end: i + 1 };
    }
  }
  return undefined;
}

/** Line of the failing call inside `file`, from the stack ("…/file.spec.ts:18:47"). */
export function failingLine(failure: TestFailure): number | undefined {
  const text = `${failure.stack ?? ''}\n${failure.message}`;
  const base = failure.file.split('/').pop();
  if (!base) return failure.line;
  const re = new RegExp(`${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)(?::\\d+)?`, 'g');
  let found: number | undefined;
  for (const m of text.matchAll(re)) {
    found = Number(m[1]);
    break;
  }
  return found ?? failure.line;
}

/** Minimal unified diff for a single changed line. */
export function unifiedDiff(file: string, lines: string[], lineNo: number, replacement: string): string {
  const idx = lineNo - 1;
  const from = Math.max(0, idx - 2);
  const to = Math.min(lines.length, idx + 3);
  const out = [`--- a/${file}`, `+++ b/${file}`, `@@ -${from + 1},${to - from} +${from + 1},${to - from} @@`];
  for (let i = from; i < to; i += 1) {
    if (i === idx) {
      out.push(`-${lines[i]}`, `+${replacement}`);
    } else {
      out.push(` ${lines[i]}`);
    }
  }
  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* Tool                                                                */
/* ------------------------------------------------------------------ */

interface Proposal {
  kind: 'locator' | 'expectation';
  confidence: 'high' | 'medium' | 'low';
  lineNo: number;
  before: string;
  after: string;
  why: string;
  alternatives?: string[];
}

const EXPECTATION_MATCHERS = /toHaveText|toContainText|toHaveTitle|toHaveValue|toHaveAttribute|toHaveURL/;

async function proposeExpectationFix(failure: TestFailure, lines: string[], lineNo: number): Promise<Proposal | undefined> {
  if (failure.expected === undefined || failure.actual === undefined) return undefined;
  if (!EXPECTATION_MATCHERS.test(failure.message)) return undefined;
  const expected = failure.expected.replace(/^"|"$/g, '');
  const actual = failure.actual.replace(/^"|"$/g, '');
  if (expected === '' || actual === '' || actual.length > 200 || /\n/.test(actual)) return undefined;
  const line = lines[lineNo - 1] ?? '';
  for (const q of ["'", '"', '`']) {
    const literal = `${q}${expected}${q}`;
    const at = line.indexOf(literal);
    if (at < 0) continue;
    const replacement = q === "'" ? quote(actual) : `${q}${actual.replace(new RegExp(q, 'g'), `\\${q}`)}${q}`;
    return {
      kind: 'expectation',
      confidence: 'low',
      lineNo,
      before: line,
      after: line.slice(0, at) + replacement + line.slice(at + literal.length),
      why: `The page shows ${JSON.stringify(actual)} where the test expects ${JSON.stringify(expected)}. Update the expectation only if that copy change was intended; otherwise this is the bug.`,
    };
  }
  return undefined;
}

function renderHeader(failure: TestFailure, index: number, total: number): string[] {
  return [
    `## 🩹 Fix for failure ${index} of ${total} — ${failure.title}`,
    '',
    `**File:** \`${failure.file}${failure.line ? `:${failure.line}` : ''}\`  |  **Kind:** \`${failure.failureKind}\``,
    '',
  ];
}

export const suggestFixTool = {
  name: 'suggest-fix',
  description:
    "Patch a failure from the last run: a drifted locator is matched against the DOM at failure (trace, or live url) and replaced with one proven unique; changed copy gets the new expected text. Returns a diff and confidence; apply: true writes it, re-runs the test and reverts if still red. Refuses when the element is truly missing (app bug).",
  inputSchema: suggestFixSchema,
  handler: async (args: SuggestFixInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('suggest-fix', async () => {
      const record = ctx.store.lastRun;
      if (!record) {
        throw new PlaywrightMcpError('No test run has happened yet', 'REPORT_MISSING', {
          hint: 'Call run-test first; suggest-fix works on the failures of the most recent run.',
        });
      }
      const root = await resolveProjectRoot(args.projectRoot ?? record.projectRoot, ctx);
      const failures = await allFailures(record);
      if (failures.length === 0) return toolText('## ✅ Nothing to fix\n\nThe last run had no failures.');
      const index = Math.min(args.index ?? 1, failures.length);
      const failure = failures[index - 1];
      const out = renderHeader(failure, index, failures.length);

      if (!failure.file || !isTestFile(failure.file)) {
        out.push('No spec file is attached to this failure (it is a configuration or global error), so there is nothing to patch. Use **get-failure** for the details.');
        return toolText(out.join('\n'));
      }
      const specPath = sanitizeUserPath(failure.file, root);
      await assertRealPathInside(specPath, root);
      const source = await readFile(specPath, 'utf8');
      const eol = source.includes('\r\n') ? '\r\n' : '\n';
      const lines = source.split(/\r?\n/);
      const lineNo = failingLine(failure) ?? failure.line ?? 1;

      let proposal: Proposal | undefined;
      const notes: string[] = [];

      // 1. Locator drift.
      const brokenText = brokenLocatorFromMessage(failure.message);
      if (brokenText) {
        const chain = parseLocator(brokenText);
        const heal = healTokensFor(chain);
        let elements: ElementInfo[] = [];
        let domSource: string;
        const state = args.url ? await resolvePageState(args, root, assertHttpUrl(args.url), ctx) : {};
        let snapshotFile: string | undefined;
        try {
          if (args.url) {
            const url = assertHttpUrl(args.url);
            await assertUrlAllowed(url);
            domSource = `the live page ${url}`;
          } else {
            const trace = failure.tracePath ? await readFailureTrace(failure.tracePath, { maxHtmlChars: 2_000_000 }).catch(() => null) : null;
            if (!trace?.snapshotHtml) {
              throw new PlaywrightMcpError('The failure has no DOM snapshot to heal against', 'REPORT_MISSING', {
                hint: 'Pass `url` (plus storageState/actions if needed) so the fix is computed against the live page, or re-run the test so a trace is captured.',
              });
            }
            snapshotFile = tempFilePath('pw-mcp-snapshot', '.html');
            await writeFile(snapshotFile, trace.snapshotHtml, 'utf8');
            domSource = 'the DOM snapshot at failure (Playwright trace)';
          }
          const outcome = await runBrowserScript(
            {
              ...state,
              mode: 'heal',
              projectRoot: root,
              url: args.url ? assertHttpUrl(args.url) : undefined,
              snapshotHtmlPath: snapshotFile,
              healTokens: heal.tokens,
              healRole: heal.role,
              gotoTimeout: 30_000,
              startedAt: Date.now(),
            },
            { timeoutMs: 60_000, signal: ctx.signal },
          );
          if (!outcome.ok) {
            throw new PlaywrightMcpError(`Could not open ${domSource}: ${outcome.error ?? 'unknown error'}`, outcome.kind ?? 'UNKNOWN', {
              hint: outcome.hint,
            });
          }
          elements = outcome.data?.elements ?? [];
        } finally {
          if (snapshotFile) await rm(snapshotFile, { force: true }).catch(() => undefined);
        }

        const usable = elements.filter((element) => (element.locators?.length ?? 0) > 0);
        const best = usable[0];
        const confidence = best ? healConfidence(best, heal, usable[1]) : { level: 'none' as const, matched: [] };
        const line = lines[lineNo - 1] ?? '';
        const span = findCallSpan(line, chain[0]);

        if (!best || confidence.level === 'none') {
          notes.push(
            `**No confident replacement for \`${brokenText}\`** in ${domSource}. Nothing on the page matches ${
              heal.distinctive.length > 0 ? heal.distinctive.map((w) => `"${w}"`).join(', ') : 'its words'
            }${best ? ` (closest: \`${bestLocator(best)}\`, which shares only generic words)` : ''}.`,
            '',
            'The element is most likely **missing**, not renamed: the app did not render it (a real bug, a failed request, or a missing step before this line). Fixing the test would hide that. Check **get-failure** for failed requests and console errors first.',
          );
        } else if (!span) {
          notes.push(
            `Found the likely target: \`${bestLocator(best)}\`, but could not locate \`${formatLocator(chain.slice(0, 1))}\` on line ${lineNo} of \`${failure.file}\` to patch it automatically. Replace it by hand.`,
          );
        } else {
          const replacement = `${line.slice(0, span.start)}${bestLocator(best)}${line.slice(span.end)}`;
          proposal = {
            kind: 'locator',
            confidence: confidence.level,
            lineNo,
            before: line,
            after: replacement,
            why: `\`${brokenText}\` no longer matches anything. In ${domSource}, ${
              best.role ? `the ${best.role}${best.name ? ` "${clipLines(best.name, 1, 60)}"` : ''}` : `the <${best.tag}> element`
            } matches ${confidence.matched.map((w) => `"${w}"`).join(', ')}, and \`${bestLocator(best)}\` is proven to resolve to exactly that element.`,
            alternatives: usable
              .slice(1)
              .filter((element) => healConfidence(element, heal).level !== 'none')
              .slice(0, 2)
              .map((element) => bestLocator(element))
              .filter((value): value is string => value !== undefined),
          };
        }
      }

      // 2. Changed copy in a text/value assertion.
      if (!proposal) {
        const expectation = await proposeExpectationFix(failure, lines, lineNo);
        if (expectation) proposal = expectation;
      }

      if (!proposal) {
        if (notes.length === 0) {
          notes.push(
            `No automatic fix applies to this \`${failure.failureKind}\` failure: suggest-fix patches broken locators and changed expected text. Use **get-failure** for the trace, then edit by hand.`,
          );
        }
        out.push(...notes);
        return toolText(out.join('\n'));
      }

      const diff = unifiedDiff(failure.file, lines, proposal.lineNo, proposal.after);
      out.push(
        `### Proposed ${proposal.kind === 'locator' ? 'locator fix' : 'expectation update'} — confidence **${proposal.confidence}**`,
        '',
        proposal.why,
        '',
        codeFence(diff, 'diff'),
        '',
      );
      if (proposal.alternatives && proposal.alternatives.length > 0) {
        out.push(`Other candidates: ${proposal.alternatives.map((a) => `\`${a}\``).join(', ')}`, '');
      }

      const mayApply = proposal.kind === 'locator' || args.allowExpectationUpdate === true;
      if (!args.apply) {
        out.push(
          mayApply
            ? '> Next: call **suggest-fix** again with `apply: true` to write this change and re-run the test to verify it.'
            : '> This changes what the test asserts. Apply it by hand, or pass `apply: true, allowExpectationUpdate: true` if the new text is intended.',
        );
        return toolText(out.join('\n'));
      }
      if (!mayApply) {
        out.push('> ⛔ Not applied: expectation updates need `allowExpectationUpdate: true`, because they can hide a real regression.');
        return toolText(out.join('\n'));
      }

      // Apply: refuse if the file changed since we read it.
      const current = await readFile(specPath, 'utf8');
      if (current !== source) {
        throw new PlaywrightMcpError(`${failure.file} changed while the fix was being computed`, 'INVALID_PATH', {
          hint: 'Call suggest-fix again to compute the fix against the current file.',
        });
      }
      const patched = [...lines];
      patched[proposal.lineNo - 1] = proposal.after;
      await writeFileInsideRoot(specPath, patched.join(eol), root);
      out.push(`**Applied** to \`${failure.file}:${proposal.lineNo}\`.`, '');

      if (args.verify === false) {
        out.push('> Not verified (verify: false). Re-run with **run-test** to check it.');
        return toolText(out.join('\n'));
      }

      const detection = await detectProject(root);
      const configPath = resolveConfigSelection(detection, args.config);
      const target = `${specPath}${failure.line ? `:${failure.line}` : ''}`;
      const result: RunTestResult = await runTests({
        projectRoot: root,
        configPath,
        testFiles: [target],
        project: failure.project,
        retries: 0,
        retryOnFailure: false,
        timeoutMs: args.timeoutMs,
        signal: ctx.signal,
      });
      ctx.store.setLastRun({ projectRoot: root, result, at: Date.now() });
      await recordRun(root, result, 'suggest-fix').catch(() => undefined);

      if (result.ok) {
        out.push(`### ✅ Verified — the test passes with the fix (${formatDuration(result.durationMs)}).`);
      } else {
        await writeFileInsideRoot(specPath, source, root);
        const first = result.failures[0];
        out.push(
          `### ❌ Still failing — the change was reverted`,
          '',
          first ? codeFence(clipLines(first.message, 8, 1_200), 'text') : (result.errorMessage ?? 'The run failed without a test failure.'),
          '',
          '> The original file is restored. Call **get-failure** for the new failure, or try another candidate by hand.',
        );
      }
      return toolText(out.join('\n'));
    }),
};
