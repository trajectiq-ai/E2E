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
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from './mcpb-manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, 'dist-mcpb');
const zipPath = path.join(root, 'bundle.zip');
const outPath = path.join(root, `${pkg.name}-${pkg.version}.mcpb`);

// No shell: arguments are passed as an array. npm is run through its own
// JS entry point (npm_execpath, set by `npm run`) so Windows needs no
// npm.cmd shim, which Node only spawns through a shell.
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
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
const npmCi = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
const npmCli = process.env.npm_execpath;
if (npmCli && /\.c?js$/.test(npmCli)) run(process.execPath, [npmCli, ...npmCi], stage);
else if (process.platform !== 'win32') run('npm', npmCi, stage);
else {
  console.error('mcpb: run this through `npm run mcpb` so npm can be located without a shell');
  process.exit(1);
}

// 2. Write the manifest built by buildManifest(pkg).
writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(buildManifest(pkg), null, 2)}\n`, 'utf8');

// 3. Zip the staging directory with CLEAN entry names (manifest.json at
//    the archive root — Claude Desktop's DXT loader rejects `./`-prefixed
//    entries) and rename to .mcpb. Windows: bsdtar detects the zip format
//    from content.
const members = ['manifest.json', 'dist', 'node_modules', 'package.json'];
if (process.platform === 'win32') {
  // Prefer the system bsdtar: a PATH `tar` may be GNU tar (Git Bash),
  // which cannot write zips and parses `C:\...` as a remote host.
  const systemTar = ['C:/Windows/System32/tar.exe', 'C:/Windows/tar.exe'].find((candidate) => existsSync(candidate));
  run(systemTar ?? 'tar', ['-a', '-c', '-f', zipPath, '-C', stage, ...members], root);
} else {
  run('zip', ['-r', '-q', zipPath, ...members], stage);
}
renameSync(zipPath, outPath);

// 4. Read the zip central directory and fail the build unless
//    manifest.json sits at the archive root (extraction masks a bad
//    prefix, so verify the entries themselves).
const zip = readFileSync(outPath);
const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (eocd === -1) {
  console.error('mcpb: not a zip archive');
  process.exit(1);
}
const entryCount = zip.readUInt16LE(eocd + 10);
let offset = zip.readUInt32LE(eocd + 16);
const names = [];
for (let i = 0; i < entryCount; i += 1) {
  if (zip.readUInt32LE(offset) !== 0x02014b50) break;
  const nameLen = zip.readUInt16LE(offset + 28);
  names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLen));
  offset += 46 + nameLen + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
}
if (!names.includes('manifest.json')) {
  console.error(`mcpb: manifest.json not at archive root (entries: ${names.slice(0, 5).join(', ')} …)`);
  process.exit(1);
}

// 5. Record what went in and what came out, so a release can be checked
//    against the lockfile it was built from.
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(
  `${outPath}.sha256`,
  `${sha256(outPath)}  ${path.basename(outPath)}\n${sha256(path.join(root, 'package-lock.json'))}  package-lock.json\n`,
  'utf8',
);

console.log(`mcpb: wrote ${path.relative(root, outPath)} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
rmSync(stage, { recursive: true, force: true });

if (!existsSync(outPath)) process.exit(1);
