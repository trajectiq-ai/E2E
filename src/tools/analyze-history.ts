/**
 * Tool 10 — analyze-history: read the local run history and answer the
 * questions one red build cannot: which tests are flaky across runs, which
 * are simply broken, which failures share one cause, and how one test has
 * behaved over time.
 */

import { z } from 'zod';
import type { ToolContext, ToolResponse } from '../types/index.js';
import {
  failurePatterns,
  historyEnabled,
  HISTORY_DIR,
  rankFlaky,
  readHistory,
  testStats,
} from '../utils/run-history.js';
import type { HistoryEntry, TestStats } from '../utils/run-history.js';
import {
  clipLines,
  formatDuration,
  guard,
  markdownCell,
  resolveProjectRoot,
  toolText,
} from './shared.js';

const analyzeHistoryInput = z.object({
  view: z
    .enum(['flaky', 'patterns', 'test'])
    .optional()
    .describe("Default 'flaky'"),
  test: z.string().optional().describe('Filter: substring of file or title'),
  lastRuns: z.number().int().min(2).max(500).optional().describe('Runs to analyze (default 30)'),
  limit: z.number().int().min(1).max(100).optional(),
  projectRoot: z.string().optional(),
});

export type AnalyzeHistoryInput = z.infer<typeof analyzeHistoryInput>;
export const analyzeHistorySchema = analyzeHistoryInput;

const pct = (n: number): string => `${Math.round(n * 100)}%`;

function strip(stats: TestStats, width = 20): string {
  const s = stats.strip.length > width ? `…${stats.strip.slice(-width)}` : stats.strip;
  return `\`${s}\``;
}

function header(entries: HistoryEntry[], requested: number): string[] {
  const first = entries[0]?.at.slice(0, 16).replace('T', ' ');
  const last = entries[entries.length - 1]?.at.slice(0, 16).replace('T', ' ');
  return [`**Window:** last ${entries.length} run(s)${entries.length < requested ? ` (all recorded)` : ''}, ${first} → ${last} UTC`, ''];
}

export const analyzeHistoryTool = {
  name: 'analyze-history',
  description:
    "Analyze the local run history (.playwright-e2e-mcp/history.jsonl, written by every run): 'flaky' ranks tests that flip pass/fail and lists broken or regressed ones; 'patterns' groups failures by cause; 'test' shows one test's timeline.",
  inputSchema: analyzeHistorySchema,
  handler: async (args: AnalyzeHistoryInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('analyze-history', async () => {
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const requested = args.lastRuns ?? 30;
      const limit = args.limit ?? 15;
      const view = args.view ?? (args.test ? 'test' : 'flaky');
      let entries = await readHistory(root, requested);

      if (entries.length === 0) {
        return toolText(
          [
            '## No run history yet',
            '',
            historyEnabled()
              ? `Runs are recorded in \`${HISTORY_DIR}/history.jsonl\` once **run-test** has run. Run the suite a few times (or use \`args: ["--repeat-each=5"]\`), then ask again.`
              : 'Recording is off (PW_MCP_HISTORY=0). Unset it to record runs.',
          ].join('\n'),
        );
      }

      if (args.test) {
        const needle = args.test.toLowerCase();
        entries = entries.map((entry) => ({
          ...entry,
          tests: entry.tests.filter((t) => `${t.file} ${t.title}`.toLowerCase().includes(needle)),
        }));
      }

      const lines: string[] = [];
      if (view === 'test') {
        const stats = testStats(entries);
        lines.push(`## Test history${args.test ? ` — "${args.test}"` : ''}`, '', ...header(entries, requested));
        if (stats.length === 0) {
          lines.push('_No recorded runs include a matching test._');
          return toolText(lines.join('\n'));
        }
        for (const s of stats.slice(0, limit)) {
          lines.push(
            `### ${s.title}`,
            `\`${s.file}\`${s.project ? ` · ${s.project}` : ''}`,
            '',
            `- **Timeline (oldest → newest):** ${strip(s, 40)}  (P pass · F fail · ~ passed on retry · - skipped)`,
            `- **Runs:** ${s.runs} · passed ${s.passed} · failed ${s.failed} · flaky ${s.flaky} · flips ${s.flips}`,
            `- **Average duration:** ${s.avgMs !== undefined ? formatDuration(s.avgMs) : '—'} · **last:** ${s.lastStatus} at ${s.lastAt.slice(0, 16).replace('T', ' ')}`,
          );
          const fails = entries
            .flatMap((entry) => entry.tests.filter((t) => t.title === s.title && t.file === s.file && t.msg).map((t) => t.msg!))
            .slice(-3);
          if (fails.length > 0) {
            lines.push('- **Recent errors:**');
            for (const msg of [...new Set(fails)]) lines.push(`  - ${clipLines(msg, 1, 200)}`);
          }
          lines.push('');
        }
        return toolText(lines.join('\n'));
      }

      if (view === 'patterns') {
        const patterns = failurePatterns(entries);
        lines.push('## Failure patterns', '', ...header(entries, requested));
        if (patterns.length === 0) {
          lines.push('✅ No failures recorded in this window.');
          return toolText(lines.join('\n'));
        }
        lines.push('| # | kind | failures | tests | example error |', '| ---: | --- | ---: | ---: | --- |');
        patterns.slice(0, limit).forEach((p, i) => {
          lines.push(`| ${i + 1} | ${p.kind} | ${p.count} | ${p.tests.length} | ${markdownCell(clipLines(p.example || p.signature, 1, 140))} |`);
        });
        lines.push('');
        const shared = patterns.filter((p) => p.tests.length > 1);
        if (shared.length > 0) {
          lines.push(
            `> 🔗 ${shared.length} pattern(s) hit several tests at once. A shared cause (a renamed element, a dead endpoint, a slow environment) usually explains them all: fix it once.`,
            '',
          );
          for (const p of shared.slice(0, 3)) {
            lines.push(`- **${clipLines(p.example || p.signature, 1, 100)}** → ${p.tests.slice(0, 5).map((t) => `\`${t}\``).join(', ')}${p.tests.length > 5 ? ` …+${p.tests.length - 5}` : ''}`);
          }
          lines.push('');
        }
        return toolText(lines.join('\n'));
      }

      const ranking = rankFlaky(entries);
      lines.push('## Flakiness ranking', '', ...header(entries, requested));
      if (ranking.flaky.length === 0 && ranking.broken.length === 0 && ranking.regressed.length === 0) {
        lines.push(`✅ No unstable tests: every recorded test behaved the same way across these runs (${ranking.stable} stable).`);
        if (entries.length < 3) lines.push('', '> Few runs recorded so far; flakiness needs repetition to show. Run the suite again or use `args: ["--repeat-each=5"]`.');
        return toolText(lines.join('\n'));
      }
      if (ranking.flaky.length > 0) {
        lines.push(
          '### ⚠️ Flaky (outcome goes back and forth)',
          '',
          '| # | test | runs | fail rate | flip rate | timeline |',
          '| ---: | --- | ---: | ---: | ---: | --- |',
        );
        ranking.flaky.slice(0, limit).forEach((s, i) => {
          lines.push(`| ${i + 1} | ${markdownCell(clipLines(s.key, 1, 120))} | ${s.runs} | ${pct(s.failRate)} | ${pct(s.flipRate)} | ${strip(s)} |`);
        });
        lines.push('');
      }
      if (ranking.regressed.length > 0) {
        lines.push('### 📉 Regressed (passed earlier, failing since)', '');
        for (const s of ranking.regressed.slice(0, limit)) lines.push(`- ${clipLines(s.key, 1, 140)} — ${strip(s)}`);
        lines.push('');
      }
      if (ranking.broken.length > 0) {
        lines.push('### ❌ Broken (failed every run)', '');
        for (const s of ranking.broken.slice(0, limit)) lines.push(`- ${clipLines(s.key, 1, 140)} — ${s.runs}/${s.runs} failed`);
        lines.push('');
      }
      lines.push(
        `${ranking.stable} other test(s) were stable.`,
        '',
        '> Next: `diagnose-flaky` on the top test for fresh evidence, `analyze-history` with `view: "patterns"` to see shared causes, or `view: "test"` for one test\'s timeline.',
      );
      return toolText(lines.join('\n'));
    }),
};
