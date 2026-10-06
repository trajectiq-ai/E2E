// Generates the README demo images (docs/demo-*.png) by screenshotting two
// terminal-style cards:
//
//   demo-endpoint.png  — an illustration of initialize + tools/list for a
//                        client that sends the bearer token (all 8 tools).
//                        The text is written here, not captured; without a
//                        token the endpoint lists only list-tests and get-failure.
//   demo-run-test.png  — a real `run-test` call served over stdio by
//                        `node dist/index.js` against examples/sample-test.spec.ts
//                        (captured 2026-10-06; Chromium, 5.1s, 4 passed)
//
// Re-run with: node scripts/gen-demo-images.mjs
// Requires devDependencies installed (uses @playwright/test's Chromium).

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs');
mkdirSync(outDir, { recursive: true });

const TOOLS = [
  ['run-test', 'Run Playwright E2E tests, return structured pass/fail results and diagnostics'],
  ['get-failure', 'Full failure message, code frame, expected vs actual, network + console errors, next steps'],
  ['inspect-page', 'Open a URL headlessly and return the rendered DOM with unique CSS selectors'],
  ['list-tests', 'List the Playwright tests available in the project (file, line, title, projects)'],
  ['validate-selector', 'Check a CSS selector against a live page: syntax, match count, sample elements'],
  ['generate-e2e-test', 'Scaffold a Playwright test from a description using the project’s REAL selectors'],
  ['compare-visual-state', 'Pixel-level visual diff against a stored baseline: where and how much changed'],
  ['diagnose-flaky', 'Evidence-based verdict: CONSISTENTLY FAILING · FLAKY · NOT REPRODUCING'],
];

const RUN_RESPONSE = `## Playwright run — ✅ PASSED

**Command:** \`playwright test examples/sample-test.spec.ts --retries=1 --trace=retain-on-failure --reporter=json\`
**duration 5.5s · exit 0 · auto retry ×1**

| passed | failed | flaky | skipped | duration |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 0 | 0 | 0 | 5.1s |`;

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const page = ({ badge, badgeColor, request, response }) => `<!doctype html>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { background: #0d1117; font: 13px/1.55 "Cascadia Code", Consolas, "Courier New", monospace;
         padding: 26px; width: 1010px; color: #c9d1d9; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 10px; overflow: hidden; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; background: #21262d;
         border-bottom: 1px solid #30363d; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: ${badgeColor}; }
  .badge { font-size: 12px; font-weight: 600; color: #e6edf3; letter-spacing: .2px; }
  .url { margin-left: auto; font-size: 11.5px; color: #8b949e; }
  .sect { padding: 14px 18px; }
  .req  { border-bottom: 1px solid #21262d; }
  .label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 1.3px; color: #8b949e;
           margin-bottom: 8px; }
  .json { color: #a5d6ff; white-space: pre-wrap; word-break: break-all; }
  .meth { color: #7ee787; font-weight: 600; }
  .out  { white-space: pre-wrap; }
  .h    { color: #7ee787; font-weight: 700; }
  .b    { color: #e6edf3; font-weight: 700; }
  .c    { color: #8b949e; }
  table { border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #30363d; padding: 5px 14px; text-align: right; font-size: 12.5px; }
  th { background: #21262d; color: #8b949e; font-weight: 600; }
  td { color: #7ee787; font-weight: 700; }
  .tool { display: flex; gap: 10px; padding: 3px 0; }
  .tool .n { color: #d2a8ff; font-weight: 700; min-width: 178px; }
  .tool .d { color: #8b949e; }
</style>
<div class="card">
  <div class="bar"><span class="dot"></span><span class="badge">${badge}</span><span class="url">${esc(request.url)}</span></div>
  <div class="sect req"><div class="label">Request</div><div class="json">${request.body}</div></div>
  <div class="sect"><div class="label">Response</div><div class="out">${response}</div></div>
</div>`;

const endpointHtml = page({
  badge: 'TOKEN-PROTECTED ENDPOINT · Streamable HTTP',
  badgeColor: '#3fb950',
  request: {
    url: 'https://playwright-e2e-mcp.vercel.app/api/mcp',
    body: `<span class="meth">POST</span> /api/mcp
<span class="c">accept: application/json, text/event-stream</span>
<span class="c">authorization: Bearer ••••••••</span>

{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18",…}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`,
  },
  response: `{"result":{"serverInfo":{"name":"<span class="b">playwright-e2e-mcp</span>","version":"<span class="b">0.1.2</span>"},"capabilities":{"tools":{"listChanged":true}}}}

<span class="h">8 tools:</span>
${TOOLS.map(([n, d]) => `<div class="tool"><span class="n">${n}</span><span class="d">${esc(d)}</span></div>`).join('\n')}`,
});

const runHtml = page({
  badge: 'LOCAL · npx -y playwright-e2e-mcp',
  badgeColor: '#d29922',
  request: {
    url: 'stdio · JSON-RPC',
    body: `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"<span class="meth">run-test</span>",
      "arguments":{"testFiles":["examples/sample-test.spec.ts"]}}}`,
  },
  response: `<span class="h">## Playwright run — ✅ PASSED</span>

<span class="b">Command:</span> <span class="c">playwright test examples/sample-test.spec.ts --retries=1 --trace=retain-on-failure --reporter=json</span>
<span class="b">duration 5.5s · exit 0 · auto retry ×1</span>

<table>
  <tr><th>passed</th><th>failed</th><th>flaky</th><th>skipped</th><th>duration</th></tr>
  <tr><td>4</td><td>0</td><td>0</td><td>0</td><td>5.1s</td></tr>
</table>

<span class="c">structured markdown result · per-failure file:line + fix hints on failure</span>`,
});

const shots = [
  ['demo-endpoint.png', endpointHtml],
  ['demo-run-test.png', runHtml],
];

const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
);
try {
  for (const [name, html] of shots) {
    const file = join(root, '.demo-page.html');
    writeFileSync(file, html);
    const p = await browser.newPage({ viewport: { width: 1010, height: 900 }, deviceScaleFactor: 2 });
    await p.goto(pathToFileURL(file).href);
    // clip to the card's real height so the image has no dead space at the bottom
    const height = await p.evaluate(() => Math.ceil(document.body.scrollHeight));
    await p.screenshot({ path: join(outDir, name), clip: { x: 0, y: 0, width: 1010, height } });
    await p.close();
    console.log('wrote', join('docs', name));
  }
} finally {
  await browser.close();
}
