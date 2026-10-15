import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  MultiChannelVolumeView,
  insideClippingPlanes,
  mapScalar,
  projectPoint,
  resolveColormap,
  volumePlaneSlice,
  type ClippingPlane,
  type VolumeLayer,
  type Viewer,
} from '../../src';
import { surfaceNets } from '../../src/geometry';
import {
  SIZE,
  SOFTWARE,
  coverage,
  cubeVolume,
  describeGpu,
  disposeViewer,
  makeViewer,
  maxDiff,
  pixel,
} from './harness';

const TOL = SOFTWARE ? 6 : 4;
const C = SIZE / 2;
const GRAY = resolveColormap('gray');

/** Where data point `p` (voxel `i` centred on `i`) of `layer` lands on the canvas (device px). */
function screenOf(
  viewer: Viewer,
  layer: VolumeLayer,
  p: readonly [number, number, number],
): [number, number] {
  const [sx, sy, sz] = layer.voxelSize;
  // The volume's world box is centred on the origin: voxel i's centre at (i + 0.5 − n/2) · s.
  const world: [number, number, number] = [
    (p[0] + 0.5 - layer.width / 2) * sx,
    (p[1] + 0.5 - layer.height / 2) * sy,
    (p[2] + 0.5 - layer.depth / 2) * sz,
  ];
  const [vw, vh] = viewer.viewportSize();
  const q = projectPoint(viewer.camera3d.viewProjection(vw, vh), world, vw, vh);
  return [q.x, q.y];
}

/** The lit pixels' bounding box `[x0, y0, x1, y1]` (brightest channel above `threshold`). */
function litBox(px: { width: number; height: number; data: Uint8ClampedArray }, threshold: number) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const i = (y * px.width + x) * 4;
      if (Math.max(px.data[i], px.data[i + 1], px.data[i + 2]) <= threshold) continue;
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
  return box;
}

describeGpu('Volume plane depiction and clipping planes on the GPU', () => {
  let viewer: Viewer;
  beforeEach(async () => {
    viewer = await makeViewer();
  });
  afterEach(() => disposeViewer(viewer));

  /** Look straight down −z (x right, y up on screen). */
  const faceOn = () => {
    viewer.camera3d.azimuth = 0;
    viewer.camera3d.elevation = 0;
  };

  // 8 × 8 × 4, every voxel distinct: base per slice (brightest in the middle) plus x and y ramps.
  const W = 8;
  const H = 8;
  const D = 4;
  const BASE = [20, 140, 60, 100];
  const layered = () => {
    const data = new Uint8Array(W * H * D);
    for (let z = 0; z < D; z++)
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) data[x + W * (y + H * z)] = BASE[z] + 4 * x + 2 * y;
    return data;
  };

  /** The worst difference between the canvas and `slice` (mapped through gray) at voxel centres. */
  async function sliceError(
    layer: VolumeLayer,
    k: number,
    slice: { width: number; data: Uint8Array },
  ) {
    const px = await viewer.readDisplayedPixels();
    let worst = 0;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const [x, y] = screenOf(viewer, layer, [i, j, k]);
        const want = mapScalar(slice.data[j * slice.width + i], {
          climLo: 0,
          climHi: 255,
          gamma: 1,
          invert: false,
          colormap: GRAY,
        }).map((c) => c * 255);
        worst = Math.max(worst, maxDiff(pixel(px, x, y), want));
      }
    return worst;
  }

  it('shows exactly slice k for an axis-aligned plane at z = k, and follows the plane live', async () => {
    const data = layered();
    const plane = (k: number) => ({
      position: [3.5, 3.5, k] as [number, number, number],
      normal: [0, 0, 1] as [number, number, number],
    });
    const layer = viewer.addVolume(data, W, H, D, {
      colormap: 'gray',
      depiction: 'plane',
      plane: plane(2),
    });
    faceOn();
    const vol = { data, width: W, height: H, depth: D };
    expect(await sliceError(layer, 2, volumePlaneSlice(vol, plane(2))!)).toBeLessThanOrEqual(TOL);

    // Moved by the setter: the same layer, now slice 0.
    layer.plane = plane(0);
    expect(viewer.layers.items).toEqual([layer]);
    expect(await sliceError(layer, 0, volumePlaneSlice(vol, plane(0))!)).toBeLessThanOrEqual(TOL);

    // Back to the whole volume: the MIP over z. Its samples fall between voxel centres along the
    // ray (linear filtering), so it lands between the second-brightest slice (3) and slice 1.
    layer.depiction = 'volume';
    const px = await viewer.readDisplayedPixels();
    for (const [i, j] of [
      [1, 1],
      [4, 3],
      [6, 6],
    ]) {
      const [r] = pixel(px, ...screenOf(viewer, layer, [i, j, 3]));
      expect(r).toBeGreaterThanOrEqual(BASE[3] + 4 * i + 2 * j - TOL);
      expect(r).toBeLessThanOrEqual(BASE[1] + 4 * i + 2 * j + TOL);
    }
  });

  it('projects the brightest slice of a thick slab under MIP, and only the slices in the slab', async () => {
    const data = layered();
    const vol = { data, width: W, height: H, depth: D };
    // Slices 0..2: the brightest is 1.
    const layer = viewer.addVolume(data, W, H, D, {
      colormap: 'gray',
      rendering: 'mip',
      depiction: 'plane',
      plane: { position: [3.5, 3.5, 1], normal: [0, 0, 1], thickness: 3 },
    });
    faceOn();
    const slice = (k: number) => volumePlaneSlice(vol, { position: [0, 0, k], normal: [0, 0, 1] })!;
    expect(await sliceError(layer, 1, slice(1))).toBeLessThanOrEqual(TOL);
    // Slices 2..3: the brightest is 3.
    layer.plane = { position: [3.5, 3.5, 2.5], normal: [0, 0, 1], thickness: 2 };
    expect(await sliceError(layer, 3, slice(3))).toBeLessThanOrEqual(TOL);
  });

  it('draws nothing for a plane seen edge-on', async () => {
    viewer.addVolume(layered(), W, H, D, {
      colormap: 'gray',
      depiction: 'plane',
      plane: { position: [3, 3.5, 1.5], normal: [1, 0, 0] },
    });
    faceOn();
    expect(coverage(await viewer.readDisplayedPixels(), 8)).toBeLessThan(0.01);
  });

  // A bright cube, 13 voxels a side, in a 32³ volume; the half-space x ≥ 15.5 keeps its right half.
  const N = 32;
  const RIGHT_HALF: ClippingPlane = { position: [15.5, 0, 0], normal: [1, 0, 0] };

  it('clips the MIP to a half-space, and an off plane clips nothing', async () => {
    const layer = viewer.addVolume(cubeVolume(N, 6, 255), N, N, N, { colormap: 'gray' });
    faceOn();
    const whole = coverage(await viewer.readDisplayedPixels(), 128);

    layer.clippingPlanes = [RIGHT_HALF];
    const px = await viewer.readDisplayedPixels();
    expect(coverage(px, 128) / whole).toBeGreaterThan(0.4);
    expect(coverage(px, 128) / whole).toBeLessThan(0.6);
    // Kept where the CPU reference keeps it: right of the cut lit, left of it dark.
    const right: [number, number, number] = [19, 15.5, 15.5];
    const left: [number, number, number] = [12, 15.5, 15.5];
    expect(insideClippingPlanes(right, [RIGHT_HALF])).toBe(true);
    expect(insideClippingPlanes(left, [RIGHT_HALF])).toBe(false);
    expect(pixel(px, ...screenOf(viewer, layer, right))[0]).toBeGreaterThan(255 - TOL);
    expect(pixel(px, ...screenOf(viewer, layer, left))[0]).toBeLessThanOrEqual(TOL);

    layer.clippingPlanes = [{ ...RIGHT_HALF, enabled: false }];
    expect(Math.abs(coverage(await viewer.readDisplayedPixels(), 128) - whole)).toBeLessThan(0.005);
  });

  it('clips a plane depiction too', async () => {
    const layer = viewer.addVolume(cubeVolume(N, 6, 255), N, N, N, {
      colormap: 'gray',
      depiction: 'plane',
      plane: { position: [15.5, 15.5, 15], normal: [0, 0, 1] },
    });
    faceOn();
    // The cube's middle slice, farther from the camera than its front face: ~0.035 of the canvas.
    const whole = coverage(await viewer.readDisplayedPixels(), 128);
    expect(whole).toBeGreaterThan(0.02);
    layer.clippingPlanes = [RIGHT_HALF];
    const px = await viewer.readDisplayedPixels();
    expect(coverage(px, 128) / whole).toBeGreaterThan(0.4);
    expect(coverage(px, 128) / whole).toBeLessThan(0.6);
    expect(pixel(px, ...screenOf(viewer, layer, [12, 15.5, 15]))[0]).toBeLessThanOrEqual(TOL);
  });

  it('applies depiction, plane and clipping planes to every channel of a multichannel view', async () => {
    const view = new MultiChannelVolumeView(viewer);
    const data = cubeVolume(N, 6, 255);
    const ch = (tint: string) => ({ data, width: N, height: N, depth: N, tint });
    const layers = view.render('multichannel', [ch('#ff0000'), ch('#00ff00')]);
    faceOn();
    const full = coverage(await viewer.readDisplayedPixels(), 128);

    view.setClippingPlanes([RIGHT_HALF]);
    expect(layers.every((l) => l.clippingPlanes.length === 1)).toBe(true);
    let px = await viewer.readDisplayedPixels();
    const [r, g] = pixel(px, ...screenOf(viewer, layers[0], [19, 15.5, 15.5]));
    expect(r).toBeGreaterThan(255 - TOL);
    expect(g).toBeGreaterThan(255 - TOL);
    expect(pixel(px, ...screenOf(viewer, layers[0], [12, 15.5, 15.5])).slice(0, 3)).toEqual([
      0, 0, 0,
    ]);

    // A plane outside the cube (slice 3): nothing in either channel.
    view.setClippingPlanes([]);
    view.setDepiction('plane', { position: [15.5, 15.5, 3], normal: [0, 0, 1] });
    expect(layers.every((l) => l.depiction === 'plane')).toBe(true);
    px = await viewer.readDisplayedPixels();
    expect(coverage(px, 8)).toBeLessThan(0.005);
    // Through the cube: both channels again, over the cube's footprint.
    view.setPlane({ position: [15.5, 15.5, 15], normal: [0, 0, 1] });
    px = await viewer.readDisplayedPixels();
    const [r2, g2] = pixel(px, C, C);
    expect(r2).toBeGreaterThan(255 - TOL);
    expect(g2).toBeGreaterThan(255 - TOL);
    expect(Math.abs(coverage(px, 128) - full)).toBeLessThan(0.02);
  });

  it('lines a surfaceNets mesh of a mask up with the volume it was cut from', async () => {
    const mask = cubeVolume(N, 6, 255);
    const voxelSize: [number, number, number] = [1, 1, 2];
    const layer = viewer.addVolume(mask, N, N, N, { colormap: 'gray', voxelSize });
    faceOn();
    const mip = litBox(await viewer.readDisplayedPixels(), 128);

    // Voxel 0's centre in the volume's world box, as screenOf maps it.
    const origin: [number, number, number] = [
      (0.5 - N / 2) * voxelSize[0],
      (0.5 - N / 2) * voxelSize[1],
      (0.5 - N / 2) * voxelSize[2],
    ];
    const mesh = surfaceNets(mask, [N, N, N], { voxelSize, origin });
    layer.visible = false;
    viewer.addSurface(
      mesh.vertices,
      mesh.faces,
      new Float32Array(mesh.vertices.length / 3).fill(1),
      {
        colormap: 'gray',
        contrastLimits: [0, 1],
        fit: 'never',
      },
    );
    const surface = litBox(await viewer.readDisplayedPixels(), 128);
    expect(Number.isFinite(surface[0])).toBe(true);
    for (let e = 0; e < 4; e++) expect(Math.abs(surface[e] - mip[e])).toBeLessThanOrEqual(2);
  });
});
