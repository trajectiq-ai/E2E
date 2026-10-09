import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  brokenLocatorFromMessage,
  failingLine,
  findCallSpan,
  healConfidence,
  healTokensFor,
  unifiedDiff,
} from '../dist/tools/suggest-fix.js';
import { parseLocator } from '../dist/utils/locator-expr.js';
import { createProgressParser } from '../dist/utils/playwright-runner.js';

test('brokenLocatorFromMessage reads expect and action errors', () => {
  assert.equal(
    brokenLocatorFromMessage("Error: expect(locator).toBeVisible() failed\n\nLocator: getByTestId('save-btn')\nExpected: visible"),
    "getByTestId('save-btn')",
  );
  assert.equal(
    brokenLocatorFromMessage("TimeoutError: locator.click: Timeout 3000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Pay' })"),
    "getByRole('button', { name: 'Pay' })",
  );
  assert.equal(brokenLocatorFromMessage('Error: expect(received).toBe(expected)'), undefined);
});

test('healTokensFor splits ids and keeps the identifying words', () => {
  const heal = healTokensFor(parseLocator("getByTestId('checkoutSubmitBtn')"));
  assert.deepEqual(heal.distinctive, ['checkout', 'submit']);
  assert.ok(heal.tokens.includes('button'), 'btn expands to button');
  const role = healTokensFor(parseLocator("getByRole('button', { name: 'Place order' })"));
  assert.equal(role.role, 'button');
  assert.deepEqual(role.distinctive, ['place', 'order']);
  const css = healTokensFor(parseLocator('#cart-total .amount'));
  assert.deepEqual(css.distinctive, ['cart', 'total', 'amount']);
});

test('healConfidence: generic-only overlap is never a fix', () => {
  const heal = healTokensFor(parseLocator("getByTestId('save-btn')"));
  const buy = { attributes: { 'data-testid': 'cta-button' }, name: 'Buy now', role: 'button', text: 'Buy now', score: 4 };
  assert.equal(healConfidence(buy, heal).level, 'none');
  const save = { attributes: { 'data-testid': 'save-button' }, name: 'Save', role: 'button', text: 'Save', score: 7 };
  assert.equal(healConfidence(save, heal, buy).level, 'high');
});

test('findCallSpan finds the call regardless of quote style', () => {
  const line = `  await page.getByTestId("buy-button").click({ timeout: 3000 });`;
  const span = findCallSpan(line, parseLocator("getByTestId('buy-button')")[0]);
  assert.equal(line.slice(span.start, span.end), 'getByTestId("buy-button")');
  assert.equal(findCallSpan('nothing here', parseLocator("getByTestId('x')")[0]), undefined);
});

test('failingLine prefers the stack frame inside the spec', () => {
  const failure = { file: 'tests/checkout.spec.ts', line: 3, message: 'x', stack: 'Error\n    at /p/tests/checkout.spec.ts:18:47' };
  assert.equal(failingLine(failure), 18);
  assert.equal(failingLine({ ...failure, stack: undefined }), 3);
});

test('unifiedDiff renders a one-line change with context', () => {
  const diff = unifiedDiff('tests/a.spec.ts', ['a', 'b', 'c', 'd', 'e'], 3, 'C');
  assert.equal(diff, ['--- a/tests/a.spec.ts', '+++ b/tests/a.spec.ts', '@@ -1,5 +1,5 @@', ' a', ' b', '-c', '+C', ' d', ' e'].join('\n'));
});

test('createProgressParser counts list-reporter lines across chunks', () => {
  const seen = [];
  const feed = createProgressParser((p) => seen.push(p));
  feed('\nRunning 3 tests using 1 worker\n\n  ✓  1 [chromium] › a.spec.ts:3:5 › one (1.2s)\n  ✘  2 [chro');
  feed('mium] › a.spec.ts:9:5 › two (5.0s)\n  ok 3 [chromium] › a.spec.ts:12:5 › three (12ms)\n');
  const last = seen[seen.length - 1];
  assert.equal(last.total, 3);
  assert.equal(last.done, 3);
  assert.equal(last.failed, 1);
  assert.match(last.last, /three$/);
});
