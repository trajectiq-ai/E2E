#!/usr/bin/env node
/**
 * Launch simulation for the .mcpb bundle.
 *
 * Mimics what Claude Desktop does on install: substitute ${__dirname},
 * ${HOME} (default) and ${user_config.project_root} in mcp_config, spawn
 * the entry, and complete an MCP initialize handshake. Also asserts the
 * unsubstituted-placeholder fallback (host without user_config support).
 *
 * Usage: node scripts/mcpb-launch-sim.mjs <extracted-dir>
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/mcpb-launch-sim.mjs <extracted-dir>');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const cfg = manifest.server.mcp_config;
const home = mkdtempSync(path.join(os.tmpdir(), 'mcpb-sim-home-'));

/** Host-style substitution of one mcp_config slot. */
function substitute(value, { projectRoot }) {
  return value
    .replaceAll('${__dirname}', dir)
    .replaceAll('${HOME}', home)
    .replaceAll('${user_config.project_root}', projectRoot);
}

function handshake(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      substitute(cfg.command, { projectRoot: env.PW_MCP_PROJECT_ROOT ?? '' }),
      cfg.args.map((a) => substitute(a, { projectRoot: env.PW_MCP_PROJECT_ROOT ?? '' })),
      { cwd: dir, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const msg = JSON.parse(line);
        if (msg.id === 1) {
          child.kill();
          resolve({ result: msg.result, stderr });
        }
      } catch {
        /* not JSON — server logs go to stderr, so ignore stray output */
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) reject(new Error(`server exited ${code}: ${stderr}`));
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'mcpb-launch-sim', version: '0.0.0' },
        },
      })}\n`,
    );
    setTimeout(() => {
      child.kill();
      reject(new Error(`handshake timed out: ${stderr}`));
    }, 15000);
  });
}

try {
  // 1. Normal install path: user picked a project root.
  const picked = mkdtempSync(path.join(os.tmpdir(), 'mcpb-sim-project-'));
  const ok = await handshake({ PW_MCP_PROJECT_ROOT: substitute(cfg.env.PW_MCP_PROJECT_ROOT, { projectRoot: picked }) });
  const info = ok.result?.serverInfo;
  if (!info || !info.name || !info.version) {
    console.error(`FAIL: handshake returned no serverInfo (${JSON.stringify(ok.result)})`);
    process.exit(1);
  }
  console.log(`PASS handshake ${info.name} ${info.version} (project root: ${picked})`);

  // 2. Host that does NOT substitute user_config: placeholder reaches the
  //    server verbatim; it must fall back to cwd instead of using it as a path.
  const literal = substitute(cfg.env.PW_MCP_PROJECT_ROOT, { projectRoot: '${user_config.project_root}' });
  if (!literal.includes('${user_config.project_root}')) {
    console.error('FAIL: expected the placeholder to survive substitution for this test');
    process.exit(1);
  }
  const fallback = await handshake({ PW_MCP_PROJECT_ROOT: literal });
  if (!/unsubstituted \$\{...\} placeholder/.test(fallback.stderr)) {
    console.error(`FAIL: expected a placeholder-fallback warning on stderr:\n${fallback.stderr}`);
    process.exit(1);
  }
  console.log(`PASS unsubstituted placeholder falls back to cwd (warned on stderr)`);

  rmSync(home, { recursive: true, force: true });
  console.log('launch sim: all checks passed');
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
