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

  it('keeps the far-to-near order between a wireframe and a filled translucent surface', async () => {
    const quad = (z: number) => Float32Array.of(-6, -6, z, 6, -6, z, 6, 6, z, -6, 6, z);
    const faces = Uint32Array.of(0, 1, 2, 0, 2, 3);
    // The red wireframe at z = 5 alone: find a pixel of its diagonal near the middle.
    const wire = viewer.addSurface(quad(5), faces, undefined, {
      color: '#ff0000',
      opacity: 0.5,
      blending: 'translucent',
      wireframe: true,
    });
    look(true);
    let px = await viewer.readDisplayedPixels();
    let at: [number, number] = [C, C];
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++)
        if (pixel(px, C + dx, C + dy)[0] > pixel(px, at[0], at[1])[0]) at = [C + dx, C + dy];
    expect(pixel(px, at[0], at[1])[0]).toBeGreaterThan(100);
    // The green fill at z = −5 behind it: the nearer red line stays over it.
    viewer.addSurface(quad(-5), faces, undefined, {
      color: '#00ff00',
      opacity: 0.5,
      blending: 'translucent',
    });
    px = await viewer.readDisplayedPixels();
    const [r, g] = pixel(px, at[0], at[1]);
    expect(r).toBeGreaterThan(g);
    // From behind, the fill is the nearer: over the line.
    look(false);
    px = await viewer.readDisplayedPixels();
    let line: [number, number] | null = null;
    viewer.layers.remove(wire);
    const fillOnly = await viewer.readDisplayedPixels();
    for (let i = 0; i < px.data.length && !line; i += 4) {
      if (px.data[i] !== fillOnly.data[i])
        line = [(i / 4) % px.width, Math.floor(i / 4 / px.width)];
    }
    expect(line).not.toBeNull();
    const [r2, g2] = pixel(px, line![0], line![1]);
    expect(g2).toBeGreaterThan(r2);
  });

  it('lets a fully transparent near part show the mesh behind it, and follows a live colour change', async () => {
    const { vertices, faces } = twoQuads(5, -5);
    // The near quad red with alpha 0, the far one green and opaque.
    const colors = (nearAlpha: number) =>
      Float32Array.from([
        ...[1, 0, 0, nearAlpha, 1, 0, 0, nearAlpha, 1, 0, 0, nearAlpha, 1, 0, 0, nearAlpha],
        ...[0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
      ]);
    const layer = viewer.addSurface(vertices, faces, undefined, {
      vertexColors: colors(0),
      opacity: 0.5,
      blending: 'translucent',
    });
    look(true);
    const [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(g).toBeGreaterThan(100);
    expect(r).toBeLessThan(16);
    // The near quad made opaque: it is the nearest layer again.
    layer.vertexColors = colors(1);
    const [r2, g2] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(r2).toBeGreaterThan(100);
    expect(g2).toBeLessThan(16);
  });
});
