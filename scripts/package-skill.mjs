#!/usr/bin/env node
/**
 * Package the agent skill for a marketplace (Agensi) from this repository's
 * own `skill/` folder — and fail when a packaged copy and `skill/` disagree.
 *
 * The marketplace wants one top-level folder named after the skill with
 * `SKILL.md` at its root, text files only and no OS junk; `skill/README.md`
 * has those rules, and this script is what produces the artifact:
 *
 *   npm run skill:zip                        → dist-skill/playwright-e2e-mcp.zip
 *   npm run skill:package                    → ../agensi-skill-<version>/, ready to upload
 *   npm run skill:check                      → build, then compare every copy
 *   npm run skill:check -- ../agensi-skill-0.2.2
 *
 * `package` writes the folder a release would otherwise assemble by hand — the
 * skill copy, its README and the archive — and verifies it with the same
 * comparison `check` uses. An existing folder is left alone unless it matches
 * (idempotent) or `--force` says to replace it, so a published package cannot be
 * overwritten by accident.
 *
 * `check` reports the file names whenever a packaged copy has drifted from
 * `skill/`. That drift is not hypothetical: the repository copy and the package
 * are the same Markdown, one edit on either side is invisible until someone
 * diffs them by hand, and the copy that gets uploaded is the one nobody reads.
 *
 * The archive is written by scripts/zip-writer.mjs, so it is byte-reproducible
 * (sorted entries, one fixed timestamp, no host-derived attributes) and text
 * payloads are LF-normalised first: a CRLF checkout builds the same bytes as an
 * LF one, and so does the same tree on Linux, macOS or Windows.
 *
 * Packaged copies are compared by content, never by archive bytes — a zip that
 * a platform `zip` tool wrote carries real timestamps, which say nothing about
 * whether the Markdown inside it is current.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMcpb } from './extract-mcpb.mjs';
import { createZip, DEFAULT_EPOCH } from './zip-writer.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** The skill's own name: the marketplace folder, and the archive's root folder. */
export const SKILL_NAME = 'playwright-e2e-mcp';
export const skillRoot = path.join(root, 'skill');
export const skillDir = path.join(skillRoot, SKILL_NAME);
export const outDir = path.join(root, 'dist-skill');
export const outPath = path.join(outDir, `${SKILL_NAME}.zip`);

/** Never ship these: the marketplace rejects them, and so do we. */
const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'Thumbs.db:encryptable', 'desktop.ini', '.localized', 'ehthumbs.db']);

/** Every file under `dir`, relative, in sorted order, so zips and diffs are stable. */
export function listTree(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`${rel}: symlinks are not allowed in the skill`);
    if (entry.isDirectory()) out.push(...listTree(dir, rel));
    else out.push(rel);
  }
  return out;
}

/**
 * Text files are compared and archived with LF endings.
 *
 * Windows checkouts run under `core.autocrlf`, so the same commit is CRLF on
 * one machine and LF on another. Normalising removes the host from the
 * comparison — and from the archive, so it hashes the same everywhere. A NUL
 * byte marks something that is not text, and is left exactly as it is.
 */
export function normalise(buf) {
  if (buf.subarray(0, 8192).includes(0)) return buf;
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

/** `{ name, data }` entries for the archive: one top-level folder, text only. */
export function skillEntries(dir = skillDir) {
  const files = listTree(dir);
  if (!files.includes('SKILL.md')) {
    throw new Error(`SKILL.md is missing from ${path.relative(root, dir) || dir}`);
  }
  return files.map((rel) => {
    if (JUNK.has(path.basename(rel))) throw new Error(`${rel} is OS junk and must not be packaged`);
    const raw = readFileSync(path.join(dir, rel));
    if (raw.subarray(0, 8192).includes(0)) throw new Error(`${rel} is not text; the skill ships Markdown only`);
    return { name: `${SKILL_NAME}/${rel}`, data: normalise(raw) };
  });
}

/** The build: a deterministic archive holding exactly the skill tree. */
export function buildSkillZip({ dir = skillDir, epoch = epochFromEnv() } = {}) {
  return createZip(skillEntries(dir), { epoch });
}

function epochFromEnv() {
  return Number(process.env.SOURCE_DATE_EPOCH ?? '') || DEFAULT_EPOCH;
}

/** Every file under `dir` as normalised bytes, keyed by relative path. */
export function readTree(dir) {
  const out = new Map();
  for (const rel of listTree(dir)) out.set(rel, normalise(readFileSync(path.join(dir, rel))));
  return out;
}

/** Stable order, so a report reads the same on every run and platform. */
function sortDifferences(differences) {
  return differences.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0,
  );
}

/** Per-file differences between the repository's skill and a packaged copy. */
export function compareTrees(reference, candidate, label = 'the packaged copy') {
  const differences = [];
  for (const [file, data] of reference) {
    if (!candidate.has(file)) differences.push({ file, detail: `${file} is in skill/ but missing from ${label}` });
    else if (!candidate.get(file).equals(data)) differences.push({ file, detail: `${file} differs from skill/` });
  }
  for (const file of candidate.keys()) {
    if (!reference.has(file)) differences.push({ file, detail: `${file} is in ${label} but not in skill/` });
  }
  return sortDifferences(differences);
}

/** Compare an archive's contents (not its bytes) with `skill/`. */
function differencesInZip(zipPath, label = `${path.basename(zipPath)} (contents)`) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-zip-'));
  try {
    extractMcpb(zipPath, dir);
    const inner = path.join(dir, SKILL_NAME);
    if (!existsSync(inner)) {
      return [{ file: path.basename(zipPath), detail: `archive has no ${SKILL_NAME}/ folder at its root` }];
    }
    return compareTrees(readTree(skillDir), readTree(inner), label);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Compare a packaged copy with `skill/`: the folder the marketplace reads, its
 * README, and the zip inside it when there is one.
 *
 * The target may be the package directory, a bare `playwright-e2e-mcp/` skill
 * folder, or the `.zip` on its own.
 *
 * @param {string} target a packaged directory, a skill folder, or a `.zip`
 */
export function differencesInPackage(target) {
  const resolved = path.resolve(target);
  if (/\.zip$/i.test(resolved)) return differencesInZip(resolved);
  if (!existsSync(resolved)) return [{ file: resolved, detail: `${resolved} does not exist` }];

  const differences = [];
  // Pointing straight at the skill folder is the obvious thing to try, so
  // accept it: it holds SKILL.md and has no README of its own.
  const bare = existsSync(path.join(resolved, 'SKILL.md'));
  const folder = bare ? resolved : path.join(resolved, SKILL_NAME);
  const label = bare ? path.basename(resolved) : `${path.basename(resolved)}/${SKILL_NAME}`;
  if (!existsSync(folder)) {
    differences.push({ file: SKILL_NAME, detail: `${resolved} has no ${SKILL_NAME}/ folder` });
  } else {
    differences.push(...compareTrees(readTree(skillDir), readTree(folder), label));
  }

  const readme = path.join(resolved, 'README.md');
  if (!bare && existsSync(readme)) {
    const repoReadme = path.join(skillRoot, 'README.md');
    if (!existsSync(repoReadme) || !normalise(readFileSync(repoReadme)).equals(normalise(readFileSync(readme)))) {
      differences.push({ file: 'README.md', detail: `README.md differs from skill/README.md` });
    }
  }

  const inner = path.join(resolved, `${SKILL_NAME}.zip`);
  if (existsSync(inner)) differences.push(...differencesInZip(inner));
  return sortDifferences(differences);
}

/**
 * Where a package for this version belongs: the folder `agensi-skill-<version>`
 * beside the checkout, which is where `check` looks for one by default.
 */
export function versionedPackageDir() {
  return path.resolve(root, '..', `agensi-skill-${pkg.version}`);
}

/** The marketplace copy for the version this checkout is on, if it is there. */
export function defaultTarget() {
  const candidate = versionedPackageDir();
  return existsSync(candidate) ? candidate : undefined;
}

/** The files a generated package holds, as they will be written. */
function packageContents() {
  const files = new Map();
  for (const rel of listTree(skillDir)) {
    files.set(`${SKILL_NAME}/${rel}`, normalise(readFileSync(path.join(skillDir, rel))));
  }
  files.set('README.md', normalise(readFileSync(path.join(skillRoot, 'README.md'))));
  return { files, zip: buildSkillZip() };
}

/** Write a package folder: the skill copy, its README, and the archive to upload. */
export function writeSkillPackage(target) {
  const resolved = path.resolve(target);
  const { files, zip } = packageContents();
  for (const [rel, data] of files) {
    const dest = path.join(resolved, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, data);
  }
  writeFileSync(path.join(resolved, `${SKILL_NAME}.zip`), zip);
  return { target: resolved, files: files.size, zip, sha256: sha256(zip) };
}

/**
 * The whole check: the build is reproducible, the archive holds exactly the
 * skill tree, and any packaged copy agrees with it.
 *
 * @param {string} [target] packaged folder or zip; defaults to `../agensi-skill-<version>`
 */
export function checkSkillPackage(target = defaultTarget()) {
  const problems = [];
  const build = buildSkillZip();

  // Two builds of one tree have to be the same bytes, or nothing downstream can
  // be compared at all.
  if (!build.equals(buildSkillZip())) {
    problems.push('two builds of skill/ differ — the archive is not byte-reproducible');
  }

  // Read the archive back and compare what is inside it with the tree it came
  // from: a walker that skipped a file or a bad entry prefix is invisible
  // otherwise, and extraction masks a wrong prefix.
  const differences = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skill-build-'));
  try {
    const archive = path.join(dir, `${SKILL_NAME}.zip`);
    writeFileSync(archive, build);
    differences.push(...differencesInZip(archive, `the built archive`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const resolved = target ? path.resolve(target) : undefined;
  if (resolved) differences.push(...differencesInPackage(resolved));

  return {
    ok: problems.length === 0 && differences.length === 0,
    problems,
    differences: sortDifferences(differences),
    target: resolved,
    bytes: build,
    files: skillEntries().map((entry) => entry.name.replace(`${SKILL_NAME}/`, '')),
  };
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Relative when the path is inside the checkout, absolute when it is not. */
function displayPath(target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith('..') ? relative : target;
}

function report(result) {
  if (result.problems.length) result.problems.forEach((problem) => console.error(`  FAIL ${problem}`));
  else console.log(`  OK   the build is byte-reproducible and holds exactly skill/ (${result.files.length} files)`);

  for (const { detail } of result.differences) console.error(`  FAIL ${detail}`);

  const target = result.target ? displayPath(result.target) : undefined;
  if (!result.target) {
    console.log(
      `  --   no packaged copy to compare (looked for ../agensi-skill-${pkg.version}); ` +
        'pass a folder or a .zip to compare one',
    );
  } else if (result.ok) {
    console.log(`  OK   ${target} matches skill/ (compared by content, zip included)`);
  }
  return result.ok;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'build') {
    const outIndex = rest.indexOf('--out');
    const target = outIndex === -1 ? outPath : path.resolve(rest[outIndex + 1] ?? outPath);
    const zip = buildSkillZip();
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, zip);
    const files = skillEntries().map((entry) => entry.name.replace(`${SKILL_NAME}/`, ''));
    console.log(`package-skill: wrote ${displayPath(target)} (${files.length} files, ${(zip.length / 1024).toFixed(1)} KB)`);
    console.log(`  sha256    ${sha256(zip)}`);
    console.log(`  contents  ${SKILL_NAME}/ (${files.join(', ')})`);
    console.log('  upload this archive to the marketplace; SKILL.md sits at its root.');
    return 0;
  }

  if (command === 'package') {
    const force = rest.includes('--force');
    const args = rest.filter((arg) => arg !== '--force');
    const outIndex = args.indexOf('--out');
    let target = versionedPackageDir();
    if (outIndex !== -1) {
      const dir = args[outIndex + 1];
      if (!dir || dir.startsWith('-')) {
        console.error('package-skill: --out needs a directory');
        return 2;
      }
      target = path.resolve(dir);
      args.splice(outIndex, 2);
    }
    // A typo here builds a package in the wrong place, so refuse anything left.
    const leftover = args.filter((arg) => arg.length > 0);
    if (leftover.length) {
      console.error(`package-skill: unexpected argument(s): ${leftover.join(', ')}`);
      return 2;
    }

    const display = displayPath(target);
    if (existsSync(target)) {
      const existing = differencesInPackage(target);
      if (existing.length === 0) {
        console.log(`package-skill: ${display} already matches skill/ — nothing to write`);
        console.log(`  upload    ${path.join(display, `${SKILL_NAME}.zip`)}`);
        return 0;
      }
      if (!force) {
        existing.forEach((difference) => console.error(`  FAIL ${difference.detail}`));
        console.error(
          `package-skill: ${display} exists and differs from skill/ in ${existing.length} place(s) —\n` +
            '  bump the version for a new package, or pass --force to replace this one',
        );
        return 1;
      }
      console.log(`package-skill: replacing ${display} (--force)`);
    }

    const written = writeSkillPackage(target);
    // Verify what was just written with the same comparison `check` uses, so a
    // successful exit means the folder really is the skill tree.
    const differences = differencesInPackage(written.target);
    if (differences.length) {
      differences.forEach((difference) => console.error(`  FAIL ${difference.detail}`));
      console.error('package-skill: the folder just written does not match skill/ — this is a bug');
      return 1;
    }

    console.log(`package-skill: wrote ${display} (${written.files} files + archive, ${(written.zip.length / 1024).toFixed(1)} KB)`);
    console.log(`  sha256    ${written.sha256}`);
    console.log(`  contents  ${display}/${SKILL_NAME}/ (${written.files - 1} files), ${display}/README.md, ${display}/${SKILL_NAME}.zip`);
    console.log('  verified  matches skill/ file by file, archive included');
    console.log(`  upload    ${display}/${SKILL_NAME}.zip to the marketplace; SKILL.md sits at its root.`);
    return 0;
  }

  if (command === 'check') {
    const [target] = rest;
    let result;
    try {
      result = checkSkillPackage(target ?? defaultTarget());
    } catch (err) {
      console.error(`package-skill: ${err instanceof Error ? err.message : err}`);
      return 1;
    }
    const ok = report(result);
    if (!ok) {
      console.error(
        `package-skill: ${result.problems.length + result.differences.length} problem(s) — ` +
          'run `npm run skill:zip` to rebuild, or bring the packaged copy back in line',
      );
    }
    return ok ? 0 : 1;
  }

  console.error('usage: node scripts/package-skill.mjs build [--out <zip>]');
  console.error('       node scripts/package-skill.mjs package [--out <dir>] [--force]');
  console.error('       node scripts/package-skill.mjs check [<packaged dir|zip>]');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
