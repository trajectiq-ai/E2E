/**
 * The repo ships a project-scoped `.agents/mcp.json` so Freebuff/Codebuff
 * agents get this MCP server workspace-wide. Freebuff validates that file
 * against a strict zod schema (strictObject: unknown keys are rejected),
 * so a typo here would silently drop the whole file. check-mcp-json.mjs
 * mirrors that schema; this test keeps the committed file valid.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configFile = path.join(repoRoot, '.agents', 'mcp.json');
const checkScript = path.join(repoRoot, 'scripts', 'check-mcp-json.mjs');

test('project .agents/mcp.json parses against Freebuff mcpFileSchema', () => {
  const result = spawnSync(process.execPath, [checkScript, configFile], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('project .agents/mcp.json registers the published server command', () => {
  const raw = JSON.parse(readFileSync(configFile, 'utf8'));
  const server = raw.mcpServers['playwright-e2e'];
  assert.ok(server, 'expected mcpServers["playwright-e2e"]');
  assert.equal(server.command, 'npx');
  assert.deepEqual(server.args, ['-y', 'github:trajectiq-ai/E2E']);
});
