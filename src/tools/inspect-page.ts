/**
 * Tool 3 — inspect-page: launch a headless browser against a live URL
 * and return the rendered DOM: element inventory with unique CSS
 * selectors, visibility, boxes, text and attributes, optional HTML and
 * captured console messages.
 */

import { z } from 'zod';
import type { ElementInfo, ToolContext, ToolResponse } from '../types/index.js';
import {
  assertHttpUrl,
  clipLines,
  guard,
  resolveProjectRoot,
  runBrowserScript,
  toolError,
  toolText,
} from './shared.js';

const inspectPageInput = z.object({
  url: z.string().describe('Full URL of the page to open (http/https)'),
  projectRoot: z
    .string()
    .optional()
    .describe('Project whose Playwright install launches the browser; defaults to the server working directory'),
  selector: z
    .string()
    .optional()
    .describe('CSS selector: inspect matches instead of the whole DOM'),
  waitFor: z
    .string()
    .optional()
    .describe('Wait for this selector (CSS or "text=...") to appear before inspecting'),
  waitUntil: z
    .enum(['load', 'domcontentloaded', 'networkidle'])
    .optional()
    .describe('Navigation wait condition (default domcontentloaded)'),
  includeHtml: z.boolean().optional().describe('Include the rendered HTML (truncated)'),
  maxHtmlChars: z.number().int().min(1_000).max(200_000).optional().describe('HTML cap when includeHtml is set (default 20000)'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .optional()
    .describe('Overall inspection limit in ms (default 45000)'),
});

export type InspectPageInput = z.infer<typeof inspectPageInput>;
export const inspectPageSchema = inspectPageInput;

function renderElement(element: ElementInfo, position: number): string {
  const visibility = element.visible ? 'visible' : 'hidden';
  const box = element.box
    ? `${element.box.width}×${element.box.height} at (${element.box.x},${element.box.y})`
    : 'no box';
  const lines = [
    `${position}. \`${element.selector}\` — **${element.tag}** · ${visibility} · ${box}`,
  ];
  if (element.text) lines.push(`   text: "${element.text}"`);
  const attrs = Object.entries(element.attributes).filter(
    ([name]) => name !== 'class' && name !== 'id',
  );
  if (attrs.length > 0) {
    const shown = attrs
      .slice(0, 8)
      .map(([name, value]) => `\`${name}="${value.length > 80 ? `${value.slice(0, 80)}…` : value}"\``);
    lines.push(`   attrs: ${shown.join(' ')}`);
  }
  return lines.join('\n');
}

export const inspectPageTool = {
  name: 'inspect-page',
  description:
    'Open a URL in a headless browser and return the rendered DOM: elements with unique CSS selectors, visibility, bounding boxes, text, attributes, captured console messages and optional HTML. Use this to understand a live page before writing or fixing selectors/tests. Requires a reachable URL (detects a missing dev server).',
  inputSchema: inspectPageSchema,
  handler: async (args: InspectPageInput, ctx: ToolContext): Promise<ToolResponse> =>
    guard('inspect-page', async () => {
      const url = assertHttpUrl(args.url);
      const root = await resolveProjectRoot(args.projectRoot, ctx);
      const timeoutMs = args.timeoutMs ?? 45_000;

      const outcome = await runBrowserScript(
        {
          mode: 'inspect',
          projectRoot: root,
          url,
          selector: args.selector,
          waitFor: args.waitFor,
          waitUntil: args.waitUntil,
          includeHtml: args.includeHtml,
          maxHtmlChars: args.maxHtmlChars,
          gotoTimeout: Math.max(5_000, timeoutMs - 5_000),
          waitTimeout: Math.min(10_000, Math.max(3_000, timeoutMs - 5_000)),
          startedAt: Date.now(),
        },
        { timeoutMs, signal: ctx.signal },
      );

      if (!outcome.ok) {
        return toolError(
          outcome.kind ?? 'UNKNOWN',
          `Could not inspect ${url}: ${outcome.error ?? 'unknown error'}`,
          outcome.hint,
          outcome.stderrTail,
        );
      }

      const data = outcome.data!;
      if (data.parseError) {
        return toolError(
          'INVALID_PATH',
          `Invalid selector "${args.selector}": ${data.parseError}`,
          'inspect-page validates CSS selectors only (what document.querySelectorAll accepts).',
        );
      }

      const lines: string[] = [];
      const title = data.title ? `"${data.title}"` : '(no title)';
      lines.push(`## 🔎 ${title}`, '');
      lines.push(
        `**URL:** ${url}${data.finalUrl && data.finalUrl !== url ? ` → ${data.finalUrl}` : ''}  ` ,
        `**Elements:** ${data.elementCount}  |  **Viewport:** ${data.viewport ? `${data.viewport.width}×${data.viewport.height}` : '—'}  |  **Took:** ${data.durationMs ?? 0}ms`,
        '',
      );

      const heading = args.selector
        ? `### Matches for \`${args.selector}\` (${data.matchCount})`
        : `### DOM sample (first ${data.elements.length} of ${data.elementCount} elements)`;
      lines.push(heading, '');
      if (data.elements.length === 0) {
        lines.push('_No elements matched._', '');
      } else {
        for (let i = 0; i < data.elements.length; i += 1) {
          lines.push(renderElement(data.elements[i], i + 1), '');
        }
        if (data.matchCount > data.elements.length) {
          lines.push(`_…and ${data.matchCount - data.elements.length} more. Narrow with \`selector\`._`, '');
        }
      }

      const errors = (data.consoleMessages ?? []).filter((m) => m.type === 'error' || m.type === 'pageerror');
      const messages = [...errors, ...(data.consoleMessages ?? []).filter((m) => m.type !== 'error' && m.type !== 'pageerror')];
      if (messages.length > 0) {
        lines.push('### Console', '');
        for (const message of messages.slice(0, 20)) {
          lines.push(`- \`${message.type}\`: ${clipLines(message.text, 1, 240)}`);
        }
        if (messages.length > 20) lines.push(`- _…${messages.length - 20} more_`);
        lines.push('');
      }

      if (data.html !== undefined) {
        lines.push(
          `### HTML${data.htmlTruncated ? ` (truncated at ${data.html.length} chars)` : ''}`,
          '',
          '```html',
          data.html,
          '```',
          '',
        );
      }

      if (args.selector && data.matchCount > 1) {
        lines.push(
          `> \`${args.selector}\` matches ${data.matchCount} elements. If you need exactly one, use the first unique selector above.`,
        );
      }
      return toolText(lines.join('\n'));
    }),
};
