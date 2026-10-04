/**
 * Cross-platform test launcher.
 *
 * `node --test` discovery differs across Node versions: Node 20 does not
 * expand glob patterns, Node 24 no longer accepts directory arguments,
 * and default cwd discovery would also pick up `dist/*-test.js`. This
 * launcher enumerates `*.test.mjs` itself and passes explicit file
 * paths, which works on every Node version and shell (cmd, sh, pwsh).
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(dir, name));

if (files.length === 0) {
  console.error('run-tests: no *.test.mjs files found');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
