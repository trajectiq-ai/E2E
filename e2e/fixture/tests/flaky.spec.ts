import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

const markerFile = path.join(__dirname, '.flaky-marker');

/**
 * Deterministic flakiness: the very first run (marker absent) creates the
 * marker file and fails; every later run passes because the marker exists.
 *
 * - `run-test` with its auto-retry-once reports this as flaky (1 flaky).
 * - `diagnose-flaky` (retries disabled, 3 runs) sees 1 failure + 2 passes
 *   → FLAKY verdict.
 *
 * The harness deletes the marker between those two phases.
 */
test('inventory sync retries until the marker exists', async () => {
  if (!fs.existsSync(markerFile)) {
    fs.writeFileSync(markerFile, 'created by the first run', 'utf8');
    expect(true, 'first run must fail — the marker was just created').toBe(false);
  }

  expect(fs.existsSync(markerFile)).toBe(true);
});
