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
    // Two channels (translucent: additive ones take no part in depth), a bright slab near the camera and one far from it, the quad between.
    const near = viewer.addVolume(slab(N - 7, N - 3), N, N, N, {
      rendering: 'mip',
      colormap: 'gray',
      blending: 'translucent',
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

  for (const blending of ['translucent_no_depth', 'additive'] as const) {
    it(`a ${blending} volume hides no surface inside it`, async () => {
      // The bright slab near the camera, the quad behind it: drawn over the volume all the same.
      viewer.addVolume(slab(N - 7, N - 3), N, N, N, {
        rendering: 'mip',
        colormap: 'gray',
        blending,
      });
      addQuad(viewer);
      faceOn();
      const [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
      expect(r).toBeGreaterThan(g + 60);
    });
  }

  it('a translucent_no_depth surface is drawn over an opaque one in front of it', async () => {
    viewer.addSurface(
      Float32Array.of(-6, -6, 5, 6, -6, 5, 6, 6, 5, -6, 6, 5),
      Uint32Array.of(0, 1, 2, 0, 2, 3),
      undefined,
      { color: '#00ff00' },
    );
    viewer.addSurface(
      Float32Array.of(-6, -6, -5, 6, -6, -5, 6, 6, -5, -6, 6, -5),
      Uint32Array.of(0, 1, 2, 0, 2, 3),
      undefined,
      { color: '#ff0000', opacity: 0.6, blending: 'translucent_no_depth', fit: 'never' },
    );
    faceOn();
    const [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(r).toBeGreaterThan(100);
    expect(g).toBeGreaterThan(40);
  });

  /** A green opaque quad at world z. */
  const greenQuad = (z: number) =>
    viewer.addSurface(
      Float32Array.of(-6, -6, z, 6, -6, z, 6, 6, z, -6, 6, z),
      Uint32Array.of(0, 1, 2, 0, 2, 3),
      undefined,
      { color: '#00ff00', fit: 'never' },
    );
  /** A red 20 px point at world (0, 0, z), its colour a colormap of one value. */
  const redPoint = (z: number, opacity: number) =>
    viewer.addPoints3D(Float32Array.of(0, 0, z), Float32Array.of(1), {
      colormap: 'red',
      contrastLimits: [0, 1],
      size: 20,
      opacity,
      blending: 'translucent_no_depth',
      fit: 'never',
    });
  /** Frame the camera on a box around the scene (the quads and points do not frame it). */
  const frame = () => {
    viewer.addVolume(new Uint8Array(8 * 8 * 8), 8, 8, 8, { colormap: 'gray' });
    faceOn();
  };

  it('a translucent_no_depth point is drawn over an opaque quad in front of it', async () => {
    frame();
    greenQuad(5);
    redPoint(-5, 0.6);
    const [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(r).toBeGreaterThan(100);
    expect(g).toBeGreaterThan(40);
  });

  it('a translucent_no_depth point writes no depth: a quad drawn after it, behind it, covers it', async () => {
    frame();
    const point = redPoint(5, 0.5);
    greenQuad(0);
    let [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(g).toBeGreaterThan(200);
    expect(r).toBeLessThan(16);
    // Made translucent live, it takes part in depth again: in front, it hides the quad.
    point.blending = 'translucent';
    [r, g] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(r).toBeGreaterThan(100);
    expect(g).toBeLessThan(16);
  });

  it('a volume after a surface that writes no depth keeps its single draw', async () => {
    // Count the volume's draws: its full-screen quad is the only draw(6) with no instances.
    const proto = GPURenderPassEncoder.prototype;
    const draw = proto.draw;
    let volumeDraws = 0;
    proto.draw = function (this: GPURenderPassEncoder, ...args: Parameters<typeof draw>) {
      if (args.length === 1 && args[0] === 6) volumeDraws++;
      return draw.apply(this, args);
    };
    try {
      const quad = viewer.addSurface(
        Float32Array.of(-6, -6, 0, 6, -6, 0, 6, 6, 0, -6, 6, 0),
        Uint32Array.of(0, 1, 2, 0, 2, 3),
        undefined,
        { color: '#ff0000', blending: 'additive', fit: 'never' },
      );
      viewer.addVolume(slab(2, 6), N, N, N, { rendering: 'mip', colormap: 'gray' });
      faceOn();
      const count = async () => {
        await viewer.readDisplayedPixels();
        volumeDraws = 0;
        await viewer.readDisplayedPixels();
        return volumeDraws;
      };
      // The volume's draws with no surface before it: one per render.
      quad.visible = false;
      const alone = await count();
      quad.visible = true;
      expect(await count()).toBe(alone);
      // A translucent_no_depth surface: still none written.
      quad.blending = 'translucent_no_depth';
      expect(await count()).toBe(alone);
      // An opaque one writes depth: the volume keeps the nearer of its own and that, in two draws.
      quad.blending = 'translucent';
      expect(await count()).toBe(2 * alone);
    } finally {
      proto.draw = draw;
    }
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
