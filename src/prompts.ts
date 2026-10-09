/**
 * MCP prompts: the workflows this server is built for, exposed so clients
 * can offer them as slash commands (/fix-failing-test, /triage-flaky-tests).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

function userText(text: string) {
  return { messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] };
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'fix-failing-test',
    {
      title: 'Fix a failing E2E test',
      description: 'Run the tests, diagnose the first failure, apply a verified fix or explain the real bug.',
      argsSchema: z.object({
        test: z.string().optional().describe('Test file or file:line to focus on (default: the whole suite)'),
      }),
    },
    ({ test }) =>
      userText(
        [
          `Fix the failing Playwright test${test ? ` ${test}` : 's in this project'} using the playwright-e2e-mcp tools:`,
          '',
          `1. Call run-test${test ? ` with testFiles: ["${test}"]` : ''} (use background: true and get-run-status for a long suite).`,
          '2. For each failure, call get-failure to read the error, the DOM at failure, failed requests and console errors.',
          '3. If the failure is a broken locator or changed copy, call suggest-fix; review the diff and confidence, then call it again with apply: true (it re-runs the test and reverts if it still fails).',
          '4. If suggest-fix finds no confident replacement, the element is likely missing: treat it as an app bug, explain the evidence (failed requests, console errors), and do not weaken the test.',
          '5. If the test passes on retry or the verdict is unclear, call diagnose-flaky before changing anything.',
          '6. Finish with run-test lastFailed: true and report what changed and why.',
        ].join('\n'),
      ),
  );

  server.registerPrompt(
    'triage-flaky-tests',
    {
      title: 'Triage flaky tests',
      description: 'Rank unstable tests from the local run history and diagnose the worst one.',
    },
    () =>
      userText(
        [
          'Triage flaky Playwright tests with the playwright-e2e-mcp tools:',
          '',
          '1. Call analyze-history (view: "flaky") to rank unstable tests; if there is little history, run run-test with args: ["--repeat-each=5"] first.',
          '2. Call analyze-history with view: "patterns" to see failures that share one cause.',
          '3. For the top flaky test, call diagnose-flaky with runs: 5 for fresh evidence.',
          '4. Read the failing attempt with get-failure and propose a stabilizing change (await, web-first assertion, waiting on the right response), not a longer timeout.',
          '5. Summarize: which tests are flaky, which are simply broken, and the shared causes.',
        ].join('\n'),
      ),
  );
}
