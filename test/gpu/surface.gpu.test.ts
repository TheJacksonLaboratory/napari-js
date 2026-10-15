import { afterEach, beforeEach, expect, it } from 'vitest';

import { projectPoint, type ClippingPlane, type SurfaceLayer, type Viewer } from '../../src';
import { surfaceNets } from '../../src/geometry';
import {
  SIZE,
  SOFTWARE,
  coverage,
  cubeVolume,
  describeGpu,
  disposeViewer,
  litBox,
  makeViewer,
  maxDiff,
  pixel,
} from './harness';

const TOL = SOFTWARE ? 6 : 4;
const C = SIZE / 2;

/** A square of half-side `h` in the plane z = `z`, centred on (`cx`, 0), facing +z: two triangles. */
function quad(h = 1, z = 0, cx = 0) {
  return {
    vertices: Float32Array.of(cx - h, -h, z, cx + h, -h, z, cx + h, h, z, cx - h, h, z),
    faces: Uint32Array.of(0, 1, 2, 0, 2, 3),
  };
}

/** A disc of radius `r` in the plane z = 0: a fan of `n` triangles. */
function disc(r: number, n: number) {
  const vertices = new Float32Array((n + 1) * 3);
  const faces = new Uint32Array(n * 3);
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n;
    vertices.set([r * Math.cos(a), r * Math.sin(a), 0], 3 * (k + 1));
    faces.set([0, 1 + k, 1 + ((k + 1) % n)], 3 * k);
  }
  return { vertices, faces };
}

describeGpu('SurfaceLayer colour, setData, clipping and picking on the GPU', () => {
  let viewer: Viewer;
  beforeEach(async () => {
    viewer = await makeViewer();
  });
  afterEach(() => disposeViewer(viewer));

  /** Look straight down −z: the headlight meets a z-plane face-on, so shading is 1. */
  const faceOn = () => {
    viewer.camera3d.azimuth = 0;
    viewer.camera3d.elevation = 0;
  };

  /** Where world point `p` lands on the canvas (device px = CSS px here). */
  const screenOf = (p: readonly [number, number, number]): [number, number] => {
    const [vw, vh] = viewer.viewportSize();
    const q = projectPoint(viewer.camera3d.viewProjection(vw, vh), p, vw, vh);
    return [q.x, q.y];
  };

  /** Frame the camera on a box of half-side 2 around the origin, face-on, whatever is added after. */
  const frameFixed = () => {
    viewer.camera3d.target = [0, 0, 0];
    viewer.camera3d.distance = 6;
    faceOn();
  };

  it('fills a surface with its colour, recolours it live, and goes back to values + colormap', async () => {
    const { vertices, faces } = quad();
    const layer = viewer.addSurface(vertices, faces, new Float32Array(4).fill(0.5), {
      colormap: 'gray',
      contrastLimits: [0, 1],
      color: '#ff8000',
    });
    faceOn();
    expect(layer.colorMode).toBe('color');
    let px = await viewer.readDisplayedPixels();
    expect(maxDiff(pixel(px, C, C), [255, 128, 0, 255])).toBeLessThanOrEqual(TOL);

    layer.color = [0, 0.5, 1, 1];
    expect(viewer.layers.items).toEqual([layer]);
    px = await viewer.readDisplayedPixels();
    expect(maxDiff(pixel(px, C, C), [0, 128, 255, 255])).toBeLessThanOrEqual(TOL);

    // A half-transparent colour: premultiplied over black.
    layer.color = [1, 1, 1, 0.5];
    px = await viewer.readDisplayedPixels();
    expect(maxDiff(pixel(px, C, C).slice(0, 3), [128, 128, 128])).toBeLessThanOrEqual(TOL);

    layer.color = null;
    expect(layer.colorMode).toBe('colormap');
    px = await viewer.readDisplayedPixels();
    const want = layer.colorAt(0).map((c) => c * 255);
    expect(maxDiff(pixel(px, C, C).slice(0, 3), want.slice(0, 3))).toBeLessThanOrEqual(TOL);
    expect(Math.abs(pixel(px, C, C)[0] - 128)).toBeLessThanOrEqual(TOL);
  });

  it('interpolates per-vertex colours across a triangle, as colorAt gives them', async () => {
    const vertices = Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0);
    const vertexColors = Float32Array.of(1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1);
    const layer = viewer.addSurface(vertices, Uint32Array.of(0, 1, 2), undefined, { vertexColors });
    faceOn();
    expect(layer.colorMode).toBe('vertex');
    const px = await viewer.readDisplayedPixels();
    const corners: Array<[number, number, number]> = [
      [-1, -1, 0],
      [1, -1, 0],
      [0, 1, 0],
    ];
    const centroid: [number, number, number] = [0, -1 / 3, 0];
    // 85% of the way from the centroid to each corner: that corner's colour dominates.
    corners.forEach((v, i) => {
      const p: [number, number, number] = [0, 1, 2].map(
        (a) => centroid[a] + 0.85 * (v[a] - centroid[a]),
      ) as [number, number, number];
      const rgb = pixel(px, ...screenOf(p)).slice(0, 3);
      const want = layer.colorAt(i);
      const dominant = want.indexOf(1);
      expect(rgb[dominant]).toBeGreaterThan(180);
      for (let c = 0; c < 3; c++) if (c !== dominant) expect(rgb[c]).toBeLessThan(60);
    });
    // The centroid: the mean of the three colorAt colours.
    const mean = [0, 1, 2].map(
      (c) => ((layer.colorAt(0)[c] + layer.colorAt(1)[c] + layer.colorAt(2)[c]) / 3) * 255,
    );
    expect(maxDiff(pixel(px, ...screenOf(centroid)).slice(0, 3), mean)).toBeLessThanOrEqual(
      TOL + 2,
    );
  });

  it('swaps its mesh in place with setData, smaller and then larger than its buffers', async () => {
    const { vertices, faces } = quad();
    const layer = viewer.addSurface(vertices, faces, undefined, { color: '#ffffff', fit: 'never' });
    frameFixed();
    const id = layer.id;
    const bigQuad = coverage(await viewer.readDisplayedPixels(), 64);

    // A smaller triangle: fewer vertices and faces than the buffers hold.
    layer.setData(Float32Array.of(-0.5, -0.5, 0, 0.5, -0.5, 0, 0, 0.5, 0), Uint32Array.of(0, 1, 2));
    let px = await viewer.readDisplayedPixels();
    expect(coverage(px, 64)).toBeLessThan(bigQuad / 4);
    let box = litBox(px, 64);
    const [tx0, ty1] = screenOf([-0.5, -0.5, 0]);
    const [tx1, ty0] = screenOf([0.5, 0.5, 0]);
    expect(maxDiff(box, [tx0, ty0, tx1, ty1])).toBeLessThanOrEqual(2);

    // A disc of radius 1.5 from 64 triangles: outgrows the buffers.
    const d = disc(1.5, 64);
    layer.setData(d.vertices, d.faces);
    px = await viewer.readDisplayedPixels();
    box = litBox(px, 64);
    const [dx0, dy1] = screenOf([-1.5, -1.5, 0]);
    const [dx1, dy0] = screenOf([1.5, 1.5, 0]);
    expect(maxDiff(box, [dx0, dy0, dx1, dy1])).toBeLessThanOrEqual(2);
    // π r² against the square (2r)²: π/4 of the disc's box.
    const boxArea = ((dx1 - dx0) * (dy1 - dy0)) / (SIZE * SIZE);
    expect(Math.abs(coverage(px, 64) / boxArea - Math.PI / 4)).toBeLessThan(0.05);

    expect(layer.id).toBe(id);
    expect(viewer.layers.items).toEqual([layer]);
  });

  const RIGHT: ClippingPlane = { position: [0, 0, 0], normal: [1, 0, 0] };

  it('clips the surface to a half-space; an off plane clips nothing', async () => {
    const { vertices, faces } = quad();
    const layer = viewer.addSurface(vertices, faces, undefined, { color: '#ffffff' });
    faceOn();
    const whole = coverage(await viewer.readDisplayedPixels(), 64);
    layer.clippingPlanes = [RIGHT];
    const px = await viewer.readDisplayedPixels();
    expect(coverage(px, 64) / whole).toBeGreaterThan(0.45);
    expect(coverage(px, 64) / whole).toBeLessThan(0.55);
    expect(pixel(px, ...screenOf([0.5, 0, 0]))[0]).toBeGreaterThan(255 - TOL);
    expect(pixel(px, ...screenOf([-0.5, 0, 0])).slice(0, 3)).toEqual([0, 0, 0]);

    layer.clippingPlanes = [{ ...RIGHT, enabled: false }];
    expect(Math.abs(coverage(await viewer.readDisplayedPixels(), 64) - whole)).toBeLessThan(0.005);
  });

  it('clips a surfaceNets mesh and the volume it was cut from by the same plane alike', async () => {
    const N = 32;
    const mask = cubeVolume(N, 6, 255);
    // The cut x ≥ 15.5 in the volume's data coordinates …
    const volume = viewer.addVolume(mask, N, N, N, {
      colormap: 'gray',
      clippingPlanes: [{ position: [15.5, 0, 0], normal: [1, 0, 0] }],
    });
    faceOn();
    const volumeBox = litBox(await viewer.readDisplayedPixels(), 128);

    // … is x ≥ 0 in the world box the volume is drawn in, where the mesh's vertices are: a surface
    // has no data → world transform, so its planes are given in its vertex coordinates.
    const origin: [number, number, number] = [0.5 - N / 2, 0.5 - N / 2, 0.5 - N / 2];
    const mesh = surfaceNets(mask, [N, N, N], { origin });
    volume.visible = false;
    viewer.addSurface(mesh.vertices, mesh.faces, undefined, {
      color: '#ffffff',
      fit: 'never',
      clippingPlanes: [RIGHT],
    });
    const surfaceBox = litBox(await viewer.readDisplayedPixels(), 128);
    expect(Number.isFinite(surfaceBox[0])).toBe(true);
    expect(maxDiff(surfaceBox, volumeBox)).toBeLessThanOrEqual(2);
  });

  /** Pick on a grid of pixel centres and compare with what was drawn there, away from edges. */
  async function pickAgainstPixels(
    check: (x: number, y: number, rgb: number[], hit: SurfaceLayer | null) => void,
  ) {
    const px = await viewer.readDisplayedPixels();
    const drawn = (x: number, y: number) => Math.max(...pixel(px, x, y).slice(0, 3)) > 16;
    let compared = 0;
    for (let y = 2; y < SIZE - 2; y += 3) {
      for (let x = 2; x < SIZE - 2; x += 3) {
        // Only where the 3 × 3 neighbourhood agrees: an edge pixel is half covered.
        const here = drawn(x, y);
        let edge = false;
        for (let j = -1; j <= 1; j++)
          for (let i = -1; i <= 1; i++) if (drawn(x + i, y + j) !== here) edge = true;
        if (edge) continue;
        const hit = viewer.pickSurface(x + 0.5, y + 0.5);
        expect(!!hit, `pick at (${x}, ${y})`).toBe(here);
        check(x, y, pixel(px, x, y).slice(0, 3), hit?.layer ?? null);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(200);
  }

  it('picks exactly where a clipped surface is drawn', async () => {
    const { vertices, faces } = quad();
    viewer.addSurface(vertices, faces, undefined, { color: '#ffffff', clippingPlanes: [RIGHT] });
    faceOn();
    await pickAgainstPixels(() => undefined);
  });

  it('picks the nearer of two overlapping surfaces, as drawn, and never a hidden one', async () => {
    const back = quad(1, 0, -0.4);
    const front = quad(1, 0.5, 0.4);
    const red = viewer.addSurface(back.vertices, back.faces, undefined, {
      color: '#ff0000',
      fit: 'never',
    });
    const green = viewer.addSurface(front.vertices, front.faces, undefined, {
      color: '#00ff00',
      fit: 'never',
    });
    frameFixed();
    const colourOf = (layer: SurfaceLayer | null) => (layer === red ? 0 : layer === green ? 1 : -1);
    await pickAgainstPixels((_x, _y, rgb, hit) => {
      if (!hit) return;
      expect(rgb.indexOf(Math.max(...rgb))).toBe(colourOf(hit));
    });
    // The overlap, in front: green, picked green.
    const overlap = screenOf([0, 0, 0.5]);
    expect(viewer.pickSurface(...overlap)?.layer).toBe(green);

    green.visible = false;
    expect(viewer.pickSurface(...overlap)?.layer).toBe(red);
    await pickAgainstPixels((_x, _y, rgb, hit) => {
      expect(hit).not.toBe(green);
      if (hit) expect(rgb.indexOf(Math.max(...rgb))).toBe(0);
    });
  });
});
