#!/usr/bin/env node
/**
 * Verify a published release against its tag.
 *
 * The release notes make a specific promise: `npm ci && npm run mcpb` on the
 * tag rebuilds the published bundle byte for byte. This script turns that
 * promise into a check anyone can run — CI runs it on every published release.
 *
 * Run it from a checkout of the tag, with the bundle already built:
 *
 *   npm ci && npm run mcpb
 *   node scripts/verify-release.mjs v0.2.1 [--dir <downloaded-assets>]
 *
 * It checks that
 *   - the tag matches the version in package.json,
 *   - the published bundle hash equals the one just built from this tree,
 *   - `.mcpb.sha256` and SHA256SUMS.txt agree with the files they name, and
 *     SHA256SUMS.txt covers every asset the release publishes,
 *   - a published signed bundle, with its signature stripped, is byte-identical
 *     to the freshly built bundle (signing only appends a block),
 *   - the published bundle still extracts and carries this version's manifest.
 *
 * Exit code 0 means the release can be re-derived from the tag. The tarball is
 * checked for download integrity only: npm records the packer's line endings,
 * so a locally packed `.tgz` is legitimately different (see the release notes).
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMcpb } from './extract-mcpb.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Parse `sha256sum` output: `<hash>  <name>` or `<hash> *<name>`, `#` comments skipped. */
export function parseChecksums(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})[ \t]+[* ]?(.+)$/.exec(line);
    if (match) entries.push({ hash: match[1].toLowerCase(), name: match[2].trim() });
  }
  return entries;
}

export function hashesMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function runCli(args, cwd = root) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
  if (result.error) throw new Error(`could not run the mcpb CLI: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(`mcpb ${args[0]} failed (exit ${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * @param {{ tag: string, dir: string, localBundle: string, pkg?: { name: string, version: string } }} input
 * @returns {{ checks: {name: string, ok: boolean, detail?: string}[], failures: number }}
 */
export function verifyRelease({ tag, dir, localBundle, pkg: packageJson }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  const pkg = packageJson ?? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = tag.replace(/^v/, '');

  add(
    `tag ${tag} matches package.json version`,
    version === pkg.version,
    `package.json says ${pkg.version}`,
  );

  const bundleName = `${pkg.name}-${version}.mcpb`;
  const signedName = `${pkg.name}-${version}.signed.mcpb`;
  const publishedBundle = path.join(dir, bundleName);
  const publishedSigned = path.join(dir, signedName);
  const sums = path.join(dir, 'SHA256SUMS.txt');

  add(`release publishes ${bundleName}`, existsSync(publishedBundle), `looked in ${dir}`);
  add('release publishes SHA256SUMS.txt', existsSync(sums));
  if (!existsSync(publishedBundle) || !existsSync(localBundle)) {
    return { checks, failures: checks.filter((c) => !c.ok).length };
  }

  const publishedHash = sha256File(publishedBundle);
  const localHash = sha256File(localBundle);
  add(
    'published bundle is byte-identical to a rebuild from this tree',
    hashesMatch(publishedHash, localHash),
    `published ${publishedHash}\n             rebuilt  ${localHash}`,
  );

  // The sidecar names the bundle and the lockfile it was built from.
  const sidecar = `${publishedBundle}.sha256`;
  if (existsSync(sidecar)) {
    const lines = parseChecksums(readFileSync(sidecar, 'utf8'));
    const bundleLine = lines.find((entry) => entry.name === bundleName);
    add(
      'the bundle sidecar agrees with the published bundle',
      Boolean(bundleLine) && hashesMatch(bundleLine.hash, publishedHash),
      bundleLine ? `sidecar says ${bundleLine.hash}` : 'no line for the bundle',
    );
  } else {
    add('the bundle sidecar is published', false, `missing ${path.basename(sidecar)}`);
  }

  // Every published artifact must be covered by SHA256SUMS.txt, and every line
  // in it must match the file it names.
  if (existsSync(sums)) {
    const listed = parseChecksums(readFileSync(sums, 'utf8'));
    const mismatch = [];
    for (const entry of listed) {
      const file = path.join(dir, entry.name);
      if (!existsSync(file)) mismatch.push(`${entry.name}: not in the release`);
      else if (!hashesMatch(sha256File(file), entry.hash)) mismatch.push(`${entry.name}: hash differs`);
    }
    add('SHA256SUMS.txt matches every file it names', mismatch.length === 0, mismatch.join('; '));

    // Nothing shippable may escape the checksum file — including the signing
    // certificate, which is public and part of what users pin.
    const mustBeListed = readdirSync(dir).filter((name) => /\.(mcpb|tgz|pem)$/.test(name));
    const uncovered = mustBeListed.filter((name) => !listed.some((entry) => entry.name === name));
    add(
      'SHA256SUMS.txt covers every published bundle, tarball and certificate',
      uncovered.length === 0,
      uncovered.length ? `not listed: ${uncovered.join(', ')}` : undefined,
    );
  }

  // A signed bundle is the reproducible bundle plus a PKCS#7 block: stripping
  // the signature must give back exactly the bytes the rebuild produced.
  if (existsSync(publishedSigned)) {
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'verify-release-unsign-'));
    try {
      const stripped = path.join(scratch, 'stripped.mcpb');
      writeFileSync(stripped, readFileSync(publishedSigned));
      runCli(['unsign', stripped]);
      add(
        'the signed bundle unsigns back to the reproducible bundle',
        hashesMatch(sha256File(stripped), localHash),
        `${signedName} minus its signature is not the rebuilt bundle`,
      );
    } catch (err) {
      add('the signed bundle unsigns back to the reproducible bundle', false, String(err.message ?? err));
    } finally {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  // The published archive itself must still extract, with this version's manifest.
  const extractDir = mkdtempSync(path.join(os.tmpdir(), 'verify-release-extract-'));
  try {
    const roots = extractMcpb(publishedBundle, extractDir);
    const manifestPath = path.join(extractDir, 'manifest.json');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
    add(
      'the published bundle extracts with this version\u2019s manifest',
      Boolean(manifest) && manifest.name === pkg.name && manifest.version === version && roots.includes('manifest.json'),
      manifest ? `manifest says ${manifest.name} ${manifest.version}` : 'no manifest.json at the archive root',
    );
  } catch (err) {
    add('the published bundle extracts with this version\u2019s manifest', false, String(err.message ?? err));
  } finally {
    rmSync(extractDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  return { checks, failures: checks.filter((c) => !c.ok).length };
}

function parseArgs(argv) {
  const options = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dir') options.dir = argv[++i];
    else options.positional.push(argv[i]);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const tag = options.positional[0];
    if (!tag) {
      console.error('verify-release: pass a release tag, e.g. `node scripts/verify-release.mjs v0.2.1`');
      process.exit(1);
    }

    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const localBundle = path.join(root, `${pkg.name}-${pkg.version}.mcpb`);
    if (!existsSync(localBundle)) {
      console.error(`verify-release: no local bundle at ${path.basename(localBundle)} — run \`npm run mcpb\` first`);
      process.exit(1);
    }

    let dir = options.dir ? path.resolve(options.dir) : null;
    if (!dir) {
      dir = mkdtempSync(path.join(os.tmpdir(), 'verify-release-download-'));
      const download = spawnSync('gh', ['release', 'download', tag, '-D', dir], { cwd: root, stdio: 'inherit' });
      if (download.error || download.status !== 0) {
        throw new Error(`could not download the ${tag} release assets with gh${download.error ? `: ${download.error.message}` : ''}`);
      }
    }

    const { checks, failures } = verifyRelease({ tag, dir, localBundle });
    for (const check of checks) {
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
      if (check.detail) console.log(`     ${check.detail}`);
    }
    console.log(
      failures === 0
        ? `verify-release: ${checks.length} checks passed — ${tag} matches this tree`
        : `verify-release: ${failures} of ${checks.length} checks FAILED`,
    );
    if (failures > 0) process.exitCode = 1;
  } catch (err) {
    console.error(`verify-release: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
