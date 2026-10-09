/**
 * Tool 2 — get-failure: deep analysis of a single failure from the most
 * recent run-test execution (message, code frame, expected/actual,
 * stack, diagnosis and concrete next steps).
 */

import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { LastRunRecord, TestFailure, ToolContext, ToolResponse } from '../types/index.js';
import { parseReportJson } from '../utils/report-parser.js';
import { readFailureTrace } from '../utils/trace-reader.js';
import {
  codeFence,
  clipLines,
  failureHint,
  formatDuration,
  guard,
  toolText,
} from './shared.js';

const getFailureInput = z.object({
  index: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('1-based failure index from the last run (default 1)'),
  projectRoot: z.string().optional().describe('Only used to re-read the stored report'),
});

export type GetFailureInput = z.infer<typeof getFailureInput>;
export const getFailureSchema = getFailureInput;

function nextSteps(failure: TestFailure, index: number): string[] {
  const steps: string[] = [];
  const location = failure.file ? `${failure.file}${failure.line ? `:${failure.line}` : ''}` : undefined;

  if (location) {
    steps.push(
      `Re-run only this test: \`run-test\` with \`testFiles: ["${location}"]\`, \`headed: true\` to watch it live.`,
    );
  }
  if (failure.failureKind === 'assertion' || failure.failureKind === 'timeout') {
    if (location) {
      steps.push(`Single-step with Playwright UI mode: \`run-test\` with \`args: ["--headed", "--debug"]\` on \`${location}\`.`);
    }
  }
  if (/locator|selector|resolved to|waiting for/i.test(failure.message)) {
    const selectorMatch = /locator\((['"`])(.+?)\1\)/.exec(failure.message);
    const selector = selectorMatch ? selectorMatch[2] : '<your-selector>';
    steps.push(
      `Verify the selector against the live page: \`validate-selector\` with \`selector: "${selector}"\`, or \`inspect-page\` to see the real DOM.`,
    );
  }
  if (failure.failureKind === 'server-unreachable') {
    steps.push('Start the dev server, then re-run the same test with `run-test`.');
  }
  if (failure.failureKind === 'browser-crash') {
    steps.push('Run `npx playwright install --force` and close other Chrome/automation instances, then retry.');
  }
  steps.push(`Ask for this failure again with \`index: ${index}\` after re-running to compare.`);
  return steps;
}

async function renderTraceContext(failure: TestFailure): Promise<string> {
  if (!failure.tracePath) {
    return [
      '### DOM at failure',
      '',
      '> No trace was captured for this attempt. `run-test` passes `--trace=retain-on-failure` automatically; you can also set `trace: "retain-on-failure"` in playwright.config.* before running tests directly.',
      '',
    ].join('\n');
  }

  const trace = await readFailureTrace(failure.tracePath).catch(() => null);
  if (trace === null) {
    return [
      '### DOM at failure',
      '',
      `> The trace archive is missing (\`${failure.tracePath}\`). The run may have been killed before Playwright flushed it — re-run the test to capture a fresh trace.`,
      '',
    ].join('\n');
  }

  const lines: string[] = ['### DOM at failure (Playwright trace)', ''];
  if (trace.action) {
    const selector = trace.action.selector ? ` \`${trace.action.selector}\`` : '';
    const at = trace.atMs !== undefined ? ` at +${(trace.atMs / 1_000).toFixed(1)}s` : '';
    lines.push(`**Failed action:** \`${trace.action.api}\`${selector}${at}`);
    if (trace.action.params) lines.push(`**Params:** \`${clipLines(trace.action.params, 1, 300)}\``);
    lines.push('');
  }

  if (trace.actionLog.length > 0) {
    lines.push('**Action log (last steps):**', '');
    for (const entry of trace.actionLog) {
      const marker = entry.failed ? '✗' : '•';
      const summary = entry.summary ? ` \`${clipLines(entry.summary, 1, 160)}\`` : '';
      lines.push(`- ${marker} \`${entry.api}\`${summary}`);
    }
    lines.push('');
  }

  if (trace.failedRequests.length > 0) {
    const of = trace.networkTotal > 0 ? ` of ${trace.networkTotal} requests` : '';
    lines.push(`### Network requests that failed (${trace.failedRequests.length}${of})`, '');
    for (const req of trace.failedRequests) {
      const status =
        req.status !== undefined
          ? `**${req.status}${req.statusText ? ` ${req.statusText}` : ''}**`
          : `**no response** (${req.errorText ?? 'request failed'})`;
      const kind = req.resourceType ? ` (${req.resourceType})` : '';
      const err = req.errorText && req.status !== undefined ? ` — ${clipLines(req.errorText, 1, 160)}` : '';
      const url = clipLines(req.url, 1, 200);
      lines.push(`- \`${req.method} ${url}\` → ${status}${kind}${err}`);
    }
    lines.push('');
  }

  if (trace.consoleMessages.length > 0) {
    lines.push('### Console before the failure', '');
    for (const msg of trace.consoleMessages) {
      const icon = msg.type === 'error' ? '❌' : '⚠️';
      const where = msg.location ? ` — \`${clipLines(msg.location, 1, 160)}\`` : '';
      lines.push(`- ${icon} ${clipLines(msg.text, 1, 300)}${where}`);
    }
    lines.push('');
  }

  const html = trace.snippet ?? trace.snapshotHtml;
  if (html) {
    const title = trace.snippet
      ? 'Parent container at failure:'
      : `DOM snapshot at failure${trace.snapshotTruncated ? ' (truncated)' : ''}:`;
    lines.push(title, '', codeFence(html, 'html'), '');
  }

  if (trace.errorContext) {
    lines.push(
      'Page accessibility tree at failure (Playwright `error-context`):',
      '',
      codeFence(clipLines(trace.errorContext, 60, 5_000), 'markdown'),
      '',
    );
  }

  for (const warning of trace.warnings) lines.push(`> ⚠️ ${warning}`);
  if (trace.warnings.length > 0) lines.push('');
  return lines.join('\n');
}

async function renderFailureDetail(failure: TestFailure, index: number, total: number): Promise<string> {
  const lines: string[] = [
    `## Failure ${index} of ${total} — ${failure.title}`,
    '',
  ];
  const location = failure.file
    ? `\`${failure.file}${failure.line ? `:${failure.line}` : ''}\``
    : '_configuration_';
  const meta = [
    failure.project ? `project **${failure.project}**` : undefined,
    failure.retry !== undefined ? `attempt ${failure.retry + 1}` : undefined,
    failure.durationMs !== undefined ? `took ${formatDuration(failure.durationMs)}` : undefined,
    `status **${failure.status}**`,
  ].filter(Boolean);
  lines.push(`**File:** ${location}  |  ${meta.join(' · ')}`, '');

  lines.push('### Error', '', codeFence(clipLines(failure.message, 30, 5_000), 'text'), '');

  if (failure.expected !== undefined || failure.actual !== undefined) {
    lines.push('### Expected vs actual', '');
    if (failure.expected !== undefined) lines.push(`- **Expected:** ${codeFence(failure.expected, 'text')}`);
    if (failure.actual !== undefined) lines.push(`- **Actual:** ${codeFence(failure.actual, 'text')}`);
    lines.push('');
  }

  if (failure.stack && failure.stack.trim() !== '') {
    lines.push('### Stack', '', codeFence(clipLines(failure.stack, 30, 4_000), 'text'), '');
  }

  if (failure.stdout && failure.stdout.trim() !== '') {
    lines.push('### Test console output', '', codeFence(clipLines(failure.stdout, 20, 3_000), 'text'), '');
  }

  lines.push(await renderTraceContext(failure));

  lines.push('### Diagnosis', '', `- **Kind:** \`${failure.failureKind}\``, `- ${failureHint(failure.failureKind)}`, '');

  lines.push('### Next steps', '');
  for (const [i, step] of nextSteps(failure, index).entries()) {
    lines.push(`${i + 1}. ${step}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Every failure of a run. The run-level result caps failures; re-read the
 * JSON report for the full list when more failures were recorded than shown.
 */
export async function allFailures(record: LastRunRecord): Promise<TestFailure[]> {
  const failures = record.result.failures;
  if (record.result.reportPath && record.result.failuresTruncated) {
    const raw = await readFile(record.result.reportPath, 'utf8').catch(() => null);
    if (raw !== null) {
      const parsed = parseReportJson(raw, record.projectRoot, 200);
      if (parsed.failures.length > failures.length) return parsed.failures;
    }
  }
  return failures;
}

export const getFailureTool = {
  name: 'get-failure',
  description:
    'Analyze one failure from the most recent run-test execution: full message and code frame, expected vs actual, stack trace, failed network requests (4xx/5xx and dead endpoints), console errors, failure kind (assertion/timeout/browser-crash/syntax/config/server-unreachable) and concrete next steps. Use run-test first.',
  inputSchema: getFailureSchema,
  handler: async (args: GetFailureInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('get-failure', async () => {
      const record = ctx.store.lastRun;
      if (!record) {
        throw new PlaywrightMcpError('No test run has happened yet', 'REPORT_MISSING', {
          hint: 'Call run-test first — get-failure analyzes the failures of the most recent run.',
        });
      }

      const failures = await allFailures(record);

      const total = failures.length;
      if (total === 0) {
        const stats = record.result.stats;
        const summary = stats
          ? `Last run: ${stats.expected} passed, ${stats.unexpected} failed, ${stats.flaky} flaky, ${stats.skipped} skipped.`
          : 'Last run produced no failures.';
        return toolText(
          [
            '## ✅ No failures to analyze',
            '',
            summary,
            '',
            record.result.errorKind
              ? `Note: the run reported \`${record.result.errorKind}\` — ${record.result.errorMessage ?? ''}`
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }

      const index = Math.min(args.index ?? 1, total);
      const failure = failures[index - 1];
      const parts: Array<string | undefined> = [await renderFailureDetail(failure, index, total)];

      if (total > 1) {
        parts.push('### All failures in this run', '');
        for (let i = 0; i < failures.length; i += 1) {
          const f = failures[i];
          parts.push(
            `${i + 1}. ${i + 1 === index ? '**→** ' : ''}${f.title} — \`${f.failureKind}\`${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''}`,
          );
        }
        parts.push('');
      }

      const run = record.result;
      parts.push(
        '### Run context',
        '',
        `- **Command:** \`${run.command}\``,
        `- **Duration:** ${formatDuration(run.durationMs)} · **Exit:** ${run.exitCode ?? '—'}`,
        run.errorKind ? `- **Run issue:** \`${run.errorKind}\` — ${run.errorMessage ?? ''}` : undefined,
        run.hint ? `- **Hint:** ${run.hint.replace(/\n/g, ' ')}` : undefined,
        '',
      );
      if (run.stderrTail.trim() !== '') {
        parts.push(
          '<details><summary>stderr tail</summary>',
          '',
          codeFence(clipLines(run.stderrTail, 50, 5_000), 'text'),
          '',
          '</details>',
          '',
        );
      }

      return toolText(parts.filter((part): part is string => part !== undefined).join('\n'));
    }),
};
