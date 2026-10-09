/**
 * Minimal, deterministic ZIP writer.
 *
 * The bundle has to hash the same every time it is built, which the platform
 * `zip`/`bsdtar` tools do not give us: `bsdtar` (the Windows path) picks its
 * own entry order, so two builds of an identical tree produced two different
 * archives. This writer is pure Node, so the same tree produces the same
 * bytes on every platform and every run:
 *
 *   - entries are written in sorted name order,
 *   - no extra fields, no data descriptors, no directory entries,
 *   - every entry gets the same fixed DOS timestamp (UTC, so the timezone
 *     of the machine doing the build cannot leak into the archive),
 *   - `version made by` and external attributes are fixed rather than taken
 *     from the host filesystem,
 *   - compression is `deflateRawSync` at a fixed level.
 *
 * `SOURCE_DATE_EPOCH` (default 2020-01-01) sets the fixed timestamp, matching
 * the convention used by reproducible-builds tooling.
 */

import { deflateRawSync } from 'node:zlib';

export const DEFAULT_EPOCH = 1_577_836_800; // 2020-01-01T00:00:00Z

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3), as ZIP requires. */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * DOS date/time pair. UTC components are used deliberately: a ZIP stores a
 * naive local timestamp, so using the machine's local time would make the
 * archive depend on the builder's timezone.
 */
function dosDateTime(epochSeconds) {
  const when = new Date(epochSeconds * 1000);
  const year = Math.max(1980, when.getUTCFullYear());
  const time = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const date = ((year - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  return { time, date };
}

/**
 * Build a ZIP archive from `[{ name, data }]`.
 *
 * `name` must use `/` separators and must not start with `./` (the DXT loader
 * in Claude Desktop rejects those). Names are sorted internally, so callers
 * cannot make the output order-dependent.
 *
 * @returns {Buffer}
 */
export function createZip(entries, { epoch = DEFAULT_EPOCH, level = 9 } = {}) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const names = new Set();
  for (const entry of sorted) {
    if (!entry.name || entry.name.startsWith('/') || entry.name.startsWith('./')) {
      throw new Error(`zip: entry name must be relative and clean: ${JSON.stringify(entry.name)}`);
    }
    if (names.has(entry.name)) throw new Error(`zip: duplicate entry name: ${entry.name}`);
    names.add(entry.name);
  }

  const { time, date } = dosDateTime(epoch);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const crc = crc32(raw);
    const deflated = deflateRawSync(raw, { level });
    // Storing is only worth it when deflate does not pay for itself.
    const stored = deflated.length >= raw.length;
    const method = stored ? 0 : 8;
    const body = stored ? raw : deflated;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed to extract (2.0)
    local.writeUInt16LE(0, 6); // flags: no descriptor, no UTF-8 name
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by — fixed, not from the host
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra field length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes — fixed
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, end]);
}
