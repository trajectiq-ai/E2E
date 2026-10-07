import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractMcpb } from '../scripts/extract-mcpb.mjs';

/* ---- minimal ZIP writer (store or deflate) for fixtures ---- */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data ?? '');
    const body = entry.deflate ? deflateRawSync(data) : data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

async function inTemp(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpb-extract-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('extractMcpb writes stored and deflated entries, creating directories', async () => {
  await inTemp(async (dir) => {
    const zipPath = path.join(dir, 'bundle.mcpb');
    await writeFile(
      zipPath,
      buildZip([
        { name: 'manifest.json', data: Buffer.from('{"name":"x"}'), deflate: false },
        { name: 'dist/', data: Buffer.alloc(0), deflate: false },
        { name: 'dist/index.js', data: Buffer.from('console.log(1)'), deflate: true },
        { name: 'node_modules/zod/package.json', data: Buffer.from('x'.repeat(4000)), deflate: true },
      ]),
    );

    const dest = path.join(dir, 'out');
    const roots = extractMcpb(zipPath, dest);

    assert.equal(await readFile(path.join(dest, 'manifest.json'), 'utf8'), '{"name":"x"}');
    assert.equal(await readFile(path.join(dest, 'dist/index.js'), 'utf8'), 'console.log(1)');
    assert.equal((await readFile(path.join(dest, 'node_modules/zod/package.json'))).length, 4000);
    // Directory entries are not reported as archived roots.
    assert.deepEqual(roots.sort(), ['manifest.json']);
  });
});

test('extractMcpb refuses an archive entry that escapes the destination', async () => {
  await inTemp(async (dir) => {
    const zipPath = path.join(dir, 'evil.mcpb');
    await writeFile(zipPath, buildZip([{ name: '../escaped.txt', data: Buffer.from('pwned'), deflate: false }]));

    const dest = path.join(dir, 'out');
    assert.throws(() => extractMcpb(zipPath, dest), /path traversal/);
    assert.equal(existsSync(path.join(dir, 'escaped.txt')), false, 'nothing written outside dest');
  });
});

test('extractMcpb rejects input that is not a zip archive', async () => {
  await inTemp(async (dir) => {
    const zipPath = path.join(dir, 'not-a-zip.mcpb');
    await writeFile(zipPath, Buffer.from('definitely not a zip archive'));
    assert.throws(() => extractMcpb(zipPath, path.join(dir, 'out')), /not a zip archive/);
  });
});
