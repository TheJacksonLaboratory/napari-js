import { afterEach, beforeEach, expect, it } from 'vitest';

import type { PixelChunk, TileKey, TiledSource, Viewer } from '../../src';
import { describeGpu, disposeViewer, makeViewer, meanRgb } from './harness';

/**
 * A 128² image in 32 px tiles, three levels: level 0 is 4×4 tiles, level 1 2×2, level 2 one.
 * Level 2 reads 40 everywhere; each level-1 tile 120 in its left half and 220 in its right, so
 * a fallback drawn from the wrong part of the tile shows; level 0 never arrives.
 */
function source(signals: AbortSignal[]): TiledSource {
  const tile = (value: (x: number) => number): PixelChunk => {
    const data = new Uint8Array(32 * 32);
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) data[x + 32 * y] = value(x);
    return { width: 32, height: 32, data };
  };
  return {
    kind: 'tiled',
    width: 128,
    height: 128,
    tileSize: 32,
    levels: 3,
    depth: 1,
    channels: 1,
    dtype: 'uint8',
    fetchTile: (key: TileKey, signal?: AbortSignal) => {
      if (key.level === 2) return Promise.resolve(tile(() => 40));
      if (key.level === 1) return Promise.resolve(tile((x) => (x < 16 ? 120 : 220)));
      if (signal) signals.push(signal);
      return new Promise<PixelChunk>(() => {});
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describeGpu('tiled image while tiles load', () => {
  let viewer: Viewer;
  let signals: AbortSignal[];
  beforeEach(async () => {
    viewer = await makeViewer();
    signals = [];
  });
  afterEach(() => disposeViewer(viewer));

  /** Load levels 1 and 2 zoomed out, then zoom in to level 0, which never arrives. */
  async function zoomIn(blending: 'translucent' | 'additive') {
    viewer.addImage(source(signals), {
      blending,
      contrastLimits: [0, 255],
      interpolation: 'nearest',
    });
    // The 64 px canvas over all 128 units: level 1.
    viewer.camera.set([64, 64], 0.5);
    await viewer.readDisplayedPixels();
    await settle();
    // Over units 0–64 at 1:1: level 0, which is still loading.
    viewer.camera.set([32, 32], 1);
    await viewer.readDisplayedPixels();
    await settle();
    return viewer.readDisplayedPixels();
  }

  for (const blending of ['translucent', 'additive'] as const) {
    it(`${blending}: shows the loaded level-1 tile, the right part of it, while level 0 loads`, async () => {
      const px = await zoomIn(blending);
      // Level-1 tile (0, 0) spans units 0–64; its left half (units 0–32) reads 120.
      expect(meanRgb(px, 4, 4, 24, 56)[0]).toBeCloseTo(120, -1);
      expect(meanRgb(px, 36, 4, 24, 56)[0]).toBeCloseTo(220, -1);
    });
  }

  it('aborts the fetches of a level the view has left', async () => {
    await zoomIn('translucent');
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => !s.aborted)).toBe(true);

    viewer.camera.set([64, 64], 0.25);
    await viewer.readDisplayedPixels();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});
