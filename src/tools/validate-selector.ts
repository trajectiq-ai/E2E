/**
 * Tool 5 — validate-selector: verify a selector or Playwright locator
 * against a live page: does it parse, how many elements match (Playwright
 * actions need exactly one), what do the matches look like, and which
 * sturdier locator addresses the same element?
 *
 * Accepts CSS, every Playwright selector engine (text=, role=, xpath=, >>)
 * and locator expressions such as getByRole('button', { name: 'Save' }).
 * Expressions are parsed into a whitelisted call chain, never evaluated.
 */

import { z } from 'zod';
import type { ToolContext, ToolResponse } from '../types/index.js';
import { PlaywrightMcpError } from '../types/index.js';
import {
  assertHttpUrl,
  bestLocator,
  clipLines,
  describePageState,
  guard,
  loginHint,
  pageStateShape,
  resolvePageState,
  resolveProjectRoot,
  runBrowserScript,
  toolError,
  toolText,
} from './shared.js';
import { assertUrlAllowed } from '../utils/url-policy.js';
import { formatLocator, isLocatorExpression, parseLocator } from '../utils/locator-expr.js';
import type { LocatorCall } from '../utils/locator-expr.js';

const validateSelectorInput = z.object({
  url: z.string().describe('Full URL of the live page to test against (http/https)'),
  selector: z
    .string()
    .min(1)
    .describe("Selector or locator, e.g. getByRole('button', { name: 'Save' })"),
  projectRoot: z
    .string()
    .optional()
    .describe('Project whose Playwright launches the browser (default: server root)'),
  ...pageStateShape,
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

/** Brittle CSS: positional chains and long descendant paths break on any layout change. */
function isBrittle(selector: string, chain: LocatorCall[]): boolean {
  if (chain.length !== 1 || chain[0].method !== 'locator') return false;
  return /:nth-(of-type|child)\(|(\s>\s.*){3,}/.test(selector) || /^\/\/|^xpath=/.test(selector);
}

function invalid(selector: string, reason: string): ToolResponse {
  return toolText(
    [
      `## ❌ INVALID — \`${selector}\``,
      '',
      `**Parse error:** \`${reason}\``,
      '',
      "**How to fix:** pass valid CSS (`#save`, `[data-testid=\"save\"]`), a Playwright selector (`text=Save`, `role=button[name=\"Save\"]`) or a locator (`getByRole('button', { name: 'Save' })`). Common mistakes: unescaped `#`/`.` in ids, a stray `>`, unbalanced quotes.",
      '',
      "Use **inspect-page** with `view: 'locators'` to see verified locators for the live elements.",
    ].join('\n'),
  );
}

export const validateSelectorTool = {
  name: 'validate-selector',
  description:
    "Check a CSS selector, Playwright selector or locator (getByRole/getByTestId…, .first(), .filter()) on a live page: validity, match count (actions need exactly 1), sample matches and a sturdier verified locator for each. Accepts storageState/headers/actions.",
  inputSchema: validateSelectorSchema,
  handler: async (args: ValidateSelectorInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('validate-selector', async () => {
      const url = assertHttpUrl(args.url);
      await assertUrlAllowed(url);
      const selector = args.selector.trim();

      let chain: LocatorCall[];
      try {
        chain = parseLocator(selector);
      } catch (err) {
        if (err instanceof PlaywrightMcpError) return invalid(selector, err.message.replace(/^Cannot parse locator: /, ''));
        throw err;
      }

      const timeoutMs = args.timeoutMs ?? 45_000;
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const state = await resolvePageState(args, root, url, ctx);

      const outcome = await runBrowserScript(
        {
          ...state,
          mode: 'validate',
          projectRoot: root,
          url,
          selectorChain: chain,
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
      if (data.parseError) return invalid(selector, data.parseError);

      const kind = isLocatorExpression(selector) ? 'locator' : 'selector';
      const lines: string[] = [];
      const stateLine = describePageState(state, root);
      if (data.matchCount === 0) {
        lines.push(`## ✅ VALID — 0 matches`, '', `\`${selector}\` is a valid ${kind} but matched nothing on ${url}.`, '');
        if (stateLine) lines.push(`**Page state:** ${stateLine}`, '');
        const login = loginHint(data.finalUrl, state);
        if (login) lines.push(`> 🔒 ${login}`, '');
        lines.push(
          "**How to fix:** confirm the element exists in this state (it may appear only after an interaction: pass `actions`). Run **inspect-page** with `view: 'locators'` on the same URL to list real, verified locators.",
        );
        return toolText(lines.join('\n'));
      }

      lines.push(`## ✅ VALID — ${data.matchCount} match${data.matchCount === 1 ? '' : 'es'}`, '');
      lines.push(`**URL:** ${url}${kind === 'locator' ? `  |  **Parsed as:** \`${formatLocator(chain)}\`` : ''}`);
      if (stateLine) lines.push(`**Page state:** ${stateLine}`);
      lines.push('');
      const matches = data.elements;
      for (let i = 0; i < matches.length; i += 1) {
        const element = matches[i];
        const box = element.box ? `${element.box.width}×${element.box.height} at (${element.box.x},${element.box.y})` : 'no box';
        lines.push(
          `${i + 1}. \`${element.selector}\` — **${element.tag}** · ${element.visible ? 'visible' : 'hidden'} · ${box}`,
        );
        if (element.text) lines.push(`   text: "${clipLines(element.text, 1, 140)}"`);
        const best = bestLocator(element);
        if (best && best !== formatLocator(chain)) lines.push(`   unique locator: \`${best}\``);
      }
      lines.push('');
      if (data.matchCount > 1) {
        lines.push(
          `> ⚠️ ${data.matchCount} elements match, so a Playwright action on it throws a strict mode violation. Use the unique locator of the element you mean (above), or add \`.first()\` / \`.filter({ hasText: '…' })\` deliberately.`,
          '',
        );
      } else if (isBrittle(selector, chain)) {
        const best = bestLocator(matches[0]);
        if (best && !best.startsWith('locator(')) {
          lines.push(`> 💡 \`${selector}\` depends on page structure and breaks on layout changes. Prefer \`${best}\`, which targets the same element.`, '');
        }
      }
      const hidden = matches.filter((element) => !element.visible).length;
      if (hidden > 0 && hidden === matches.length) {
        lines.push('> ⚠️ All sampled matches are **hidden** — `toBeVisible()` will fail. Check parent elements for `display: none` / `visibility: hidden`.', '');
      }
      return toolText(lines.join('\n'));
    }),
};
