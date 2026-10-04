/**
 * Tool 1 — run-test: execute Playwright tests and report structured
 * results (stats, failures, diagnostics, hints).
 */

import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { RunTestOptions, RunTestResult, ToolContext, ToolResponse } from '../types/index.js';
import { detectProject, missingPlaywrightMessage } from '../utils/project-detector.js';
import { runTests } from '../utils/playwright-runner.js';
import { normalizePath, relativeToRoot } from '../utils/path-utils.js';
import {
  codeFence,
  clipLines,
  formatDuration,
  guard,
  renderFailure,
  resolveConfigSelection,
  resolveProjectRoot,
  sanitizeTestPathArgument,
  testPathExists,
  toolError,
  toolText,
} from './shared.js';

const runTestInput = z.object({
  projectRoot: z
    .string()
    .optional()
    .describe('Project directory; defaults to the server working directory'),
  testFiles: z
    .array(z.string())
    .optional()
    .describe(
      'Test files/directories relative to the project root; "file:line" is supported. Omit to run the whole suite.',
    ),
  grep: z.string().optional().describe('Only run tests whose title matches this regex'),
  browser: z
    .enum(['chromium', 'firefox', 'webkit'])
    .optional()
    .describe('Playwright project name to run (matched against playwright.config projects)'),
  headed: z.boolean().optional().describe('Run with a visible browser window'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .optional()
    .describe('Hard wall-clock limit for the whole run; the process tree is killed past it (default 120000)'),
  testTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .optional()
    .describe('Per-test timeout passed to Playwright'),
  workers: z.number().int().min(1).max(64).optional(),
  retries: z.number().int().min(0).max(10).optional(),
  retryOnFailure: z
    .boolean()
    .optional()
    .describe('Auto retry failing tests once before reporting failure (default true; ignored when retries is set)'),
  lastFailed: z
    .boolean()
    .optional()
    .describe('Only re-run tests that failed in the previous run (Playwright --last-failed) — the fast fix → re-run loop'),
  config: z
    .string()
    .optional()
    .describe('playwright.config path or 1-based index when the project has several configs'),
  args: z
    .array(z.string())
    .optional()
    .describe('Extra Playwright CLI arguments (shell metacharacters are rejected)'),
});

export type RunTestInput = z.infer<typeof runTestInput>;
export const runTestSchema = runTestInput;

function renderRunResult(result: RunTestResult, root: string): string {
  const flakyCount = result.stats?.flaky ?? 0;
  const status = result.ok
    ? flakyCount > 0
      ? `✅ PASSED (${flakyCount} flaky)`
      : '✅ PASSED'
    : result.timedOut
      ? '⏱️ KILLED (timeout)'
      : '❌ FAILED';
  const lines: string[] = [`## Playwright run — ${status}`, ''];
  lines.push(`**Command:** \`${result.command}\``);

  const meta = [
    `duration ${formatDuration(result.durationMs)}`,
    `exit ${result.exitCode ?? '—'}`,
  ];
  if (result.configPath) meta.push(`config \`${relativeToRoot(root, result.configPath)}\``);
  if (result.autoRetry) meta.push('auto retry ×1');
  if (result.lastFailed) meta.push('failed tests only (--last-failed)');
  if (result.timedOut) meta.push('killed at wrapper timeout');
  if (result.partial) meta.push('partial results');
  lines.push(`**${meta.join(' · ')}**`, '');

  if (result.stats) {
    const s = result.stats;
    lines.push(
      '| passed | failed | flaky | skipped | duration |',
      '| ---: | ---: | ---: | ---: | ---: |',
      `| ${s.expected} | ${s.unexpected} | ${s.flaky} | ${s.skipped} | ${formatDuration(s.duration)} |`,
      '',
    );
  } else {
    lines.push('_No test statistics were reported._', '');
  }

  if (flakyCount > 0) {
    lines.push(
      `> ⚠️ **${flakyCount} flaky test(s)** failed first but passed on the automatic retry. Re-run to confirm they are stable before trusting them.`,
      '',
    );
  }

  if (result.failures.length > 0) {
    const more = result.failuresTruncated ? ' (showing the first ones)' : '';
    lines.push(`### ❌ ${result.failures.length} failing test(s)${more}`, '');
    for (let i = 0; i < result.failures.length; i += 1) {
      lines.push(renderFailure(result.failures[i], i, result.failures.length), '');
    }
    lines.push(
      '> Next: call **get-failure** with `index` to get the full stack, code frame and a suggested fix for one failure.',
      '',
    );
  }

  if (result.errorKind) {
    lines.push(`### ⚠️ ${result.errorKind}`, '', result.errorMessage ?? '', '');
    if (result.hint) lines.push(result.hint, '');
  } else if (result.hint && result.hint.trim() !== '') {
    lines.push(`> ${result.hint.replace(/\n/g, '\n> ')}`, '');
  }

  if (!result.ok && result.stderrTail.trim() !== '') {
    lines.push(
      '<details><summary>stderr tail</summary>',
      '',
      codeFence(clipLines(result.stderrTail, 40), 'text'),
      '',
      '</details>',
      '',
    );
  }
  return lines.join('\n');
}

export const runTestTool = {
  name: 'run-test',
  description:
    'Run Playwright end-to-end tests in the user\'s project and return structured results: pass/fail stats, per-failure messages with file:line, and diagnostics. Detects missing Playwright installs, multiple configs, dead dev servers, syntax errors, browser crashes, timeouts (kills the process tree and returns partial results) and full disks.',
  inputSchema: runTestSchema,
  handler: async (args: RunTestInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('run-test', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const detection = await detectProject(root);

      if (!detection.hasPlaywright) {
        const { message, hint } = missingPlaywrightMessage(detection);
        return toolError('NO_PLAYWRIGHT', message, hint);
      }

      const configPath = resolveConfigSelection(detection, args.config);

      const sanitized: string[] = [];
      const missing: string[] = [];
      for (const raw of args.testFiles ?? []) {
        const absolute = sanitizeTestPathArgument(raw, root);
        sanitized.push(absolute);
        if (!(await testPathExists(absolute, root))) missing.push(raw);
      }
      if (missing.length > 0) {
        throw new PlaywrightMcpError(`Test path(s) not found: ${missing.join(', ')}`, 'INVALID_PATH', {
          hint: `Paths resolve inside ${normalizePath(root)}. Call list-tests to see the available tests.`,
        });
      }

      const options: RunTestOptions = {
        projectRoot: root,
        configPath,
        testFiles: sanitized,
        grep: args.grep,
        browser: args.browser,
        headed: args.headed,
        timeoutMs: args.timeoutMs,
        testTimeoutMs: args.testTimeoutMs,
        workers: args.workers,
        retries: args.retries,
        retryOnFailure: args.retryOnFailure,
        lastFailed: args.lastFailed,
        extraArgs: args.args,
        signal: ctx.signal,
      };

      const result = await runTests(options);
      ctx.store.setLastRun({ projectRoot: root, result, at: Date.now() });
      ctx.logger.info('run-test finished', {
        ok: result.ok,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        failures: result.failures.length,
      });
      return toolText(renderRunResult(result, root));
    }),
};
