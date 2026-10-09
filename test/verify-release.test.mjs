import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZip } from '../scripts/zip-writer.mjs';
import { hashesMatch, parseChecksums, verifyRelease } from '../scripts/verify-release.mjs';

const pkg = { name: 'fake-mcp', version: '9.9.9' };

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** A minimal but real bundle: a zip with a manifest at its root. */
function writeBundle(dir, name, { version = pkg.version } = {}) {
  const manifest = {
    manifest_version: '0.4',
    name: pkg.name,
    display_name: 'Fake',
    version,
    description: 'synthetic bundle for the release-verification tests',
    author: { name: 'trajectiq-ai' },
    server: { type: 'node', entry_point: 'dist/index.js', mcp_config: {} },
  };
  const file = path.join(dir, name);
  writeFileSync(
    file,
    createZip(
      [
        { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
        { name: 'package.json', data: Buffer.from(JSON.stringify({ name: pkg.name, version }, null, 2)) },
        { name: 'dist/index.js', data: Buffer.from('console.log("fake");\n') },
      ],
      { epoch: 1_577_836_800 },
    ),
  );
  return file;
}

function sumsLine(hash, name) {
  return `${hash} *${name}`;
}

/**
 * Build a release directory shaped like the real one, plus a separate
 * "rebuilt from the tag" bundle to compare it against.
 */
function fixture({ tamperBundle = false, sumsHash = null, omitTgzFromSums = false, signed = null } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verify-release-test-'));
  const release = path.join(root, 'release');
  const local = path.join(root, 'local');
  mkdirSync(release, { recursive: true });
  mkdirSync(local, { recursive: true });
  const bundleName = `${pkg.name}-${pkg.version}.mcpb`;
  const tgzName = `${pkg.name}-${pkg.version}.tgz`;
  const published = writeBundle(release, bundleName);
  writeFileSync(path.join(release, tgzName), Buffer.from('tarball bytes'));
  if (signed) writeFileSync(path.join(release, `${pkg.name}-${pkg.version}.signed.mcpb`), signed);

  const rebuilt = writeBundle(local, bundleName);

  const lines = [
    sumsLine(sumsHash ?? sha256(published), bundleName),
    ...(omitTgzFromSums ? [] : [sumsLine(sha256(path.join(release, tgzName)), tgzName)]),
  ];
  writeFileSync(path.join(release, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`);
  writeFileSync(`${published}.sha256`, `${sha256(published)}  ${bundleName}\n`);

  // Tamper last: this is a published file swapped after its checksums were
  // written, so every check that can catch it must.
  if (tamperBundle) writeFileSync(published, Buffer.concat([readFileSync(published), Buffer.from('tampered')]));

  return { root, release, local, rebuilt, bundleName, tgzName, published };
}

function run(input) {
  return verifyRelease({ tag: `v${pkg.version}`, pkg, ...input });
}

function failedChecks(result) {
  return result.checks.filter((check) => !check.ok).map((check) => check.name);
}

test('parseChecksums reads both sha256sum separator forms and skips comments', () => {
  const text = [
    '# a comment',
    '',
    'a'.repeat(64) + '  two-space.txt',
    'b'.repeat(64) + ' *starred.bin',
    'c'.repeat(64) + ' single-space.txt',
    'not a checksum line',
    'd'.repeat(63) + '  too-short.txt',
  ].join('\n');

  assert.deepEqual(parseChecksums(text), [
    { hash: 'a'.repeat(64), name: 'two-space.txt' },
    { hash: 'b'.repeat(64), name: 'starred.bin' },
    { hash: 'c'.repeat(64), name: 'single-space.txt' },
  ]);
});

test('hashesMatch only accepts equal hex digests', () => {
  assert.equal(hashesMatch('ab', 'ab'), true);
  assert.equal(hashesMatch('ab', 'ac'), false);
  assert.equal(hashesMatch('ab', 'abc'), false);
  assert.equal(hashesMatch(undefined, 'ab'), false);
});

test('a consistent release passes every check', () => {
  const f = fixture();
  try {
    const result = run({ dir: f.release, localBundle: f.rebuilt });
    assert.deepEqual(failedChecks(result), []);
    assert.ok(result.checks.length >= 6, 'expected the full check list');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('the reported details name the published and rebuilt hashes', () => {
  const f = fixture();
  try {
    const result = run({ dir: f.release, localBundle: f.rebuilt });
    const identity = result.checks.find((c) => c.name.includes('byte-identical'));
    assert.ok(identity?.ok);
    assert.match(identity.detail, /published [0-9a-f]{64}/);
    assert.match(identity.detail, /rebuilt  [0-9a-f]{64}/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a published bundle that differs from the rebuild fails', () => {
  const f = fixture({ tamperBundle: true });
  try {
    const failed = failedChecks(run({ dir: f.release, localBundle: f.rebuilt }));
    assert.ok(failed.some((name) => name.includes('byte-identical')), failed.join(' | '));
    assert.ok(failed.some((name) => name.includes('sidecar agrees')), failed.join(' | '));
    assert.ok(failed.some((name) => name.includes('matches every file it names')), failed.join(' | '));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a checksum line that does not match its file fails', () => {
  const f = fixture({ sumsHash: 'e'.repeat(64) });
  try {
    const failed = failedChecks(run({ dir: f.release, localBundle: f.rebuilt }));
    assert.ok(failed.some((name) => name.includes('matches every file it names')), failed.join(' | '));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('an artifact missing from SHA256SUMS.txt fails the coverage check', () => {
  const f = fixture({ omitTgzFromSums: true });
  try {
    const result = run({ dir: f.release, localBundle: f.rebuilt });
    const coverage = result.checks.find((check) => check.name.includes('covers every published'));
    assert.equal(coverage?.ok, false);
    assert.match(coverage.detail, /tarball|\.tgz/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a tag that disagrees with package.json fails', () => {
  const f = fixture();
  try {
    const result = verifyRelease({ tag: 'v1.2.3', pkg, dir: f.release, localBundle: f.rebuilt });
    const tagCheck = result.checks.find((check) => check.name.includes('matches package.json'));
    assert.equal(tagCheck?.ok, false);
    assert.equal(tagCheck.detail, `package.json says ${pkg.version}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a bundle whose manifest is a different version fails', () => {
  const f = fixture();
  try {
    // Replace the published bundle with one built for another version; the
    // byte-identity check catches it, but the manifest check must too.
    writeBundle(f.release, f.bundleName, { version: '0.0.1' });
    const result = run({ dir: f.release, localBundle: f.rebuilt });
    const manifestCheck = result.checks.find((check) => check.name.includes('extracts with this version'));
    assert.equal(manifestCheck?.ok, false);
    assert.match(manifestCheck.detail, /0\.0\.1/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a "signed" bundle whose block does not strip back to the rebuild fails', () => {
  const f = fixture();
  try {
    // Appending bytes is not the same as signing: the signature block has a
    // binary structure, so `unsign` cannot return the original bundle here.
    writeFileSync(
      path.join(f.release, `${pkg.name}-${pkg.version}.signed.mcpb`),
      Buffer.concat([readFileSync(f.published), Buffer.from('\nMCPB_SIG_V1 not a real block MCPB_SIG_END\n')]),
    );
    const failed = failedChecks(run({ dir: f.release, localBundle: f.rebuilt }));
    assert.ok(failed.some((name) => name.includes('unsigns back')), failed.join(' | '));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a missing signed bundle is not treated as a failure', () => {
  const f = fixture();
  try {
    const result = run({ dir: f.release, localBundle: f.rebuilt });
    assert.equal(
      result.checks.some((check) => check.name.includes('unsigns back')),
      false,
      'the signed-bundle check should only run when one is published',
    );
    assert.deepEqual(failedChecks(result), []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
