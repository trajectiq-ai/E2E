/**
 * Extract a `.mcpb` bundle with Node's own zlib — no `unzip`, no shell-out —
 * so the launch simulation runs identically on Linux CI, macOS and Windows.
 *
 * The zip central directory is authoritative for entry sizes: an archive
 * written with data descriptors (general-purpose flag bit 3) leaves zeros in
 * the local headers, so each entry is sliced from its central-directory
 * record and only the local header is consulted to find where the payload
 * starts. Entry names are checked against path traversal before any write.
 *
 * Usage: node scripts/extract-mcpb.mjs <bundle.mcpb> <dest-dir>
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EOCD_SIG = 0x06054b50; // end of central directory
const CEN_SIG = 0x02014b50; // central directory file header
const LOCAL_SIG = 0x04034b50; // local file header

/** @param {string} zipPath @param {string} destDir @returns {string[]} archived root entries */
export function extractMcpb(zipPath, destDir) {
  const zip = readFileSync(zipPath);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error(`not a zip archive: ${zipPath}`);

  const entryCount = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const roots = [];

  for (let i = 0; i < entryCount; i += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== CEN_SIG) {
      throw new Error(`corrupt central directory at entry ${i} of ${zipPath}`);
    }
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // directory entry: mkdir below creates it

    // Refuse absolute paths and `..` escapes before touching the filesystem.
    const target = path.resolve(destDir, name);
    const rel = path.relative(path.resolve(destDir), target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`refusing path traversal in archive entry: ${name}`);
    }

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`bad local header for ${name}`);
    }
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    const payload = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!payload) throw new Error(`unsupported compression method ${method} for ${name}`);

    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, payload);
    if (!name.includes('/')) roots.push(name);
  }

  return roots;
}

// CLI form, so CI can unpack a bundle without a shell-specific `unzip`.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , zipPath, destDir] = process.argv;
  if (!zipPath || !destDir) {
    console.error('usage: node scripts/extract-mcpb.mjs <bundle.mcpb> <dest-dir>');
    process.exit(2);
  }
  const roots = extractMcpb(zipPath, destDir);
  console.log(`extracted ${path.basename(zipPath)} -> ${destDir} (${roots.sort().join(', ')})`);
}
