import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, encodePng, diffImages } from '../dist/utils/image-diff.js';

function solidImage(width, height, rgba) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = rgba[0];
    data[i * 4 + 1] = rgba[1];
    data[i * 4 + 2] = rgba[2];
    data[i * 4 + 3] = rgba[3];
  }
  return { width, height, data };
}

function fillRect(image, x0, y0, w, h, rgba) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const i = (y * image.width + x) * 4;
      image.data[i] = rgba[0];
      image.data[i + 1] = rgba[1];
      image.data[i + 2] = rgba[2];
      image.data[i + 3] = rgba[3];
    }
  }
}

function pixelAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.data[i + 3]];
}

test('encodePng/decodePng round-trips an RGBA image', () => {
  const image = solidImage(40, 30, [10, 20, 30, 255]);
  fillRect(image, 5, 5, 10, 10, [200, 0, 0, 255]);

  const decoded = decodePng(encodePng(image));
  assert.equal(decoded.width, 40);
  assert.equal(decoded.height, 30);
  assert.deepEqual(pixelAt(decoded, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(pixelAt(decoded, 6, 6), [200, 0, 0, 255]);
  assert.deepEqual(pixelAt(decoded, 6, 6), pixelAt(image, 6, 6));
});

test('decodePng rejects non-PNG data with a clear error', () => {
  assert.throws(() => decodePng(Buffer.from('definitely not a png file')), /Not a PNG/);
});

test('diffImages reports zero differences for identical images', () => {
  const image = solidImage(50, 50, [240, 240, 240, 255]);
  const result = diffImages(image, image);
  assert.equal(result.diffPixels, 0);
  assert.equal(result.percent, 0);
  assert.equal(result.dimensionsChanged, false);
  assert.equal(result.regions.length, 0);
  assert.equal(result.beforeAvg, undefined);
});

test('diffImages finds changed pixels, regions and color shift', () => {
  const before = solidImage(100, 80, [255, 255, 255, 255]);
  const after = solidImage(100, 80, [255, 255, 255, 255]);
  // A "blue button" that turns red: 20×10 at (30, 20).
  fillRect(before, 30, 20, 20, 10, [37, 99, 235, 255]);
  fillRect(after, 30, 20, 20, 10, [220, 38, 38, 255]);

  const result = diffImages(before, after);
  assert.equal(result.diffPixels, 200);
  assert.equal(result.percent, 2.5);
  assert.equal(result.width, 100);
  assert.equal(result.height, 80);

  assert.ok(result.regions.length >= 1);
  const region = result.regions[0];
  assert.ok(region.x <= 30 && region.y <= 20, 'region starts at/before the change');
  assert.ok(region.x + region.width >= 47 && region.y + region.height >= 29, 'region covers the change');
  assert.ok(region.pixels >= 100);

  assert.deepEqual(result.beforeAvg, { r: 37, g: 99, b: 235 });
  assert.deepEqual(result.afterAvg, { r: 220, g: 38, b: 38 });

  // The diff image is the same size with red on changed pixels.
  assert.equal(result.diffImage.width, 100);
  assert.deepEqual(pixelAt(result.diffImage, 35, 25), [255, 40, 40, 255]);
  // Unchanged pixels show the dimmed (grayscale) baseline: white → white.
  assert.deepEqual(pixelAt(result.diffImage, 0, 0), [255, 255, 255, 255]);
});

test('diffImages respects the pixel threshold for tiny color noise', () => {
  const before = solidImage(20, 20, [100, 100, 100, 255]);
  const after = solidImage(20, 20, [102, 100, 100, 255]);
  const result = diffImages(before, after, { pixelThreshold: 60 });
  assert.equal(result.diffPixels, 0);
  const sensitive = diffImages(before, after, { pixelThreshold: 1 });
  assert.equal(sensitive.diffPixels, 400);
});

test('diffImages handles dimension changes', () => {
  const before = solidImage(100, 80, [255, 255, 255, 255]);
  const after = solidImage(100, 100, [255, 255, 255, 255]);
  const result = diffImages(before, after);
  assert.equal(result.dimensionsChanged, true);
  // 100×100 − 100×80 = 2000 pixels outside the overlap always differ.
  assert.equal(result.diffPixels, 2000);
  assert.equal(result.percent, 20);
});
