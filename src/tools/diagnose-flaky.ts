/**
 * Tool 8 — diagnose-flaky: run a failing test several times with
 * retries disabled and decide — from evidence — whether it is
 * genuinely flaky, consistently broken, or no longer reproducible.
 *
 * The verdict logic is a pure function (exported for unit tests).
 */

import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type {
  RunTestResult,
  TestFailure,
  ToolContext,
  ToolResponse,
} from '../types/index.js';
import { detectProject, missingPlaywrightMessage } from '../utils/project-detector.js';
import { runTests } from '../utils/playwright-runner.js';
import { relativeToRoot } from '../utils/path-utils.js';
import {
  clipLines,
  formatDuration,
  guard,
  resolveConfigSelection,
  resolveProjectRoot,
  sanitizeTestPathArgument,
  testPathExists,
  toolText,
} from './shared.js';

const diagnoseFlakyInput = z.object({
  projectRoot: z.string().optional().describe('Project directory; defaults to the server working directory'),
  testFiles: z
    .array(z.string())
    .optional()
    .describe(
      'Tests to diagnose ("file:line" supported). Defaults to the tests that failed in the most recent run.',
    ),
  runs: z
    .number()
    .int()
    .min(2)
    .max(10)
    .optional()
    .describe('How many times to run the tests (default 3)'),
  browser: z
    .enum(['chromium', 'firefox', 'webkit'])
    .optional()
    .describe('Playwright project name to run'),
  headed: z.boolean().optional().describe('Run with a visible browser window'),
  workers: z.number().int().min(1).max(64).optional(),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .optional()
    .describe('Hard wall-clock limit per run (default 120000)'),
  config: z
    .string()
    .optional()
    .describe('playwright.config path or 1-based index when the project has several configs'),
});

export type DiagnoseFlakyInput = z.infer<typeof diagnoseFlakyInput>;
export const diagnoseFlakySchema = diagnoseFlakyInput;

/* ------------------------------------------------------------------ */
/* Pure verdict logic (unit-tested)                                    */
/* ------------------------------------------------------------------ */

export interface FlakyRunOutcome {
  ok: boolean;
  durationMs: number;
  /** Normalized error signature of the first failure, when one occurred. */
  signature?: string;
  /** First line of the failure message, for display. */
  headline?: string;
  /** No tests executed (bad filter, empty suite, crashed reporter). */
  noTests?: boolean;
  /** Run-level error (timeout, spawn failure…) rather than a test failure. */
  errorKind?: string;
}

export type FlakyVerdict =
  | 'NOT REPRODUCING'
  | 'FLAKY'
  | 'CONSISTENTLY FAILING'
  | 'NO TESTS RAN';

export interface FlakySummary {
  verdict: FlakyVerdict;
  passed: number;
  failed: number;
  /** Number of distinct normalized error signatures across failed runs. */
  distinctSignatures: number;
  /** True when every failed run failed with the same signature. */
  sameError: boolean;
}

/**
 * Normalize a failure message into a comparable signature: first line,
 * lowercased, digits folded, whitespace collapsed.
 */
export function failureSignature(failure: TestFailure | undefined): string | undefined {
  if (!failure) return undefined;
  const firstLine = (failure.message ?? '').split('\n')[0] ?? '';
  const normalized = firstLine
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return normalized === '' ? undefined : normalized;
}

/** Decide the verdict from the per-run outcomes. */
export function summarizeFlaky(runs: FlakyRunOutcome[]): FlakySummary {
  const ranAnything = runs.some((r) => !r.noTests);
  const passed = runs.filter((r) => r.ok && !r.noTests).length;
  const failed = runs.filter((r) => !r.ok && !r.noTests).length;
  const signatures = new Set(runs.map((r) => r.signature).filter((s): s is string => s !== undefined));

  let verdict: FlakyVerdict;
  if (!ranAnything) verdict = 'NO TESTS RAN';
  else if (failed === 0) verdict = 'NOT REPRODUCING';
  else if (passed === 0) verdict = 'CONSISTENTLY FAILING';
  else verdict = 'FLAKY';

  return {
    verdict,
    passed,
    failed,
    distinctSignatures: signatures.size,
    sameError: signatures.size <= 1,
  };
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function verdictBlock(summary: FlakySummary): string {
  const { verdict } = summary;
  const total = summary.passed + summary.failed;
  switch (verdict) {
    case 'CONSISTENTLY FAILING':
      return [
        `> ❌ **CONSISTENTLY FAILING** — failed all ${total} run(s)${
          summary.sameError ? ' with the same error' : `, but the errors differ (${summary.distinctSignatures} distinct signatures)`
        }. This is **not flaky**: there is a real, reproducible bug. Use \`get-failure\` for the full trace and fix it.`,
      ].join('\n');
    case 'FLAKY':
      return [
        `> ⚠️ **FLAKY** — ${summary.passed} of ${total} run(s) passed${
          summary.sameError
            ? ' and the failures share one signature (a real intermittent bug, not random noise)'
            : ` and failures vary (${summary.distinctSignatures} distinct signatures — often timing/environment instability)`
        }. Quarantine or stabilize it: re-run under load, check for missing \`await\`s, race conditions and shared state.`,
      ].join('\n');
    case 'NOT REPRODUCING':
      return [
        `> ✅ **NOT REPRODUCING** — passed all ${total} run(s). The failure you saw was one-off (transient environment, network, or a change already fixed it). Re-run the full suite with \`run-test\` to confirm.`,
      ].join('\n');
    case 'NO TESTS RAN':
    default:
      return [
        '> ⚠️ **NO TESTS RAN** — the filter matched nothing (or the run crashed before executing). Check `testFiles` with `list-tests`.',
      ].join('\n');
  }
}

function renderDiagnosis(
  target: string[],
  runs: FlakyRunOutcome[],
  summary: FlakySummary,
  runsRequested: number,
): string {
  const lines: string[] = [
    `## Flaky diagnosis — ${target.map((t) => `\`${t}\``).join(', ')} × ${runsRequested} runs`,
    '',
    '**Mode:** Playwright retries disabled (`--retries=0`, no auto-retry) so each run is honest evidence.',
    '',
    '| run | status | duration | first failure |',
    '| ---: | --- | --- | --- |',
  ];

  runs.forEach((run, i) => {
    const status = run.noTests
      ? '∅ no tests'
      : run.ok
        ? '✅ passed'
        : run.errorKind
          ? `🛑 ${run.errorKind}`
          : '❌ failed';
    const failure = run.headline ? clipLines(run.headline, 1, 160).replace(/\|/g, '\\|') : '—';
    lines.push(`| ${i + 1} | ${status} | ${formatDuration(run.durationMs)} | ${failure} |`);
  });

  lines.push('', verdictBlock(summary), '');

  if (summary.verdict === 'FLAKY' || summary.verdict === 'CONSISTENTLY FAILING') {
    lines.push('**Next steps:**', '');
    lines.push('1. `get-failure` for the full error, DOM snapshot and failed requests of the last run.');
    lines.push(
      '2. Re-run only these tests after your fix: `run-test` with `testFiles` and `lastFailed: true`.',
    );
    if (summary.verdict === 'FLAKY') {
      lines.push('3. Diagnose again with `runs: 5` for stronger evidence before quarantining the test.');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Tool                                                                */
/* ------------------------------------------------------------------ */

function ranNoTests(result: RunTestResult): boolean {
  const s = result.stats;
  return (
    s !== null &&
    s.expected === 0 &&
    s.unexpected === 0 &&
    s.flaky === 0 &&
    s.skipped === 0
  );
}

export const diagnoseFlakyTool = {
  name: 'diagnose-flaky',
  description:
    'Run a failing test multiple times with retries disabled and return an evidence-based verdict: CONSISTENTLY FAILING (real bug), FLAKY (intermittent — includes pass/fail counts and error-signature variance) or NOT REPRODUCING (one-off). Defaults to the tests that failed in the most recent run.',
  inputSchema: diagnoseFlakySchema,
  handler: async (args: DiagnoseFlakyInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('diagnose-flaky', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const detection = await detectProject(root);

      if (!detection.hasPlaywright) {
        const { message, hint } = missingPlaywrightMessage(detection);
        return toolText([`## Flaky diagnosis unavailable`, '', `**Error:** ${message}`, '', `> ${hint}`].join('\n'));
      }

      const configPath = resolveConfigSelection(detection, args.config);

      // Target set: explicit, or the failures of the most recent run.
      let target = args.testFiles ?? [];
      if (target.length === 0) {
        const last = ctx.store.lastRun;
        const failedFiles = [
          ...new Set(
            (last?.result.failures ?? [])
              .map((f: TestFailure) => f.file)
              .filter((f): f is string => typeof f === 'string' && f !== ''),
          ),
        ];
        if (failedFiles.length === 0) {
          throw new PlaywrightMcpError('No tests to diagnose', 'INVALID_PATH', {
            hint: 'Pass `testFiles`, or call `run-test` first so the previously failed tests can be reused as the target set.',
          });
        }
        target = failedFiles;
      }

      const sanitized: string[] = [];
      const missing: string[] = [];
      for (const raw of target) {
        const absolute = sanitizeTestPathArgument(raw, root);
        sanitized.push(absolute);
        if (!(await testPathExists(absolute, root))) missing.push(raw);
      }
      if (missing.length > 0) {
        throw new PlaywrightMcpError(`Test path(s) not found: ${missing.join(', ')}`, 'INVALID_PATH', {
          hint: `Paths resolve inside ${root}. Call list-tests to see the available tests.`,
        });
      }

      const runsRequested = args.runs ?? 3;
      const outcomeList: FlakyRunOutcome[] = [];
      let lastResult: RunTestResult | undefined;

      for (let i = 0; i < runsRequested; i += 1) {
        if (ctx.signal?.aborted) break;
        ctx.logger.info('diagnose-flaky run', { run: i + 1, of: runsRequested, target: sanitized });
        const result = await runTests({
          projectRoot: root,
          configPath,
          testFiles: sanitized,
          browser: args.browser,
          headed: args.headed,
          workers: args.workers,
          timeoutMs: args.timeoutMs,
          retries: 0,
          retryOnFailure: false,
          signal: ctx.signal,
        });
        lastResult = result;

        const first = result.failures[0];
        const noTests = ranNoTests(result);
        outcomeList.push({
          ok: result.ok && !noTests,
          durationMs: result.durationMs,
          signature: failureSignature(first),
          headline: first ? first.message.split('\n')[0] : undefined,
          noTests,
          errorKind: !result.ok && result.failures.length === 0 ? result.errorKind : undefined,
        });

        // A run-level hard error (spawn/timeout) will repeat — stop early.
        if (!result.ok && result.failures.length === 0 && result.errorKind && result.errorKind !== 'REPORT_MISSING') {
          break;
        }
      }

      const summary = summarizeFlaky(outcomeList);

      if (lastResult) {
        ctx.store.setLastRun({ projectRoot: root, result: lastResult, at: Date.now() });
      }
      ctx.logger.info('diagnose-flaky finished', {
        verdict: summary.verdict,
        runs: outcomeList.length,
        passed: summary.passed,
        failed: summary.failed,
      });

      if (outcomeList.every((r) => r.errorKind)) {
        const kinds = [...new Set(outcomeList.map((r) => r.errorKind))].join(', ');
        return toolText(
          [
            '## Flaky diagnosis could not run',
            '',
            `Every attempt failed at the run level (\`${kinds}\`) before any test executed.`,
            '',
            lastResult?.errorMessage ? clipLines(lastResult.errorMessage, 4, 600) : '',
            lastResult?.hint ? `> ${lastResult.hint}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      return toolText(
        renderDiagnosis(
          sanitized.map((file) => relativeToRoot(root, file)),
          outcomeList,
          summary,
          runsRequested,
        ),
      );
    }),
};
