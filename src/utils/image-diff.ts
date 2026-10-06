/**
 * Visual regression core: PNG decode/encode and a pixel diff.
 *
 * Playwright screenshots are 8-bit non-interlaced PNGs, so a small
 * built-in codec covers them without adding dependencies. The diff
 * reports how much changed, *where* it changed (merged grid regions),
 * and the average color shift — powering the "you changed the button
 * from blue to red" message from the blueprint.
 */

import { deflateSync, inflateSync } from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA8, row-major, length = width * height * 4. */
  data: Uint8Array;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/* ------------------------------------------------------------------ */
/* CRC32 + PNG chunks                                                  */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/* ------------------------------------------------------------------ */
/* Decode                                                              */
/* ------------------------------------------------------------------ */

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Decode an 8-bit, non-interlaced PNG (gray/RGB/palette/alpha variants). */
export function decodePng(buf: Buffer): RgbaImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file (bad signature)');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;

  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (offset + 12 + length > buf.length) break;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (width <= 0 || height <= 0) throw new Error('PNG is missing a valid IHDR chunk');
  if (width * height > 100_000_000) throw new Error(`PNG is too large (${width}×${height})`);
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth} (only 8 supported)`);
  if (interlace !== 0) throw new Error('Interlaced PNGs are not supported');
  if (colorType === 3 && !palette) throw new Error('Palette PNG is missing its PLTE chunk');

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * channels;
  // Bound the output by what the header says the image needs (zip-bomb guard).
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: height * (stride + 1) + 1024 });
  if (raw.length < height * (stride + 1)) throw new Error('PNG data is truncated');

  // Unfilter scanlines.
  const pixels = new Uint8Array(height * stride);
  let pos = 0;
  let prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i += 1) {
      const x = raw[pos + i];
      const a = i >= channels ? row[i - channels] : 0;
      const b = prevRow[i];
      const c = i >= channels ? prevRow[i - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`Unsupported PNG filter type ${filter}`);
      }
      row[i] = value & 0xff;
    }
    pos += stride;
    pixels.set(row, y * stride);
    prevRow = row;
  }

  // Expand to RGBA.
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const src = i * channels;
    const dst = i * 4;
    if (colorType === 6) {
      out[dst] = pixels[src];
      out[dst + 1] = pixels[src + 1];
      out[dst + 2] = pixels[src + 2];
      out[dst + 3] = pixels[src + 3];
    } else if (colorType === 2) {
      out[dst] = pixels[src];
      out[dst + 1] = pixels[src + 1];
      out[dst + 2] = pixels[src + 2];
      out[dst + 3] = 255;
    } else if (colorType === 0) {
      out[dst] = out[dst + 1] = out[dst + 2] = pixels[src];
      out[dst + 3] = 255;
    } else if (colorType === 4) {
      out[dst] = out[dst + 1] = out[dst + 2] = pixels[src];
      out[dst + 3] = pixels[src + 1];
    } else {
      const index = pixels[src];
      out[dst] = palette![index * 3];
      out[dst + 1] = palette![index * 3 + 1];
      out[dst + 2] = palette![index * 3 + 2];
      out[dst + 3] = 255;
    }
  }

  return { width, height, data: out };
}

/* ------------------------------------------------------------------ */
/* Encode                                                              */
/* ------------------------------------------------------------------ */

/** Encode an RGBA image as a PNG (filter 0, default compression). */
export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter: None
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

export interface DiffOptions {
  /** Per-pixel combined channel delta (0–765) above which a pixel differs. Default 60. */
  pixelThreshold?: number;
  /** Grid cell size used to cluster changed pixels into regions. Default 24. */
  cellSize?: number;
  /** Fraction of a cell that must differ before the cell counts. Default 0.05. */
  cellRatio?: number;
}

export interface DiffRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: number;
}

export interface DiffResult {
  width: number;
  height: number;
  totalPixels: number;
  diffPixels: number;
  /** Percentage of changed pixels (0–100). */
  percent: number;
  /** True when the two screenshots have different dimensions. */
  dimensionsChanged: boolean;
  /** Changed areas, largest first (top 5). */
  regions: DiffRegion[];
  /** Average color of changed pixels, before → after. */
  beforeAvg?: Rgb;
  afterAvg?: Rgb;
  /** Annotated image: grayscale baseline, changed pixels in red. */
  diffImage: RgbaImage;
}

function averageColor(
  before: RgbaImage,
  after: RgbaImage,
  changed: Uint8Array,
): { before: Rgb; after: Rgb } {
  let br = 0;
  let bg = 0;
  let bb = 0;
  let ar = 0;
  let ag = 0;
  let ab = 0;
  let n = 0;
  for (let p = 0; p < changed.length; p += 1) {
    if (!changed[p]) continue;
    const i = p * 4;
    br += before.data[i];
    bg += before.data[i + 1];
    bb += before.data[i + 2];
    ar += after.data[i];
    ag += after.data[i + 1];
    ab += after.data[i + 2];
    n += 1;
  }
  if (n === 0) return { before: { r: 0, g: 0, b: 0 }, after: { r: 0, g: 0, b: 0 } };
  return {
    before: { r: Math.round(br / n), g: Math.round(bg / n), b: Math.round(bb / n) },
    after: { r: Math.round(ar / n), g: Math.round(ag / n), b: Math.round(ab / n) },
  };
}

/**
 * Compare two screenshots. When dimensions differ, the overlapping
 * region is compared and the remainder counts as changed.
 */
export function diffImages(before: RgbaImage, after: RgbaImage, options: DiffOptions = {}): DiffResult {
  const pixelThreshold = options.pixelThreshold ?? 60;
  const cellSize = options.cellSize ?? 24;
  const cellRatio = options.cellRatio ?? 0.05;

  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const totalPixels = width * height;
  const dimensionsChanged = before.width !== after.width || before.height !== after.height;

  const compareWidth = Math.min(before.width, after.width);
  const compareHeight = Math.min(before.height, after.height);

  const changed = new Uint8Array(totalPixels);
  let diffPixels = 0;

  for (let y = 0; y < compareHeight; y += 1) {
    for (let x = 0; x < compareWidth; x += 1) {
      const bi = (y * before.width + x) * 4;
      const ai = (y * after.width + x) * 4;
      const delta =
        Math.abs(before.data[bi] - after.data[ai]) +
        Math.abs(before.data[bi + 1] - after.data[ai + 1]) +
        Math.abs(before.data[bi + 2] - after.data[ai + 2]) +
        Math.abs(before.data[bi + 3] - after.data[ai + 3]);
      if (delta > pixelThreshold) {
        changed[y * width + x] = 1;
        diffPixels += 1;
      }
    }
  }
  // Pixels outside the overlap always count as changed.
  const overlap = compareWidth * compareHeight;
  const outside = totalPixels - overlap;
  if (outside > 0) {
    diffPixels += outside;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (x >= compareWidth || y >= compareHeight) changed[y * width + x] = 1;
      }
    }
  }

  // Cluster changed pixels into grid cells, then merge adjacent cells.
  const cols = Math.ceil(width / cellSize);
  const rows = Math.ceil(height / cellSize);
  const cellPixels = cellSize * cellSize;
  const active = new Uint8Array(cols * rows);
  // A cell counts when at least cellRatio of it changed (small cells: ≥2 px).
  const cellCount = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (changed[y * width + x]) cellCount[Math.floor(y / cellSize) * cols + Math.floor(x / cellSize)] += 1;
    }
  }
  for (let i = 0; i < active.length; i += 1) {
    const needed = Math.max(2, Math.ceil(cellPixels * cellRatio));
    active[i] = cellCount[i] >= needed ? 1 : 0;
  }

  const regions: DiffRegion[] = [];
  const visited = new Uint8Array(cols * rows);
  for (let cell = 0; cell < active.length; cell += 1) {
    if (!active[cell] || visited[cell]) continue;
    // BFS over adjacent active cells.
    const queue = [cell];
    visited[cell] = 1;
    let minX = cols;
    let minY = rows;
    let maxX = 0;
    let maxY = 0;
    let pixels = 0;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      const cx = current % cols;
      const cy = Math.floor(current / cols);
      minX = Math.min(minX, cx);
      minY = Math.min(minY, cy);
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
      pixels += cellCount[current];
      const neighbors = [
        cx > 0 ? current - 1 : -1,
        cx < cols - 1 ? current + 1 : -1,
        cy > 0 ? current - cols : -1,
        cy < rows - 1 ? current + cols : -1,
      ];
      for (const next of neighbors) {
        if (next >= 0 && active[next] && !visited[next]) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    regions.push({
      x: minX * cellSize,
      y: minY * cellSize,
      width: Math.min(width, (maxX + 1) * cellSize) - minX * cellSize,
      height: Math.min(height, (maxY + 1) * cellSize) - minY * cellSize,
      pixels,
    });
  }
  regions.sort((a, b) => b.pixels - a.pixels);

  const avgs = averageColor(before, after, changed);

  // Annotated diff image: dimmed baseline, changed pixels in red.
  const diffImage: RgbaImage = { width, height, data: new Uint8Array(width * height * 4) };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const out = p * 4;
      if (changed[p]) {
        diffImage.data[out] = 255;
        diffImage.data[out + 1] = 40;
        diffImage.data[out + 2] = 40;
        diffImage.data[out + 3] = 255;
      } else {
        const bi = y < before.height && x < before.width ? (y * before.width + x) * 4 : -1;
        const gray =
          bi >= 0
            ? Math.round(
                before.data[bi] * 0.299 + before.data[bi + 1] * 0.587 + before.data[bi + 2] * 0.114,
              )
            : 255;
        diffImage.data[out] = gray;
        diffImage.data[out + 1] = gray;
        diffImage.data[out + 2] = gray;
        diffImage.data[out + 3] = 255;
      }
    }
  }

  return {
    width,
    height,
    totalPixels,
    diffPixels,
    percent: totalPixels === 0 ? 0 : Math.round((diffPixels / totalPixels) * 10_000) / 100,
    dimensionsChanged,
    regions: regions.slice(0, 5),
    beforeAvg: diffPixels > 0 ? avgs.before : undefined,
    afterAvg: diffPixels > 0 ? avgs.after : undefined,
    diffImage,
  };
}
