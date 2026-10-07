#!/usr/bin/env node
/**
 * Launch simulation for the .mcpb bundle.
 *
 * Mimics what Claude Desktop does on install: substitute ${__dirname},
 * ${HOME} and ${user_config.project_root} in mcp_config, spawn
 * the entry, and complete an MCP initialize handshake. Also asserts the
 * unsubstituted-placeholder fallback (host without user_config support).
 *
 * Usage: node scripts/mcpb-launch-sim.mjs [<bundle.mcpb> | <extracted-dir>]
 *
 * With no argument the bundle this checkout just built is used
 * (`npm run mcpb` → <name>-<version>.mcpb), extracted via Node's own zlib,
 * so the check needs no `unzip` and behaves the same on every platform.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMcpb } from './extract-mcpb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve the argument to something with a manifest.json at its root. */
function locate() {
  const arg = process.argv[2];
  if (!arg) {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const built = path.join(root, `${pkg.name}-${pkg.version}.mcpb`);
    if (!existsSync(built)) {
      throw new Error(`no bundle at ${path.basename(built)} — run \`npm run mcpb\` first, or pass a .mcpb path / extracted dir`);
    }
    return { kind: 'mcpb', target: built };
  }
  const abs = path.resolve(arg);
  if (!existsSync(abs)) throw new Error(`no such path: ${arg}`);
  if (/\.mcpb$/i.test(abs)) return { kind: 'mcpb', target: abs };
  if (statSync(abs).isDirectory()) return { kind: 'dir', target: abs };
  throw new Error(`expected a .mcpb file or an extracted directory: ${arg}`);
}

const scratch = [];
const tmp = (prefix) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

// Set once the entry is resolved; substitute() and handshake() read them at call time.
let dir = '';
let home = '';
let cfg = { command: '', args: [], env: {} };

/** Host-style substitution of one mcp_config slot. */
function substitute(value, { projectRoot }) {
  return value
    .replaceAll('${__dirname}', dir)
    .replaceAll('${HOME}', home)
    .replaceAll('${user_config.project_root}', projectRoot);
}

function handshake(env) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let result;
    let timer;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
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
          // Resolve on 'close' (below), not here: the reply arrives before the
          // process has released its handles, and the temp tree is deleted
          // right after this resolves.
          result = msg.result;
          child.kill();
        }
      } catch {
        /* not JSON — server logs go to stderr, so ignore stray output */
      }
    });
    child.on('error', (err) => settle(reject, err));
    child.on('close', (code) => {
      if (result !== undefined) settle(resolve, { result, stderr });
      else settle(reject, new Error(`server closed without an initialize reply (exit ${code}): ${stderr}`));
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
    timer = setTimeout(() => {
      child.kill();
      settle(reject, new Error(`handshake timed out: ${stderr}`));
    }, 15000);
  });
}

try {
  const located = locate();
  if (located.kind === 'mcpb') {
    dir = tmp('mcpb-sim-extract-');
    extractMcpb(located.target, dir);
    console.log(`extracted ${path.basename(located.target)} -> temp dir`);
  } else {
    dir = located.target;
  }
  home = tmp('mcpb-sim-home-');

  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  cfg = manifest.server.mcp_config;

  // 1. Normal install path: user picked a project root.
  const picked = tmp('mcpb-sim-project-');
  const ok = await handshake({ PW_MCP_PROJECT_ROOT: substitute(cfg.env.PW_MCP_PROJECT_ROOT, { projectRoot: picked }) });
  const info = ok.result?.serverInfo;
  if (!info || !info.name || !info.version) {
    throw new Error(`handshake returned no serverInfo (${JSON.stringify(ok.result)})`);
  }
  console.log(`PASS handshake ${info.name} ${info.version} (project root: ${picked})`);

  // 2. Host that does NOT substitute user_config: placeholder reaches the
  //    server verbatim; it must fall back to cwd instead of using it as a path.
  const literal = substitute(cfg.env.PW_MCP_PROJECT_ROOT, { projectRoot: '${user_config.project_root}' });
  if (!literal.includes('${user_config.project_root}')) {
    throw new Error('expected the placeholder to survive substitution for this test');
  }
  const fallback = await handshake({ PW_MCP_PROJECT_ROOT: literal });
  if (!/unsubstituted \$\{...\} placeholder/.test(fallback.stderr)) {
    throw new Error(`expected a placeholder-fallback warning on stderr:\n${fallback.stderr}`);
  }
  console.log(`PASS unsubstituted placeholder falls back to cwd (warned on stderr)`);

  console.log('launch sim: all checks passed');
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  // Windows can hold on to a just-closed child's handles for a moment even
  // after 'close'; the retries turn that transient EPERM into a no-op.
  for (const d of scratch) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
