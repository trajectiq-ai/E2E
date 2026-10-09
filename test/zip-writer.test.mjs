import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createZip, crc32 } from '../scripts/zip-writer.mjs';
import { extractMcpb } from '../scripts/extract-mcpb.mjs';

const entries = [
  { name: 'manifest.json', data: Buffer.from('{"manifest_version":"0.4"}') },
  { name: 'dist/index.js', data: Buffer.from('console.log("hi");\n') },
  { name: 'package.json', data: Buffer.from('{"name":"x"}') },
];

test('crc32 matches the known IEEE vector for "123456789"', () => {
  // The classic check value every CRC-32 implementation is tested against.
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the same entries always produce the same archive', () => {
  assert.deepEqual(createZip(entries), createZip(entries));
});

test('entry order in the input cannot change the archive', () => {
  const shuffled = [entries[2], entries[0], entries[1]];
  assert.deepEqual(createZip(entries), createZip(shuffled));
});

test('a different fixed timestamp produces a different archive', () => {
  const a = createZip(entries, { epoch: 1_577_836_800 });
  const b = createZip(entries, { epoch: 1_600_000_000 });
  assert.notDeepEqual(a, b);
  assert.equal(a.length, b.length, 'only the timestamp field should differ');
});

test('entry names are validated', () => {
  assert.throws(() => createZip([{ name: 'a', data: Buffer.from('') }, { name: 'a', data: Buffer.from('') }]), /duplicate entry name/);
  assert.throws(() => createZip([{ name: '/abs', data: Buffer.from('') }]), /relative and clean/);
  assert.throws(() => createZip([{ name: './rel', data: Buffer.from('') }]), /relative and clean/);
});

test('the archive round-trips through the bundle extractor', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zip-writer-test-'));
  const archive = path.join(dir, 'bundle.mcpb');
  const out = path.join(dir, 'out');
  try {
    writeFileSync(archive, createZip(entries));
    extractMcpb(archive, out);
    for (const entry of entries) {
      assert.deepEqual(
        readFileSync(path.join(out, entry.name)),
        entry.data,
        `${entry.name} survived the round trip`,
      );
    }
    // manifest.json has to sit at the root: extraction masks a bad prefix.
    assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')), {
      manifest_version: '0.4',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
