/**
 * The .mcpb manifest has failed in three distinct ways on install:
 * `./`-prefixed zip entries, a missing manifest_version, and a relative
 * entry path that died in the host's cwd. buildManifest() is the single
 * source of truth, so these invariants — plus the user_config project-root
 * prompt added for Extension UX polish — are pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../scripts/mcpb-manifest.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const manifest = buildManifest(pkg);

test('manifest declares required core fields', () => {
  assert.equal(manifest.manifest_version, '0.4');
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.description, pkg.description);
  assert.equal(manifest.author.name, 'trajectiq-ai');
  assert.ok(manifest.server, 'server block required');
});

test('server launches via ${__dirname}, never a relative path', () => {
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.server.entry_point, 'dist/index.js');
  assert.equal(manifest.server.mcp_config.command, 'node');
  const [entryArg] = manifest.server.mcp_config.args;
  assert.ok(entryArg.startsWith('${__dirname}/'), `expected \${__dirname} prefix, got ${entryArg}`);
  assert.ok(entryArg.endsWith('/dist/index.js'));
});

test('project root is prompted via user_config and wired into the env', () => {
  const { project_root: projectRoot } = manifest.user_config;
  assert.ok(projectRoot, 'user_config.project_root must exist');
  assert.equal(projectRoot.type, 'directory');
  assert.equal(projectRoot.required, true);
  assert.ok(projectRoot.title && projectRoot.description, 'prompt needs title + description');
  // The env var the server actually reads must be substituted from it.
  assert.equal(
    manifest.server.mcp_config.env.PW_MCP_PROJECT_ROOT,
    '${user_config.project_root}',
  );
});

test('project root has no default so the user must pick a folder', () => {
  const projectRoot = buildManifest(pkg).user_config.project_root;
  assert.equal(projectRoot.default, undefined);
  assert.match(projectRoot.description, /not your home directory/);
});
