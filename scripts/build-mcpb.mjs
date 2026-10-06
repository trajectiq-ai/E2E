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

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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

// The staging dir and temp zip never outlive the script, success or not.
process.on('exit', () => {
  rmSync(stage, { recursive: true, force: true });
  rmSync(zipPath, { force: true });
});

// No shell: arguments are passed as an array. npm is run through its own
// JS entry point so Windows needs no npm.cmd shim, which Node only spawns
// through a shell.
function run(command, args, cwd, input) {
  const result = spawnSync(command, args, { cwd, stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], input });
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `exit ${result.status}`;
    console.error(`mcpb: \`${command} ${args.join(' ')}\` failed (${why})`);
    process.exit(result.status || 1);
  }
}

/** npm's own JS entry point: npm_execpath when npm launched us, else the npm bundled with this Node. */
function npmCliPath() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && path.basename(fromEnv) === 'npm-cli.js' && existsSync(fromEnv)) return fromEnv;
  const nodeDir = path.dirname(process.execPath);
  return [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows layout
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // POSIX layout
  ].find((candidate) => existsSync(candidate));
}

/** Every file under `dir`, relative and sorted, so the zip's entry order is stable. */
function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

// 1. Fresh staging directory with only what the server needs at runtime.
//    The previous bundle stays in place until the new one is verified.
rmSync(stage, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stage, { recursive: true });

cpSync(path.join(root, 'package.json'), path.join(stage, 'package.json'));
cpSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
cpSync(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });

// Production deps only; --ignore-scripts keeps our `prepare` build from
// re-running (dist/ is already copied in).
const npmCi = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
const npmCli = npmCliPath();
if (npmCli) run(process.execPath, [npmCli, ...npmCi], stage);
else if (process.platform !== 'win32') run('npm', npmCi, stage);
else {
  console.error('mcpb: could not find npm-cli.js next to node; run this through `npm run mcpb`');
  process.exit(1);
}

// 2. Write the manifest built by buildManifest(pkg).
writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(buildManifest(pkg), null, 2)}\n`, 'utf8');

// 3. Zip the staging directory with CLEAN entry names (manifest.json at
//    the archive root — Claude Desktop's DXT loader rejects `./`-prefixed
//    entries). For a reproducible archive every file gets the same mtime
//    (SOURCE_DATE_EPOCH, default 2020-01-01) and entries are added in
//    sorted order without extra attributes. Windows: bsdtar detects the
//    zip format from content; its entry order is its own.
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? '') || 1577836800;
const members = ['manifest.json', 'dist', 'node_modules', 'package.json'];
const files = members.flatMap((member) =>
  statSync(path.join(stage, member)).isDirectory() ? listFiles(stage, member) : [member],
);
for (const file of files) utimesSync(path.join(stage, file), epoch, epoch);
if (process.platform === 'win32') {
  // Prefer the system bsdtar: a PATH `tar` may be GNU tar (Git Bash),
  // which cannot write zips and parses `C:\...` as a remote host.
  const systemTar = ['C:/Windows/System32/tar.exe', 'C:/Windows/tar.exe'].find((candidate) => existsSync(candidate));
  run(systemTar ?? 'tar', ['-a', '-c', '-f', zipPath, '-C', stage, ...members], root);
} else {
  run('zip', ['-X', '-D', '-q', zipPath, '-@'], stage, `${files.join('\n')}\n`);
}

// 4. Read the zip central directory and fail the build unless
//    manifest.json sits at the archive root (extraction masks a bad
//    prefix, so verify the entries themselves).
const zip = readFileSync(zipPath);
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

// 5. Only now replace the previous bundle, then record what went in and
//    what came out, so a release can be checked against its lockfile.
renameSync(zipPath, outPath);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
writeFileSync(
  `${outPath}.sha256`,
  `${sha256(outPath)}  ${path.basename(outPath)}\n${sha256(path.join(root, 'package-lock.json'))}  package-lock.json\n`,
  'utf8',
);

console.log(`mcpb: wrote ${path.relative(root, outPath)} (${(statSync(outPath).size / 1024 / 1024).toFixed(1)} MB)`);
