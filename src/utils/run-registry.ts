/**
 * Background runs: long suites start, return a run id at once, and report
 * progress until they finish, so a client is never stuck on one blocking
 * tool call (or cut off by its own request timeout).
 *
 * The registry is process-wide (not per MCP session), keeps the most recent
 * runs only, and every run stays killable: it has its own AbortController,
 * and server shutdown kills all children regardless.
 */

import { randomBytes } from 'node:crypto';
import type { RunProgress, RunTestOptions, RunTestResult } from '../types/index.js';
import { runTests } from './playwright-runner.js';
import { logger } from './logger.js';

export type BackgroundStatus = 'running' | 'finished' | 'cancelled' | 'errored';

export interface BackgroundRun {
  id: string;
  projectRoot: string;
  label: string;
  startedAt: number;
  finishedAt?: number;
  status: BackgroundStatus;
  progress: RunProgress;
  result?: RunTestResult;
  error?: string;
  /** Resolves when the run settles (never rejects). */
  done: Promise<void>;
  controller: AbortController;
}

const MAX_KEPT = 20;
const runs = new Map<string, BackgroundRun>();

function prune(): void {
  if (runs.size <= MAX_KEPT) return;
  const settled = [...runs.values()].filter((run) => run.status !== 'running').sort((a, b) => a.startedAt - b.startedAt);
  for (const run of settled) {
    if (runs.size <= MAX_KEPT) break;
    runs.delete(run.id);
  }
}

/**
 * Start a run in the background. `onFinish` runs once with the result
 * (store it, record history); its errors are logged, never thrown.
 */
export function startBackgroundRun(
  options: Omit<RunTestOptions, 'signal' | 'onProgress'>,
  label: string,
  onFinish: (result: RunTestResult) => Promise<void> | void,
): BackgroundRun {
  const id = `run-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  const controller = new AbortController();
  const run: BackgroundRun = {
    id,
    projectRoot: options.projectRoot,
    label,
    startedAt: Date.now(),
    status: 'running',
    progress: { done: 0, failed: 0 },
    controller,
    done: Promise.resolve(),
  };
  run.done = (async () => {
    try {
      const result = await runTests({
        ...options,
        signal: controller.signal,
        onProgress: (progress) => {
          run.progress = progress;
        },
      });
      run.result = result;
      run.status = controller.signal.aborted ? 'cancelled' : 'finished';
      try {
        await onFinish(result);
      } catch (err) {
        logger.warn('background run follow-up failed', { id, error: err });
      }
    } catch (err) {
      run.status = controller.signal.aborted ? 'cancelled' : 'errored';
      run.error = err instanceof Error ? err.message : String(err);
    } finally {
      run.finishedAt = Date.now();
    }
  })();
  runs.set(id, run);
  prune();
  return run;
}

export function getBackgroundRun(id?: string): BackgroundRun | undefined {
  if (id) return runs.get(id);
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt)[0];
}

export function listBackgroundRuns(): BackgroundRun[] {
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Test hook: forget every run. */
export function clearBackgroundRuns(): void {
  for (const run of runs.values()) run.controller.abort();
  runs.clear();
}
