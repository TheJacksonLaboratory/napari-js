import { afterEach, beforeEach, expect, it } from 'vitest';

import { buildLabelLut, mapScalar, resolveColormap, type Viewer } from '../../src';
import {
  SOFTWARE,
  coverage,
  describeGpu,
  disposeViewer,
  makeViewer,
  maxDiff,
  pixel,
} from './harness';

/** Colour tolerance (0..255) against the CPU references: the LUT is sampled, not evaluated. */
const TOL = SOFTWARE ? 4 : 3;

describeGpu('2D layers on the GPU', () => {
  let viewer: Viewer;
  beforeEach(async () => {
    viewer = await makeViewer();
  });
  afterEach(() => disposeViewer(viewer));

  /** An 8×8 image filling the 64×64 canvas: data pixel (i, j) is the block at (8i, 8j). */
  const fill8 = () => viewer.camera.set([4, 4], 8);
  const block = (i: number, j: number) => [8 * i + 4, 8 * j + 4] as const;

  // Value at (x, y): spans 0..252 across the image, so the window clips at both ends.
  const gradient = () => {
    const data = new Uint8Array(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) data[x + 8 * y] = x * 32 + y * 4;
    return data;
  };

  for (const invert of [false, true]) {
    it(`maps an image through window → ${invert ? 'invert → ' : ''}gamma → colormap, as mapScalar does`, async () => {
      const data = gradient();
      viewer.addImage(
        { kind: 'typed', width: 8, height: 8, channels: 1, dtype: 'uint8', data },
        {
          colormap: 'viridis',
          contrastLimits: [32, 224],
          gamma: 0.5,
          invert,
          interpolation: 'nearest',
        },
      );
      fill8();
      const px = await viewer.readDisplayedPixels();
      const colormap = resolveColormap('viridis');
      let worst = 0;
      for (let j = 0; j < 8; j++) {
        for (let i = 0; i < 8; i++) {
          const rgb = mapScalar(data[i + 8 * j], {
            climLo: 32,
            climHi: 224,
            gamma: 0.5,
            invert,
            colormap,
          });
          const [x, y] = block(i, j);
          worst = Math.max(
            worst,
            maxDiff(
              pixel(px, x, y),
              rgb.map((c) => c * 255),
            ),
          );
        }
      }
      expect(worst).toBeLessThanOrEqual(TOL);
    });
  }

  it('windows a float32 image at its own precision', async () => {
    const data = new Float32Array(64);
    for (let k = 0; k < 64; k++) data[k] = (k % 8) * 1000; // 0..7000 across x
    viewer.addImage(
      { kind: 'typed', width: 8, height: 8, channels: 1, dtype: 'float32', data },
      { colormap: 'gray', contrastLimits: [1000, 6000], interpolation: 'nearest' },
    );
    fill8();
    const px = await viewer.readDisplayedPixels();
    for (let i = 0; i < 8; i++) {
      const t = Math.min(1, Math.max(0, (i * 1000 - 1000) / 5000));
      expect(Math.abs(pixel(px, ...block(i, 3))[0] - t * 255)).toBeLessThanOrEqual(TOL);
    }
  });

  it('draws an RGBA image as its colours', async () => {
    const data = new Uint8Array(64 * 4);
    for (let k = 0; k < 64; k++) data.set(k < 32 ? [255, 0, 0, 255] : [0, 0, 255, 255], 4 * k);
    viewer.addImage({ kind: 'typed', width: 8, height: 8, channels: 4, dtype: 'uint8', data });
    fill8();
    const px = await viewer.readDisplayedPixels();
    expect(maxDiff(pixel(px, ...block(3, 1)), [255, 0, 0, 255])).toBeLessThanOrEqual(TOL);
    expect(maxDiff(pixel(px, ...block(3, 6)), [0, 0, 255, 255])).toBeLessThanOrEqual(TOL);
  });

  it('composites a half-opaque layer over the background (premultiplied)', async () => {
    const data = new Uint8Array(64).fill(255);
    viewer.addImage(
      { kind: 'typed', width: 8, height: 8, channels: 1, dtype: 'uint8', data },
      { colormap: 'gray', opacity: 0.5 },
    );
    fill8();
    const [r] = pixel(await viewer.readDisplayedPixels(), 32, 32);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(TOL);
  });

  it('draws a point as a filled disc of its size, centred on it', async () => {
    viewer.addPoints([[32, 32]], { size: 20, faceColor: [1, 0, 0, 1], borderWidth: 0 });
    viewer.camera.set([32, 32], 1);
    const px = await viewer.readDisplayedPixels();
    expect(maxDiff(pixel(px, 32, 32), [255, 0, 0, 255])).toBeLessThanOrEqual(TOL);
    expect(pixel(px, 2, 2).slice(0, 3)).toEqual([0, 0, 0]);
    // π·10² of 64² px.
    expect(coverage(px)).toBeGreaterThan(0.06);
    expect(coverage(px)).toBeLessThan(0.095);
  });

  it('fills a shape, or draws only its outline', async () => {
    const coords = Float32Array.of(16, 16, 48, 16, 48, 48, 16, 48);
    const offsets = Uint32Array.of(0, 4);
    const shapes = viewer.addShapes(coords, offsets, { draw: 'fill', faceColor: [0, 1, 0, 1] });
    viewer.camera.set([32, 32], 1);
    let px = await viewer.readDisplayedPixels();
    expect(maxDiff(pixel(px, 32, 32), [0, 255, 0, 255])).toBeLessThanOrEqual(TOL);
    expect(pixel(px, 4, 4).slice(0, 3)).toEqual([0, 0, 0]);
    expect(Math.abs(coverage(px) - 0.25)).toBeLessThan(0.03);

    shapes.draw = 'outline';
    px = await viewer.readDisplayedPixels();
    expect(pixel(px, 32, 32).slice(0, 3)).toEqual([0, 0, 0]);
    expect(coverage(px)).toBeGreaterThan(0.02);
    expect(coverage(px)).toBeLessThan(0.15);
  });

  it('colours labels from the label LUT, background clear, and shows only the selected one', async () => {
    const data = new Uint8Array(64);
    for (let k = 0; k < 64; k++) data[k] = k % 8 < 4 ? 0 : 3;
    const labels = viewer.addLabels(data, 8, 8, { opacity: 1 });
    fill8();
    let px = await viewer.readDisplayedPixels();
    const lut = buildLabelLut();
    expect(
      maxDiff(pixel(px, ...block(6, 4)), [lut[12], lut[13], lut[14], 255]),
    ).toBeLessThanOrEqual(TOL);
    expect(pixel(px, ...block(1, 4)).slice(0, 3)).toEqual([0, 0, 0]);

    labels.selectedLabel = 5;
    labels.showSelectedOnly = true;
    px = await viewer.readDisplayedPixels();
    expect(pixel(px, ...block(6, 4)).slice(0, 3)).toEqual([0, 0, 0]);
  });
});
