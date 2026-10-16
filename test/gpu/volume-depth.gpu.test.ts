import { afterEach, beforeEach, expect, it } from 'vitest';

import type { Viewer } from '../../src';
import { SIZE, describeGpu, disposeViewer, makeViewer, pixel } from './harness';

const C = SIZE / 2;
const N = 32;

/** A bright slab, voxels z0..z1 (inclusive) of an N³ volume, over the middle of the xy plane. */
function slab(z0: number, z1: number): Uint8Array {
  const data = new Uint8Array(N * N * N);
  for (let z = z0; z <= z1; z++)
    for (let y = 8; y < N - 8; y++) for (let x = 8; x < N - 8; x++) data[x + N * (y + N * z)] = 255;
  return data;
}

/** A red translucent quad across the volume's middle (world z = 0, the volume is centred). */
function addQuad(viewer: Viewer): void {
  viewer.addSurface(
    Float32Array.of(-6, -6, 0, 6, -6, 0, 6, 6, 0, -6, 6, 0),
    Uint32Array.of(0, 1, 2, 0, 2, 3),
    undefined,
    { color: '#ff0000', opacity: 0.6, blending: 'translucent', fit: 'never' },
  );
}

describeGpu('A volume and the surfaces inside it, by depth', () => {
  let viewer: Viewer;
  beforeEach(async () => {
    viewer = await makeViewer();
  });
  afterEach(() => disposeViewer(viewer));

  /** Look straight down −z: the volume's high z is nearest. */
  const faceOn = () => {
    viewer.camera3d.azimuth = 0;
    viewer.camera3d.elevation = 0;
  };

  it("keeps the nearest channel's depth: a farther channel drawn after it does not undo its occlusion", async () => {
    // Two additive channels, a bright slab near the camera and one far from it, the quad between.
    const near = viewer.addVolume(slab(N - 7, N - 3), N, N, N, {
      rendering: 'mip',
      colormap: 'gray',
      blending: 'additive',
    });
    viewer.addVolume(slab(2, 6), N, N, N, {
      rendering: 'mip',
      colormap: 'gray',
      blending: 'additive',
    });
    addQuad(viewer);
    faceOn();
    const [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(Math.abs(r - g)).toBeLessThanOrEqual(4);
    expect(g).toBeGreaterThan(200);
    // The other order: the near channel drawn last.
    viewer.layers.move(near, 1);
    const [r2, g2] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(Math.abs(r2 - g2)).toBeLessThanOrEqual(4);
    expect(g2).toBeGreaterThan(200);
  });

  for (const rendering of ['mip', 'iso', 'translucent'] as const) {
    it(`${rendering}: a surface in front of what the volume shows is drawn over it; behind, hidden`, async () => {
      // The bright slab far from the camera: the quad is in front of it.
      const far = viewer.addVolume(slab(2, 6), N, N, N, { rendering, colormap: 'gray' });
      addQuad(viewer);
      faceOn();
      const [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
      expect(r).toBeGreaterThan(g + 60);

      // The slab near the camera: it hides the quad, as from behind it would.
      viewer.layers.remove(far);
      viewer.addVolume(slab(N - 7, N - 3), N, N, N, { rendering, colormap: 'gray' });
      const [r2, g2] = pixel(await viewer.readDisplayedPixels(), C, C);
      expect(Math.abs(r2 - g2)).toBeLessThanOrEqual(4);
      expect(g2).toBeGreaterThan(40);
    });
  }
});
