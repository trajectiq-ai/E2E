import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractMcpb } from '../scripts/extract-mcpb.mjs';
import {
  buildSkillZip,
  checkSkillPackage,
  differencesInPackage,
  listTree,
  readTree,
  SKILL_NAME,
  skillDir,
  skillEntries,
  skillRoot,
} from '../scripts/package-skill.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'scripts', 'package-skill.mjs');

/** A temp directory that is always cleaned up. */
function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'package-skill-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A packaged copy shaped like the marketplace expects: folder, README, zip. */
function makePackage(dir, edit = () => {}) {
  cpSync(skillDir, path.join(dir, SKILL_NAME), { recursive: true });
  cpSync(path.join(skillRoot, 'README.md'), path.join(dir, 'README.md'));
  writeFileSync(path.join(dir, `${SKILL_NAME}.zip`), buildSkillZip());
  edit(dir);
  return dir;
}

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('the archive holds the skill tree under one top-level folder', () => {
  const entries = skillEntries();
  const names = entries.map((entry) => entry.name);
  const expected = listTree(skillDir).map((rel) => `${SKILL_NAME}/${rel}`);

  assert.deepEqual(names, expected, 'one entry per file, prefix included');
  assert.ok(names.includes(`${SKILL_NAME}/SKILL.md`), 'SKILL.md sits at the folder root');
  assert.ok(
    names.every((name) => name.startsWith(`${SKILL_NAME}/`) && !name.startsWith('./')),
    'every entry is inside the named folder',
  );

  // Payloads are the files themselves, LF-normalised, so a CRLF checkout and an
  // LF one produce the same bytes.
  for (const entry of entries) {
    const rel = entry.name.slice(`${SKILL_NAME}/`.length);
    const source = readFileSync(path.join(skillDir, rel));
    assert.equal(entry.data.toString('utf8'), source.toString('utf8').replace(/\r\n/g, '\n'), `${rel} payload`);
  }
});

test('the same tree always produces the same archive', () => {
  assert.deepEqual(buildSkillZip(), buildSkillZip());
});

test('a CRLF checkout builds byte-identical output', (t) => {
  const dir = scratch(t);
  const crlf = path.join(dir, SKILL_NAME);
  for (const rel of listTree(skillDir)) {
    const target = path.join(crlf, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(skillDir, rel)).toString('utf8').replace(/\r?\n/g, '\r\n'));
  }
  assert.deepEqual(buildSkillZip({ dir: crlf }), buildSkillZip(), 'line endings of the checkout cannot leak in');
});

test('the archive round-trips to exactly the skill tree', (t) => {
  const dir = scratch(t);
  const archive = path.join(dir, `${SKILL_NAME}.zip`);
  writeFileSync(archive, buildSkillZip());
  const out = path.join(dir, 'out');
  extractMcpb(archive, out);

  const extracted = readTree(path.join(out, SKILL_NAME));
  const source = readTree(skillDir);
  assert.deepEqual([...extracted.keys()], [...source.keys()]);
  for (const [rel, bytes] of source) assert.deepEqual(extracted.get(rel), bytes, rel);
});

test('OS junk, binary payloads, symlinks and a missing SKILL.md are refused', (t) => {
  const dir = scratch(t);
  const tree = path.join(dir, SKILL_NAME);
  const write = (rel, data) => {
    const target = path.join(tree, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  };

  // A minimal valid tree, then one violation at a time.
  write('SKILL.md', '---\nname: playwright-e2e-mcp\n---\n');
  write('references/setup.md', '# setup\n');
  assert.equal(skillEntries(tree).length, 2, 'the baseline tree packages');

  write('Thumbs.db', 'junk');
  assert.throws(() => skillEntries(tree), /Thumbs\.db is OS junk/);
  unlinkSync(path.join(tree, 'Thumbs.db'));

  write('references/shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  assert.throws(() => skillEntries(tree), /not text/);
  unlinkSync(path.join(tree, 'references/shot.png'));

  unlinkSync(path.join(tree, 'SKILL.md'));
  assert.throws(() => skillEntries(tree), /SKILL\.md is missing/);
  write('SKILL.md', '---\nname: playwright-e2e-mcp\n---\n');

  // Creating a symlink needs privileges on Windows; where it cannot be created,
  // there is nothing to assert.
  const link = path.join(tree, 'references', 'link.md');
  try {
    symlinkSync(path.join(tree, 'SKILL.md'), link, 'file');
  } catch {
    t.diagnostic('symlinks need privileges on this platform — skipped');
    return;
  }
  assert.throws(() => skillEntries(tree), /symlinks are not allowed/);
});

test('a packaged copy that matches skill/ reports no differences', (t) => {
  const dir = scratch(t);
  assert.deepEqual(differencesInPackage(makePackage(dir)), []);
  assert.equal(checkSkillPackage(path.join(dir, SKILL_NAME)).ok, true, 'a bare skill folder compares too');
  assert.equal(checkSkillPackage(path.join(dir, `${SKILL_NAME}.zip`)).ok, true, 'and so does the zip');
});

test('drift is reported per file, with the file named', (t) => {
  const dir = scratch(t);
  const pkg = makePackage(dir, (target) => {
    const setup = path.join(target, SKILL_NAME, 'references', 'setup.md');
    writeFileSync(setup, `${readFileSync(setup, 'utf8')}\n<!-- hand edit -->\n`);
    writeFileSync(path.join(target, SKILL_NAME, 'references', 'stray.md'), 'not in skill/\n');
    writeFileSync(path.join(target, 'README.md'), '# different packaging notes\n');
  });

  const differences = differencesInPackage(pkg);
  const files = differences.map((d) => d.file);
  assert.deepEqual(files, ['README.md', 'references/setup.md', 'references/stray.md']);
  assert.match(differences.find((d) => d.file === 'references/setup.md').detail, /differs from skill\//);
  assert.match(differences.find((d) => d.file === 'references/stray.md').detail, /but not in skill\//);

  // A file the package dropped is drift too, and the README is part of the copy.
  rmSync(path.join(pkg, SKILL_NAME, 'references', 'stray.md'));
  cpSync(path.join(skillDir, 'references', 'setup.md'), path.join(pkg, SKILL_NAME, 'references', 'setup.md'));
  unlinkSync(path.join(pkg, SKILL_NAME, 'references', 'example-session.md'));
  const missing = differencesInPackage(pkg);
  assert.deepEqual(missing.map((d) => d.file), ['README.md', 'references/example-session.md']);
  assert.match(missing[1].detail, /is in skill\/ but missing from/);
});

test('a stale zip inside a packaged copy is caught, by content not bytes', (t) => {
  const dir = scratch(t);
  const stale = scratch(t);
  const tree = path.join(stale, SKILL_NAME);
  cpSync(skillDir, tree, { recursive: true });
  writeFileSync(path.join(tree, 'SKILL.md'), '---\nname: playwright-e2e-mcp\n---\nstale\n');

  const pkg = makePackage(dir, (target) => {
    writeFileSync(path.join(target, `${SKILL_NAME}.zip`), buildSkillZip({ dir: tree }));
  });
  const differences = differencesInPackage(pkg);
  assert.equal(differences.length, 1);
  assert.match(differences[0].detail, /SKILL\.md differs from skill\/$/);

  // The released package was written by a platform `zip` with real timestamps:
  // a different epoch must still compare clean, because only content matters.
  const otherEpoch = path.join(stale, `${SKILL_NAME}.zip`);
  writeFileSync(otherEpoch, buildSkillZip({ epoch: 1_600_000_000 }));
  assert.notDeepEqual(readFileSync(otherEpoch), buildSkillZip(), 'the bytes really are different');
  assert.deepEqual(differencesInPackage(otherEpoch), []);
});

test('the CLI builds, and fails with the file names when copies disagree', (t) => {
  const dir = scratch(t);
  const good = makePackage(path.join(dir, 'good'));
  const bad = makePackage(path.join(dir, 'bad'), (target) => {
    const tools = path.join(target, SKILL_NAME, 'references', 'tools.md');
    writeFileSync(tools, `${readFileSync(tools, 'utf8')}\nstale\n`);
  });

  const out = path.join(dir, 'out', `${SKILL_NAME}.zip`);
  const built = runCli(['build', '--out', out]);
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(readFileSync(out), buildSkillZip(), 'the CLI writes exactly the deterministic build');
  assert.match(built.stdout, /wrote .*playwright-e2e-mcp\.zip \(5 files, [\d.]+ KB\)/);
  assert.match(built.stdout, /contents {2}playwright-e2e-mcp\/ \(SKILL\.md, /);

  const pass = runCli(['check', good]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /matches skill\/ \(compared by content/);

  const fail = runCli(['check', bad]);
  assert.equal(fail.status, 1, 'drift must be a non-zero exit');
  assert.match(fail.stderr, /references\/tools\.md differs from skill\//);

  const usage = runCli(['nonsense']);
  assert.equal(usage.status, 2, 'an unknown command is a usage error');
});

test('package writes the versioned folder and verifies what it wrote', (t) => {
  const dir = scratch(t);
  const target = path.join(dir, 'agensi-skill-0.2.2');
  const written = runCli(['package', '--out', target]);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /verified {2}matches skill\/ file by file, archive included/);
  assert.match(written.stdout, /upload {4}.*playwright-e2e-mcp\.zip to the marketplace/);

  // Exactly the layout the marketplace reads, and nothing else.
  const expected = [
    'README.md',
    ...listTree(skillDir).map((rel) => `${SKILL_NAME}/${rel}`),
    `${SKILL_NAME}.zip`,
  ];
  assert.deepEqual(listTree(target), expected);
  assert.deepEqual(readFileSync(path.join(target, `${SKILL_NAME}.zip`)), buildSkillZip(), 'the archive is the deterministic build');
  assert.deepEqual(readTree(path.join(target, SKILL_NAME)), readTree(skillDir), 'the skill copy is the repository copy');
  assert.deepEqual(differencesInPackage(target), [], 'the generated folder satisfies the check');
  assert.equal(runCli(['check', target]).status, 0, 'and `check` agrees');
});

test('package leaves a folder that already matches untouched', (t) => {
  const dir = scratch(t);
  const target = path.join(dir, 'agensi-skill-0.2.2');
  assert.equal(runCli(['package', '--out', target]).status, 0);

  // A published package must not be rewritten by an idempotent run, so pin the
  // mtime and prove it survives.
  const pinned = new Date(1_600_000_000_000);
  const readme = path.join(target, 'README.md');
  utimesSync(readme, pinned, pinned);
  const again = runCli(['package', '--out', target]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already matches skill\/ — nothing to write/);
  assert.equal(statSync(readme).mtimeMs, pinned.getTime(), 'nothing was rewritten');
});

test('package refuses to replace a drifted folder unless --force', (t) => {
  const dir = scratch(t);
  const target = path.join(dir, 'agensi-skill-0.2.2');
  assert.equal(runCli(['package', '--out', target]).status, 0);

  const stale = path.join(target, SKILL_NAME, 'references', 'tools.md');
  writeFileSync(stale, '# stale copy\n');

  const refused = runCli(['package', '--out', target]);
  assert.equal(refused.status, 1, 'an existing folder that differs is not replaced');
  assert.match(refused.stderr, /references\/tools\.md differs from skill\//);
  assert.match(refused.stderr, /bump the version for a new package, or pass --force/);
  assert.equal(readFileSync(stale, 'utf8'), '# stale copy\n', 'the drifted file is still there');

  const forced = runCli(['package', '--out', target, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /replacing .* \(--force\)/);
  assert.deepEqual(differencesInPackage(target), [], 'the replacement matches skill/');
});

test('package rejects bad arguments instead of writing somewhere unexpected', (t) => {
  const dir = scratch(t);
  assert.equal(runCli(['package', '--out']).status, 2, '--out without a directory');
  assert.equal(runCli(['package', '--wat']).status, 2, 'an unknown option');
  assert.equal(runCli(['package', path.join(dir, 'here')]).status, 2, 'a stray positional argument');
  assert.deepEqual(listTree(dir), [], 'nothing was written');
});
