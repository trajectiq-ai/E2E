/**
 * Tool 4 — list-tests: list the project's Playwright tests (via
 * `playwright test --list`, falling back to a source scan when
 * Playwright is missing or the project does not compile).
 */

import { z } from 'zod';
import type { DiscoveredTest, ListTestsResult, ToolContext, ToolResponse } from '../types/index.js';
import { detectProject } from '../utils/project-detector.js';
import { listTests } from '../utils/playwright-runner.js';
import { isPathInside, normalizePath, sanitizeUserPath, relativeToRoot } from '../utils/path-utils.js';
import {
  guard,
  resolveConfigSelection,
  resolveProjectRoot,
  toolText,
} from './shared.js';

const listTestsInput = z.object({
  projectRoot: z.string().optional().describe('Project directory; defaults to the server working directory'),
  config: z
    .string()
    .optional()
    .describe('playwright.config path or 1-based index when the project has several configs'),
  testDir: z.string().optional().describe('Restrict scanning to this directory (inside the project)'),
  filter: z.string().optional().describe('Case-insensitive substring filter on "file › title"'),
  limit: z.number().int().min(1).max(5_000).optional().describe('Max tests to return (default 500)'),
});

export type ListTestsInput = z.infer<typeof listTestsInput>;
export const listTestsSchema = listTestsInput;

function renderTests(result: ListTestsResult, root: string): string {
  const lines: string[] = [];
  const sourceLabel =
    result.source === 'playwright-list' ? 'Playwright `--list`' : 'source scan (best effort)';
  lines.push(`## 📋 ${result.total} test${result.total === 1 ? '' : 's'} found`, '');
  lines.push(`**Source:** ${sourceLabel}`);
  if (result.testDir) lines.push(`**testDir:** \`${relativeToRoot(root, result.testDir)}\``);
  lines.push('');

  if (result.error) {
    lines.push(
      `> ⚠️ Playwright could not list tests (\`${result.error.kind}\`): ${result.error.message}`,
      result.error.hint ? `> ${result.error.hint.replace(/\n/g, '\n> ')}` : '',
      '',
    );
  }

  if (result.total === 0) {
    lines.push(
      '_No tests matched._',
      '',
      '- Check `testDir` / the `filter`, or',
      '- Confirm test files are named `*.spec.ts` / `*.test.ts`.',
    );
    return lines.join('\n');
  }

  const groups = new Map<string, DiscoveredTest[]>();
  for (const test of result.tests) {
    const group = groups.get(test.file) ?? [];
    group.push(test);
    groups.set(test.file, group);
  }

  for (const [file, tests] of groups) {
    lines.push(`### \`${file}\``);
    for (const test of tests) {
      const projects = test.projects && test.projects.length > 0 ? ` \`${test.projects.join(', ')}\`` : '';
      lines.push(`- ${test.line ? `:${test.line} ` : ''}${test.title}${projects}`);
    }
    lines.push('');
  }

  if (result.truncated) {
    lines.push(`_Showing ${result.tests.length} of ${result.total} — raise \`limit\` or refine \`filter\`._`, '');
  }
  return lines.join('\n');
}

export const listTestsTool = {
  name: 'list-tests',
  description:
    'List the Playwright tests available in the project (file, line, full title, projects), with optional filtering. Uses `playwright test --list` when Playwright works and falls back to a source scan when the install or config is broken, reporting why.',
  inputSchema: listTestsSchema,
  handler: async (args: ListTestsInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('list-tests', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const detection = await detectProject(root);
      const configPath = resolveConfigSelection(detection, args.config);

      let testDir: string | null = detection.testDir;
      if (args.testDir !== undefined) {
        // Throws INVALID_PATH when the path escapes the project root.
        testDir = sanitizeUserPath(args.testDir, root);
      } else if (testDir !== null && !isPathInside(testDir, root)) {
        testDir = null;
      }

      const result = await listTests({
        projectRoot: root,
        configPath,
        testDir,
        filter: args.filter,
        limit: args.limit,
        signal: ctx.signal,
      });

      ctx.logger.info('list-tests finished', {
        total: result.total,
        source: result.source,
        errorKind: result.error?.kind,
      });
      return toolText(renderTests(result, normalizePath(root)));
    }),
};
