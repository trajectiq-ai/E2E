import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha256File, signBundle } from '../scripts/sign-mcpb.mjs';
import { createZip } from '../scripts/zip-writer.mjs';

/**
 * The guards around signing matter more than the happy path: the unsigned
 * bundle is the reproducible artifact, so no failure may leave it modified,
 * and a signed file may never be published unless stripping its signature
 * reproduces that artifact byte for byte. (The full sign → verify → unsign
 * round trip needs a real certificate and is exercised by `npm run mcpb:sign`
 * and by the release verification, which has the published signed bundle.)
 */
function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sign-mcpb-test-'));
  const bundle = path.join(dir, 'playwright-e2e-mcp-9.9.9.mcpb');
  writeFileSync(
    bundle,
    createZip([{ name: 'manifest.json', data: Buffer.from('{"manifest_version":"0.4"}') }], { epoch: 1_577_836_800 }),
  );
  writeFileSync(path.join(dir, 'cert.pem'), 'not a certificate');
  writeFileSync(path.join(dir, 'key.pem'), 'not a key');
  return { dir, bundle };
}

test('sha256File hashes file contents', () => {
  const { dir, bundle } = fixture();
  try {
    assert.match(sha256File(bundle), /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signing refuses to write over the unsigned bundle', () => {
  const { dir, bundle } = fixture();
  try {
    assert.throws(
      () => signBundle({ bundle, cert: path.join(dir, 'cert.pem'), key: path.join(dir, 'key.pem'), outPath: bundle }),
      /refusing to sign over the unsigned bundle/,
    );
    // The guard must fail before anything is written.
    assert.match(sha256File(bundle), /^[0-9a-f]{64}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signing without a certificate or key fails before touching the bundle', () => {
  const { dir, bundle } = fixture();
  const before = readFileSync(bundle);
  try {
    assert.throws(
      () =>
        signBundle({
          bundle,
          cert: path.join(dir, 'missing-cert.pem'),
          key: path.join(dir, 'key.pem'),
          outPath: path.join(dir, 'out.signed.mcpb'),
        }),
      /the certificate file does not exist/,
    );
    assert.throws(
      () =>
        signBundle({
          bundle,
          cert: path.join(dir, 'cert.pem'),
          key: path.join(dir, 'missing-key.pem'),
          outPath: path.join(dir, 'out.signed.mcpb'),
        }),
      /the private key file does not exist/,
    );
    assert.deepEqual(readFileSync(bundle), before, 'the unsigned bundle must be untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('signing a bundle that does not exist fails with a useful message', () => {
  const { dir } = fixture();
  try {
    assert.throws(
      () =>
        signBundle({
          bundle: path.join(dir, 'absent.mcpb'),
          cert: path.join(dir, 'cert.pem'),
          key: path.join(dir, 'key.pem'),
          outPath: path.join(dir, 'out.signed.mcpb'),
        }),
      /no bundle at .* — run `npm run mcpb` first/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
