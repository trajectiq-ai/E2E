import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  failureSignature,
  summarizeFlaky,
} from '../dist/tools/diagnose-flaky.js';

test('failureSignature normalizes messages for comparison', () => {
  const sig = failureSignature({
    message: 'Error: expect(received).toBe(expected)\n  at tests/a.spec.ts:4',
  });
  assert.equal(sig, 'error: expect(received).tobe(expected)');

  // Digits fold so timings/selectors do not create fake distinct errors.
  const a = failureSignature({ message: 'Timeout 30000ms exceeded waiting for #btn-12' });
  const b = failureSignature({ message: 'Timeout 5000ms exceeded waiting for #btn-99' });
  assert.equal(a, b, 'digit-folded signatures match');

  // Only the first line participates.
  const multi = failureSignature({ message: 'first line\nsecond line' });
  assert.equal(multi, 'first line');

  assert.equal(failureSignature(undefined), undefined);
  assert.equal(failureSignature({ message: '   ' }), undefined);
});

test('summarizeFlaky: same error every run → CONSISTENTLY FAILING', () => {
  const summary = summarizeFlaky([
    { ok: false, durationMs: 1000, signature: 'same error' },
    { ok: false, durationMs: 1100, signature: 'same error' },
    { ok: false, durationMs: 900, signature: 'same error' },
  ]);
  assert.equal(summary.verdict, 'CONSISTENTLY FAILING');
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 3);
  assert.equal(summary.distinctSignatures, 1);
  assert.equal(summary.sameError, true);
});

test('summarizeFlaky: different errors while always failing still CONSISTENTLY FAILING', () => {
  const summary = summarizeFlaky([
    { ok: false, durationMs: 1, signature: 'error a' },
    { ok: false, durationMs: 1, signature: 'error b' },
  ]);
  assert.equal(summary.verdict, 'CONSISTENTLY FAILING');
  assert.equal(summary.distinctSignatures, 2);
  assert.equal(summary.sameError, false);
});

test('summarizeFlaky: mixed pass/fail → FLAKY', () => {
  const summary = summarizeFlaky([
    { ok: false, durationMs: 1000, signature: 'net error' },
    { ok: true, durationMs: 800 },
    { ok: true, durationMs: 750 },
  ]);
  assert.equal(summary.verdict, 'FLAKY');
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
});

test('summarizeFlaky: all runs pass → NOT REPRODUCING', () => {
  const summary = summarizeFlaky([
    { ok: true, durationMs: 1 },
    { ok: true, durationMs: 1 },
    { ok: true, durationMs: 1 },
  ]);
  assert.equal(summary.verdict, 'NOT REPRODUCING');
  assert.equal(summary.passed, 3);
  assert.equal(summary.failed, 0);
});

test('summarizeFlaky: no tests executed → NO TESTS RAN', () => {
  const summary = summarizeFlaky([
    { ok: false, durationMs: 10, noTests: true },
    { ok: false, durationMs: 10, noTests: true },
  ]);
  assert.equal(summary.verdict, 'NO TESTS RAN');
  assert.equal(summary.passed, 0);
  assert.equal(summary.failed, 0);
});
