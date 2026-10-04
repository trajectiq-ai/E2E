/**
 * Tool 5 — validate-selector: verify a CSS selector against a live page:
 * is it syntactically valid, how many elements match, and what do the
 * matches look like?
 */

import { z } from 'zod';
import type { ToolContext, ToolResponse } from '../types/index.js';
import {
  assertHttpUrl,
  clipLines,
  guard,
  resolveProjectRoot,
  runBrowserScript,
  toolError,
  toolText,
} from './shared.js';

const validateSelectorInput = z.object({
  url: z.string().describe('Full URL of the live page to test against (http/https)'),
  selector: z.string().min(1).describe('CSS selector to validate'),
  projectRoot: z
    .string()
    .optional()
    .describe("Project whose Playwright install launches the browser; defaults to the server working directory"),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .optional()
    .describe('Overall limit in ms (default 45000)'),
});

export type ValidateSelectorInput = z.infer<typeof validateSelectorInput>;
export const validateSelectorSchema = validateSelectorInput;

const ENGINE_RE = /^(text|xpath|id|css|pierce|nth|visible|has-text)=|>>|:has-text\(|:text\(/i;

export const validateSelectorTool = {
  name: 'validate-selector',
  description:
    'Check a CSS selector against a live page: syntax validity, match count, and a sample of matched elements (tag, visibility, box, text). Also flags Playwright-only selector engines (text=, xpath=, >>, :has-text()) that are not valid CSS.',
  inputSchema: validateSelectorSchema,
  handler: async (args: ValidateSelectorInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('validate-selector', async () => {
      const url = assertHttpUrl(args.url);
      const selector = args.selector.trim();

      if (ENGINE_RE.test(selector)) {
        return toolText(
          [
            `## ⚠️ \`${selector}\` is not a CSS selector`,
            '',
            'It uses a **Playwright selector engine** (`text=`, `xpath=`, `>>`, `:has-text()` …). Those are valid *inside Playwright tests* but cannot be validated as CSS here, and Playwright CSS syntax is otherwise a subset of what the browser accepts.',
            '',
            '**How to fix:** rewrite it as plain CSS (e.g. `text=Login` → `[role="button"]:has-text("Login")` is still Playwright-only — prefer `[data-testid="login-button"]`), then re-validate.',
          ].join('\n'),
        );
      }

      const timeoutMs = args.timeoutMs ?? 45_000;
      const root = await resolveProjectRoot(args.projectRoot, ctx);

      const outcome = await runBrowserScript(
        {
          mode: 'validate',
          projectRoot: root,
          url,
          selector,
          gotoTimeout: Math.max(5_000, timeoutMs - 5_000),
          startedAt: Date.now(),
        },
        { timeoutMs, signal: ctx.signal },
      );

      if (!outcome.ok) {
        return toolError(
          outcome.kind ?? 'UNKNOWN',
          `Could not validate "${selector}" on ${url}: ${outcome.error ?? 'unknown error'}`,
          outcome.hint,
          outcome.stderrTail,
        );
      }

      const data = outcome.data!;

      if (data.parseError) {
        return toolText(
          [
            `## ❌ INVALID — \`${selector}\``,
            '',
            `**Parse error:** \`${data.parseError}\``,
            '',
            '**How to fix:** only CSS selectors are supported (`document.querySelectorAll` semantics). Common mistakes: unescaped `#`/`.` in ids/classes, stray `>`, or a Playwright engine prefix like `text=`.',
            '',
            'Use **inspect-page** to see the actual selectors of the live elements.',
          ].join('\n'),
        );
      }

      const lines: string[] = [];
      if (data.matchCount === 0) {
        lines.push(`## ✅ VALID — 0 matches`, '', `\`${selector}\` is syntactically valid but matched nothing on ${url}.`, '');
        lines.push(
          '**How to fix:** confirm the element exists at this URL (app may render after an interaction). Run **inspect-page** with the same URL to list real selectors, or add `waitFor` there.',
        );
        return toolText(lines.join('\n'));
      }

      lines.push(`## ✅ VALID — ${data.matchCount} match${data.matchCount === 1 ? '' : 'es'}`, '');
      lines.push(`**URL:** ${url}`, '');
      const matches = data.elements;
      for (let i = 0; i < matches.length; i += 1) {
        const element = matches[i];
        const box = element.box ? `${element.box.width}×${element.box.height} at (${element.box.x},${element.box.y})` : 'no box';
        lines.push(
          `${i + 1}. \`${element.selector}\` — **${element.tag}** · ${element.visible ? 'visible' : 'hidden'} · ${box}`,
        );
        if (element.text) lines.push(`   text: "${clipLines(element.text, 1, 140)}"`);
      }
      lines.push('');
      if (data.matchCount > 1) {
        lines.push(
          `> ${data.matchCount} elements match. If you need exactly one, scope it: \`#id ${selector}\` or use the unique selector shown above.`,
          '',
        );
      }
      const hidden = matches.filter((element) => !element.visible).length;
      if (hidden > 0 && hidden === matches.length) {
        lines.push('> ⚠️ All sampled matches are **hidden** — `toBeVisible()` will fail. Check parent elements for `display: none` / `visibility: hidden`.', '');
      }
      return toolText(lines.join('\n'));
    }),
};
