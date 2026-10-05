/**
 * resolveDefaultProjectRoot() is what makes the .mcpb user_config prompt
 * safe: hosts that collect PW_MCP_PROJECT_ROOT but do not substitute
 * `${user_config.project_root}` would otherwise hand the server a literal
 * placeholder path and every tool call would fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDefaultProjectRoot } from '../dist/server.js';

const original = process.env.PW_MCP_PROJECT_ROOT;

function withEnv(value, fn) {
  if (value === undefined) delete process.env.PW_MCP_PROJECT_ROOT;
  else process.env.PW_MCP_PROJECT_ROOT = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.PW_MCP_PROJECT_ROOT;
    else process.env.PW_MCP_PROJECT_ROOT = original;
  }
}

test('unsubstituted ${user_config.project_root} placeholder falls back to cwd', () => {
  withEnv('${user_config.project_root}', () => {
    assert.equal(resolveDefaultProjectRoot(), process.cwd());
  });
});

test('any ${...} placeholder in PW_MCP_PROJECT_ROOT falls back to cwd', () => {
  withEnv('C:\\proj\\${HOME}', () => {
    assert.equal(resolveDefaultProjectRoot(), process.cwd());
  });
});

test('empty or whitespace value falls back to cwd', () => {
  withEnv('', () => assert.equal(resolveDefaultProjectRoot(), process.cwd()));
  withEnv('   ', () => assert.equal(resolveDefaultProjectRoot(), process.cwd()));
});

test('a real directory is used as the project root', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pw-mcp-root-'));
  try {
    withEnv(dir, () => assert.equal(resolveDefaultProjectRoot(), dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unset env falls back to cwd', () => {
  withEnv(undefined, () => assert.equal(resolveDefaultProjectRoot(), process.cwd()));
});
