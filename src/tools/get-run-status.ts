/**
 * Tool 11 — get-run-status: progress and result of a background run
 * started with run-test `background: true`; can wait for it, or cancel it.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { PlaywrightMcpError } from '../types/index.js';
import type { ToolContext, ToolResponse } from '../types/index.js';
import { getBackgroundRun, listBackgroundRuns } from '../utils/run-registry.js';
import type { BackgroundRun } from '../utils/run-registry.js';
import { formatDuration, guard, toolText } from './shared.js';
import { renderRunResult } from './run-test.js';

const getRunStatusInput = z.object({
  runId: z.string().optional(),
  waitSeconds: z
    .number()
    .int()
    .min(0)
    .max(55)
    .optional()
    .describe('Wait up to this long for it to finish'),
  cancel: z.boolean().optional(),
});

export type GetRunStatusInput = z.infer<typeof getRunStatusInput>;
export const getRunStatusSchema = getRunStatusInput;

function progressLine(run: BackgroundRun): string {
  const p = run.progress;
  const total = p.total !== undefined ? `/${p.total}` : '';
  const failed = p.failed > 0 ? ` · ❌ ${p.failed} failed so far` : '';
  return `**Progress:** ${p.done}${total} tests done${failed} · running for ${formatDuration(Date.now() - run.startedAt)}`;
}

export const getRunStatusTool = {
  name: 'get-run-status',
  description:
    'Progress (tests done/total, failures so far) or the final result of a run-test background run; the result becomes the last run for get-failure. waitSeconds waits; cancel stops it. Default: the latest run.',
  inputSchema: getRunStatusSchema,
  handler: async (args: GetRunStatusInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('get-run-status', async () => {
      const run = getBackgroundRun(args.runId);
      if (!run) {
        throw new PlaywrightMcpError(args.runId ? `No background run "${args.runId}"` : 'No background runs yet', 'INVALID_PATH', {
          hint: 'Start one with run-test and background: true. Runs are kept in memory until the server restarts (the 20 most recent).',
        });
      }

      if (args.cancel && run.status === 'running') {
        run.controller.abort();
        await Promise.race([run.done, sleep(10_000)]);
      }

      if (run.status === 'running' && (args.waitSeconds ?? 0) > 0) {
        const signal = ctx.signal;
        await Promise.race([
          run.done,
          sleep((args.waitSeconds ?? 0) * 1_000, undefined, { signal }).catch(() => undefined),
        ]);
      }

      const others = listBackgroundRuns().filter((other) => other.id !== run.id).slice(0, 5);
      const footer =
        others.length > 0
          ? ['', `Other runs: ${others.map((o) => `\`${o.id}\` (${o.status})`).join(', ')}`]
          : [];

      if (run.status === 'running') {
        return toolText(
          [
            `## ⏳ \`${run.id}\` is running — ${run.label}`,
            '',
            progressLine(run),
            run.progress.last ? `**Last finished:** ${run.progress.last}` : '',
            '',
            `> Call again with \`waitSeconds: 30\` to wait for the result, or \`cancel: true\` to stop it.`,
            ...footer,
          ]
            .filter((line, i, all) => line !== '' || all[i - 1] !== '')
            .join('\n'),
        );
      }

      if (!run.result) {
        return toolText(
          [`## 🛑 \`${run.id}\` ${run.status}`, '', run.error ?? 'The run stopped before producing a result.', ...footer].join('\n'),
        );
      }

      const took = run.finishedAt ? formatDuration(run.finishedAt - run.startedAt) : '—';
      return toolText(
        [`_Background run \`${run.id}\` — ${run.status} after ${took}_`, '', renderRunResult(run.result, run.projectRoot), ...footer].join('\n'),
      );
    }),
};
