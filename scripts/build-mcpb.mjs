#!/usr/bin/env node
/**
 * Build a self-contained `.mcpb` bundle (MCP Desktop Extension / MCP
 * Bundle format — https://github.com/modelcontextprotocol/mcpb).
 *
 * The bundle is a zip with manifest.json at the root, plus dist/ and a
 * production-only node_modules, so any MCP client can run it with
 * `node dist/index.js` without installing anything. Used to publish to
 * Smithery (`smithery mcp publish ./playwright-e2e-mcp-<v>.mcpb -n ...`)
 * and as a one-click install artifact for Claude Desktop.
 *
 * Usage: npm run mcpb   →  playwright-e2e-mcp-<version>.mcpb
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, 'dist-mcpb');
const zipPath = path.join(root, 'bundle.zip');
const outPath = path.join(root, `${pkg.name}-${pkg.version}.mcpb`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    console.error(`mcpb: \`${command} ${args.join(' ')}\` failed (exit ${result.status})`);
    process.exit(result.status ?? 1);
  }
}

// 1. Fresh staging directory with only what the server needs at runtime.
rmSync(stage, { recursive: true, force: true });
rmSync(zipPath, { force: true });
rmSync(outPath, { force: true });
mkdirSync(stage, { recursive: true });

cpSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
cpSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });

// Production deps only; --ignore-scripts keeps our `prepare` build from
// re-running (dist/ is already copied in).
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stage);

// 2. MCPB manifest (required: name, version, description, author, server).
const manifest = {
  name: pkg.name,
  display_name: 'Playwright E2E MCP',
  version: pkg.version,
  description: pkg.description,
  author: { name: 'trajectiq-ai', url: 'https://github.com/trajectiq-ai' },
  homepage: 'https://github.com/trajectiq-ai/E2E#readme',
  license: pkg.license ?? 'MIT',
  keywords: ['mcp', 'playwright', 'e2e', 'testing'],
  server: {
    type: 'node',
    entry_point: 'dist/index.js',
    mcp_config: { command: 'node', args: ['dist/index.js'], env: {} },
  },
  compatibility: {
    runtimes: { node: '>=20' },
    platforms: ['darwin', 'win32', 'linux'],
  },
};
writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

// 3. Zip the staging directory (zip content at archive root) and rename
//    to .mcpb. Windows: bsdtar detects the zip format from content.
if (process.platform === 'win32') {
  // Prefer the system bsdtar: a PATH `tar` may be GNU tar (Git Bash),
  // which cannot write zips and parses `C:\...` as a remote host.
  const systemTar = ['C:/Windows/System32/tar.exe', 'C:/Windows/tar.exe'].find((candidate) => existsSync(candidate));
  run(systemTar ?? 'tar', ['-a', '-c', '-f', zipPath, '-C', stage, '.'], root);
} else {
  run('zip', ['-r', '-q', zipPath, '.'], stage);
}
renameSync(zipPath, outPath);

console.log(`mcpb: wrote ${path.relative(root, outPath)} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
rmSync(stage, { recursive: true, force: true });

if (!existsSync(outPath)) process.exit(1);
