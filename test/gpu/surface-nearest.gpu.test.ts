import { afterEach, beforeEach, expect, it } from 'vitest';

import type { Viewer } from '../../src';
import { SIZE, describeGpu, disposeViewer, makeViewer, pixel } from './harness';

const C = SIZE / 2;

/** Two parallel quads, at z = `za` then z = `zb`, as one mesh: the first quad's triangles first. */
function twoQuads(za: number, zb: number): { vertices: Float32Array; faces: Uint32Array } {
  const quad = (z: number) => [-6, -6, z, 6, -6, z, 6, 6, z, -6, 6, z];
  return {
    vertices: Float32Array.from([...quad(za), ...quad(zb)]),
    faces: Uint32Array.of(0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7),
  };
}

/** Red for the first quad's vertices, green for the second's. */
const RED_THEN_GREEN = Float32Array.from([
  ...[1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
  ...[0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
]);

describeGpu('A translucent surface drawn by its nearest layer', () => {
  let viewer: Viewer;
  beforeEach(async () => {
    viewer = await makeViewer();
  });
  afterEach(() => disposeViewer(viewer));

  /** Look down −z (from +z), or up +z (from −z). */
  const look = (fromFront: boolean) => {
    viewer.camera3d.azimuth = fromFront ? 0 : Math.PI;
    viewer.camera3d.elevation = 0;
  };

  it('shows its near part over its far part from either side, whatever the triangle order', async () => {
    // The near quad (z = 5, red) comes first in the mesh, the far one (z = −5, green) after it:
    // drawn in triangle order, the far one blended over the near one.
    const { vertices, faces } = twoQuads(5, -5);
    viewer.addSurface(vertices, faces, undefined, {
      vertexColors: RED_THEN_GREEN,
      opacity: 0.5,
      blending: 'translucent',
    });
    look(true);
    const [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(r).toBeGreaterThan(100);
    expect(g).toBeLessThan(16);
    // From behind, the green quad is the near one.
    look(false);
    const [r2, g2] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(g2).toBeGreaterThan(100);
    expect(r2).toBeLessThan(16);
  });

  it('still shows another translucent surface behind it (a region inside another)', async () => {
    const quad = (z: number) => Float32Array.of(-6, -6, z, 6, -6, z, 6, 6, z, -6, 6, z);
    const faces = Uint32Array.of(0, 1, 2, 0, 2, 3);
    viewer.addSurface(quad(5), faces, undefined, {
      color: '#ff0000',
      opacity: 0.5,
      blending: 'translucent',
    });
    viewer.addSurface(quad(-5), faces, undefined, {
      color: '#00ff00',
      opacity: 0.5,
      blending: 'translucent',
    });
    look(true);
    const [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(r).toBeGreaterThan(90);
    expect(g).toBeGreaterThan(30);
  });

  it('is hidden by an opaque surface in front of it', async () => {
    const quad = (z: number) => Float32Array.of(-6, -6, z, 6, -6, z, 6, 6, z, -6, 6, z);
    const faces = Uint32Array.of(0, 1, 2, 0, 2, 3);
    viewer.addSurface(quad(-5), faces, undefined, {
      color: '#00ff00',
      opacity: 0.5,
      blending: 'translucent',
    });
    viewer.addSurface(quad(5), faces, undefined, { color: '#ff0000' });
    look(true);
    const [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(16);
  });
});
