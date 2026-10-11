import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSEMBLED_MARKER,
  assembleRelease,
  checkStatedHashes,
  collectAssets,
  commitsSince,
  readNotes,
  releaseBody,
  repositoryUrl,
  validateVersions,
} from '../scripts/assemble-release.mjs';
import { parseChecksums, sha256File } from '../scripts/verify-release.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;
const tag = `v${version}`;
const bundleName = `${pkg.name}-${version}.mcpb`;
const tarballName = `${pkg.name}-${version}.tgz`;
const skillName = `${pkg.name}-${version}-skill.zip`;

const server = JSON.parse(readFileSync(path.join(repoRoot, 'server.json'), 'utf8'));

/**
 * A stand-in release tree: the notes file, a bundle with its sidecar, a
 * tarball. Small fake bytes are enough — the assembly copies and hashes files
 * rather than reading inside them.
 */
function fixture({ notes = `# ${tag} — a test release\n\nWhat is in it.\n\n### Changed\n\n- a thing.\n`, sidecar = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'assemble-release-test-'));
  mkdirSync(path.join(dir, 'release-notes'), { recursive: true });
  writeFileSync(path.join(dir, 'release-notes', `${tag}.md`), notes);
  const bundle = path.join(dir, bundleName);
  writeFileSync(bundle, Buffer.from('not really a bundle\n'));
  if (sidecar) {
    writeFileSync(`${bundle}.sha256`, `${sha256File(bundle)}  ${bundleName}\n${'f'.repeat(64)}  package-lock.json\n`);
  }
  const tarball = path.join(dir, tarballName);
  writeFileSync(tarball, Buffer.from('not really a tarball\n'));
  return {
    dir,
    notesDir: dir,
    bundle,
    tarball,
    assetsDir: path.join(dir, 'dist-release', 'assets'),
    bodyPath: path.join(dir, 'dist-release', 'RELEASE_BODY.md'),
    titlePath: path.join(dir, 'dist-release', 'RELEASE_TITLE.txt'),
  };
}

function assemble(f) {
  return assembleRelease({
    tag,
    assetsDir: f.assetsDir,
    bundle: f.bundle,
    tarball: f.tarball,
    notesDir: f.notesDir,
    bodyPath: f.bodyPath,
    titlePath: f.titlePath,
  });
}

test('the tag, package.json and server.json have to name one version', () => {
  assert.equal(validateVersions({ tag, pkg, server }), version);
  assert.equal(validateVersions({ tag: `v${version}`, pkg, server: null }), version);

  assert.throws(() => validateVersions({ tag: 'v9.9.9', pkg, server: null }), /the tag says v9\.9\.9/);
  assert.throws(() => validateVersions({ tag: 'main', pkg, server }), /not a release tag/);
  assert.throws(() => validateVersions({ tag, pkg: { ...pkg, version: '9.9.9' }, server }), /package\.json says 9\.9\.9/);
  assert.throws(() => validateVersions({ tag, pkg, server: { ...server, version: '9.9.9' } }), /server\.json says 9\.9\.9/);
  assert.throws(
    () => validateVersions({ tag, pkg, server: { version, packages: [{ version: '1.2.3' }] } }),
    /packages\[0\] says 1\.2\.3/,
  );
});

test('the release title comes from the notes H1, which has to name the tag', () => {
  const f = fixture();
  try {
    const notes = readNotes({ dir: f.notesDir, tag });
    assert.equal(notes.title, `${tag} — a test release`);
    assert.match(notes.body, /^What is in it\./);

    writeFileSync(path.join(f.notesDir, 'release-notes', `${tag}.md`), 'No title here.\n');
    assert.throws(() => readNotes({ dir: f.notesDir, tag }), /has to start with its title as an H1/);

    writeFileSync(path.join(f.notesDir, 'release-notes', `${tag}.md`), '# v1.0.0 — wrong version\n\nnotes\n');
    assert.throws(() => readNotes({ dir: f.notesDir, tag }), /has to name/);

    writeFileSync(path.join(f.notesDir, 'release-notes', `${tag}.md`), `# ${tag}\n\n   \n`);
    assert.throws(() => readNotes({ dir: f.notesDir, tag }), /title but no notes below it/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a release without notes does not assemble', () => {
  const f = fixture();
  try {
    rmSync(path.join(f.notesDir, 'release-notes'), { recursive: true, force: true });
    assert.throws(() => assemble(f), /no release notes at release-notes\/v[\d.]+\.md/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('the notes may not write their own assets table', () => {
  const f = fixture({ notes: `# ${tag} — a test release\n\n### Assets\n\n| asset | sha256 |\n| --- | --- |\n` });
  try {
    assert.throws(() => assemble(f), /that table is generated/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('a hash typed into the notes has to be one this release publishes', () => {
  const allowed = new Set(['a'.repeat(64)]);
  const notes = { title: 'x', body: 'nothing to see' };
  assert.doesNotThrow(() => checkStatedHashes({ notes, text: notes.body, allowed, tag }));
  assert.doesNotThrow(() => checkStatedHashes({ notes, text: `see ${'a'.repeat(64)}`, allowed, tag }));
  assert.throws(
    () => checkStatedHashes({ notes, text: `line one\nsee ${'b'.repeat(64)}`, allowed, tag }),
    /line 2: b{64}/,
  );
  // A 40-character commit id is not a hash this check cares about.
  assert.doesNotThrow(() => checkStatedHashes({ notes, text: `committed as ${'c'.repeat(40)}`, allowed, tag }));
});

test('the notes may quote a hash the release actually publishes', () => {
  const f = fixture();
  try {
    const hash = sha256File(f.bundle);
    writeFileSync(
      path.join(f.notesDir, 'release-notes', `${tag}.md`),
      `# ${tag} — a test release\n\nThe bundle hashes ${hash}, which is what ships.\n`,
    );
    const result = assemble(f);
    assert.match(result.body, new RegExp(hash));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('the notes may not quote a hash this release does not publish', () => {
  const f = fixture({
    notes: `# ${tag} — a test release\n\nThe bundle hashes ${'0'.repeat(64)}.\n`,
  });
  try {
    assert.throws(() => assemble(f), /states a hash this release does not publish/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('assembly stages the artifacts, covers them all in SHA256SUMS.txt, and writes the body', () => {
  const f = fixture();
  try {
    const result = assemble(f);

    assert.deepEqual(
      result.assets.map((asset) => asset.name),
      [bundleName, tarballName, skillName, `${bundleName}.sha256`],
      'the bundle comes first for a reader, the checksums for it last',
    );
    assert.equal(result.signer, null);

    const sums = readFileSync(path.join(f.assetsDir, 'SHA256SUMS.txt'), 'utf8');
    const listed = parseChecksums(sums);
    assert.deepEqual(listed.map((entry) => entry.name), result.assets.map((asset) => asset.name));
    for (const entry of listed) {
      assert.equal(entry.hash, sha256File(path.join(f.assetsDir, entry.name)), `${entry.name} is hashed correctly`);
    }
    // Everything staged is covered — that is what verify-release checks on a download.
    const staged = readFileSync(path.join(f.assetsDir, `${bundleName}.sha256`), 'utf8');
    assert.match(staged, new RegExp(`^${sha256File(f.bundle)}  ${bundleName.replace(/\./g, '\\.')}$`, 'm'));

    const body = readFileSync(f.bodyPath, 'utf8');
    assert.ok(body.startsWith(ASSEMBLED_MARKER), 'a re-run identifies its own draft by the marker');
    assert.equal(result.body, body);
    assert.match(body, new RegExp(`> Assembled from \`${tag}\``));
    assert.match(body, /^What is in it\.$/m);
    for (const asset of result.assets) {
      assert.ok(body.includes(`| \`${asset.name}\` | \`${asset.sha256}\` | ${asset.description} |`), asset.name);
    }
    assert.match(body, /sha256sum -c SHA256SUMS\.txt/);
    assert.ok(body.includes(`# ${sha256File(f.bundle)}`), 'the recipe prints the hash it just checked');
    assert.ok(body.includes(`git checkout ${tag}`));
    assert.match(body, /This release is \*\*unsigned\*\*/);
    assert.ok(!body.includes('### The signature'));

    assert.equal(readFileSync(f.titlePath, 'utf8'), `${tag} — a test release\n`);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('two assemblies of one tree are byte-identical', () => {
  const first = fixture();
  const second = fixture();
  try {
    const one = assemble(first);
    const two = assemble(second);
    assert.equal(one.body, two.body);
    assert.equal(
      readFileSync(path.join(first.assetsDir, 'SHA256SUMS.txt'), 'utf8'),
      readFileSync(path.join(second.assetsDir, 'SHA256SUMS.txt'), 'utf8'),
    );
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
    rmSync(second.dir, { recursive: true, force: true });
  }
});

test('assembly refuses to run without a bundle, a sidecar or a tarball', () => {
  const noBundle = fixture();
  try {
    rmSync(noBundle.bundle);
    assert.throws(() => assemble(noBundle), /no bundle at .* run `npm run mcpb` first/);
  } finally {
    rmSync(noBundle.dir, { recursive: true, force: true });
  }

  const noSidecar = fixture({ sidecar: false });
  try {
    assert.throws(() => assemble(noSidecar), /no sidecar at .* run `npm run mcpb` first/);
  } finally {
    rmSync(noSidecar.dir, { recursive: true, force: true });
  }

  const noTarball = fixture();
  try {
    rmSync(noTarball.tarball);
    assert.throws(() => assemble(noTarball), /no tarball at .* run `npm pack` first/);
  } finally {
    rmSync(noTarball.dir, { recursive: true, force: true });
  }
});

test('the asset directory is emptied, so nothing from an earlier run can ship', () => {
  const f = fixture();
  try {
    mkdirSync(f.assetsDir, { recursive: true });
    writeFileSync(path.join(f.assetsDir, 'left-over.mcpb'), Buffer.from('from a previous release\n'));
    const result = assemble(f);
    assert.ok(!result.assets.some((asset) => asset.name === 'left-over.mcpb'));
    assert.ok(!readFileSync(path.join(f.assetsDir, 'SHA256SUMS.txt'), 'utf8').includes('left-over.mcpb'));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('assembly refuses to empty something that looks like a checkout', () => {
  const f = fixture();
  try {
    mkdirSync(f.assetsDir, { recursive: true });
    writeFileSync(path.join(f.assetsDir, 'package.json'), '{}');
    assert.throws(() => assemble(f), /looks like a checkout/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('every asset gets a description, and an unknown one still gets a row', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'assemble-assets-test-'));
  try {
    writeFileSync(path.join(dir, bundleName), 'b');
    writeFileSync(path.join(dir, 'SHA256SUMS.txt'), '');
    writeFileSync(path.join(dir, 'surprise.bin'), 'b');
    const assets = collectAssets(dir, { name: pkg.name, version });
    assert.deepEqual(assets.map((asset) => asset.name), [bundleName, 'surprise.bin']);
    assert.match(assets[0].description, /rebuilds these exact bytes/);
    assert.equal(assets[1].description, 'an asset of this release');
    assert.equal(assets[0].bytes, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a signed release states the signer, the fingerprint and the certificate', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'assemble-signed-test-'));
  const assets = collectAssets(stageSignedFixture(dir), { name: pkg.name, version });
  const signer = {
    subject: 'CN=playwright-e2e-mcp, O=trajectiq-ai, C=US',
    fingerprint: 'AB:CD',
    signedName: `${pkg.name}-${version}.signed.mcpb`,
    contentHash: 'x',
    certName: `${pkg.name}-signing-cert.pem`,
  };
  const body = releaseBody({
    tag,
    notes: { title: 't', body: 'prose' },
    assets,
    signer,
    commits: { previousTag: 'v0.0.1', total: 2, entries: ['abc1234 Fix the thing', 'def5678 Add the other thing'] },
    pkg,
  });
  assert.ok(!body.includes('unsigned'));
  assert.match(body, /### The signature/);
  assert.match(body, /\*\*Signer:\*\* `CN=playwright-e2e-mcp, O=trajectiq-ai, C=US`/);
  assert.match(body, /\*\*SHA-256 fingerprint:\*\* `AB:CD`/);
  assert.match(body, /published as `playwright-e2e-mcp-signing-cert\.pem`/);
  assert.match(body, /### Commits/);
  assert.match(body, /<summary>2 commits from v0\.0\.1 to v[\d.]+<\/summary>/);
  assert.match(body, /- `abc1234` Fix the thing/);
  rmSync(dir, { recursive: true, force: true });
});

function stageSignedFixture(dir) {
  for (const name of [bundleName, `${pkg.name}-${version}.signed.mcpb`, `${pkg.name}-signing-cert.pem`]) {
    writeFileSync(path.join(dir, name), name);
  }
  return dir;
}

test('the commit list is derived from git, and caps out loudly', () => {
  const seen = commitsSince({ tag, cwd: repoRoot, limit: 1 });
  assert.ok(seen.previousTag === null || /^v\d/.test(seen.previousTag));
  const commit = commitsSince({ tag, cwd: repoRoot, limit: 200 });
  assert.equal(commit.entries.length, Math.min(200, commit.total));
  if (commit.total > 0) assert.match(commit.entries[0], /^[0-9a-f]{7,} \S/);
  assert.deepEqual(commitsSince({ tag: 'v0.0.0-not-real', cwd: repoRoot }), {
    previousTag: null,
    total: 0,
    entries: [],
  });
});

test('the clone URL in the recipe comes from package.json, not from memory', () => {
  assert.equal(repositoryUrl(pkg), 'https://github.com/trajectiq-ai/E2E');
  assert.equal(repositoryUrl({ repository: 'https://example.com/x.git' }), 'https://example.com/x');
  assert.equal(repositoryUrl({}), null);
});
