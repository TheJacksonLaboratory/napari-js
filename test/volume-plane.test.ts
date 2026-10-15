import { describe, expect, it } from 'vitest';

import { VolumeLayer } from '../src/layers/volume-layer';
import { MAX_CLIPPING_PLANES } from '../src/layers/clipping';
import {
  clipRayRange,
  clipRayRangeByPlanes,
  halfSpace,
  normalizeVolumePlane,
  planeSlabContains,
  volumePlaneSlice,
} from '../src/layers/volume-plane';
import { MultiChannelVolumeView, type VolumeHost } from '../src/views/multichannel-volume-view';
import { packVolumeUniforms, VOLUME_UNIFORM_FLOATS } from '../src/visuals/volume-visual';
import { VOLUME_SHADER } from '../src/visuals/volume-shader';
import { identity } from '../src/math/mat4';

/** A 4 × 3 × 2 volume whose voxel (x, y, z) is 10·x + 50·y + 100·z (x fastest). */
const W = 4,
  H = 3,
  D = 2;
const DATA = new Uint8Array(W * H * D);
for (let z = 0; z < D; z++)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) DATA[x + W * (y + H * z)] = 10 * x + 50 * y + 100 * z;
const VOL = { data: DATA, width: W, height: H, depth: D };

type V3 = [number, number, number];

/**
 * The shader's single-sample plane path, in TypeScript: the ray (texture space) crosses the plane at
 * `tp`, and the sample there is mapped to data coordinates (texture × dims − 0.5).
 */
function planeHit(ro: V3, rd: V3, plane: { position: V3; normal: V3 }): V3 | null {
  const h = halfSpace(plane);
  const toData = (p: V3): V3 => [p[0] * W - 0.5, p[1] * H - 0.5, p[2] * D - 0.5];
  const a = h[0] * toData(ro)[0] + h[1] * toData(ro)[1] + h[2] * toData(ro)[2] + h[3];
  const b = h[0] * rd[0] * W + h[1] * rd[1] * H + h[2] * rd[2] * D;
  if (Math.abs(b) < 1e-9) return null;
  const tp = -a / b;
  return toData([ro[0] + rd[0] * tp, ro[1] + rd[1] * tp, ro[2] + rd[2] * tp]);
}

describe('volume plane geometry', () => {
  it('shows the slice an axis-aligned plane sits on, in x, y, z order', () => {
    const z1 = volumePlaneSlice(VOL, { position: [0, 0, 1], normal: [0, 0, 1] })!;
    expect([z1.width, z1.height]).toEqual([4, 3]);
    expect(Array.from(z1.data)).toEqual([
      100, 110, 120, 130, 150, 160, 170, 180, 200, 210, 220, 230,
    ]);
    const y2 = volumePlaneSlice(VOL, { position: [9, 2, 9], normal: [0, -3, 0] })!;
    expect([y2.width, y2.height]).toEqual([4, 2]);
    expect(Array.from(y2.data)).toEqual([100, 110, 120, 130, 200, 210, 220, 230]);
    const x3 = volumePlaneSlice(VOL, { position: [2.6, 0, 0], normal: [1, 0, 0] })!; // nearest voxel: x = 3
    expect([x3.width, x3.height]).toEqual([3, 2]);
    expect(Array.from(x3.data)).toEqual([30, 80, 130, 130, 180, 230]);
    expect(volumePlaneSlice(VOL, { position: [0, 0, 0], normal: [1, 1, 0] })).toBeNull();
    expect(volumePlaneSlice(VOL, { position: [0, 0, 5], normal: [0, 0, 1] })).toBeNull();
  });

  it('a ray crosses an axis-aligned plane at the voxel centres of its slice, from any direction', () => {
    const plane = { position: [0, 0, 1] as V3, normal: [0, 0, 1] as V3 };
    for (const [ro, rd] of [
      [
        [0.3, 0.4, -1],
        [0.1, 0.2, 3],
      ],
      [
        [0.9, 0.1, 2],
        [-0.5, 0.6, -2.5],
      ],
      [
        [0.5, 0.5, 0.5],
        [0, 0, 1],
      ],
    ] as Array<[V3, V3]>) {
      const hit = planeHit(ro, rd, plane)!;
      // Data z = 1 is texture z = 1.5 / 2, the centre of slice 1: linear sampling reads that slice only.
      expect(hit[2]).toBeCloseTo(1, 9);
    }
    expect(planeHit([0, 0, 0.75], [1, 0, 0], plane)).toBeNull(); // parallel to the plane
  });

  it('a slab holds what lies within half its thickness of the plane', () => {
    const plane = { position: [0, 0, 5] as V3, normal: [0, 0, 2] as V3, thickness: 3 };
    expect(planeSlabContains([9, 9, 6.5], plane)).toBe(true);
    expect(planeSlabContains([9, 9, 3.5], plane)).toBe(true);
    expect(planeSlabContains([9, 9, 6.6], plane)).toBe(false);
  });

  it('narrows a ray to a half-space, and empties it when the ray runs outside, parallel', () => {
    // A ray along +z from z = −1 to z = 9; keep z ≥ 3 → t ≥ 0.4; keep z ≤ 3 → t ≤ 0.4.
    const up = halfSpace({ position: [0, 0, 3], normal: [0, 0, 1] });
    const down = halfSpace({ position: [0, 0, 3], normal: [0, 0, -1] });
    const [t0] = clipRayRange([0, 1], [0, 0, -1], [0, 0, 10], up);
    expect(t0).toBeCloseTo(0.4, 9);
    expect(clipRayRange([0, 1], [0, 0, -1], [0, 0, 10], down)[1]).toBeCloseTo(0.4, 9);
    const [a, b] = clipRayRange([0, 1], [0, 0, 0], [1, 0, 0], up);
    expect(a).toBeGreaterThan(b);
    expect(clipRayRange([0, 1], [0, 0, 4], [1, 0, 0], up)).toEqual([0, 1]);
    // A slab is two half-spaces, each widened by half the thickness.
    const slab = { position: [0, 0, 3] as V3, normal: [0, 0, 1] as V3 };
    let r = clipRayRange([0, 1], [0, 0, -1], [0, 0, 10], halfSpace(slab, 1));
    r = clipRayRange(r, [0, 0, -1], [0, 0, 10], halfSpace({ ...slab, normal: [0, 0, -1] }, 1));
    expect(r[0]).toBeCloseTo(0.3, 9);
    expect(r[1]).toBeCloseTo(0.5, 9);
  });
});

describe('VolumeLayer depiction and plane', () => {
  it('draws the whole volume by default; its plane goes through the middle, normal +z, one voxel', () => {
    const layer = new VolumeLayer(DATA, W, H, D);
    expect(layer.depiction).toBe('volume');
    expect(layer.plane).toEqual({ position: [1.5, 1, 0.5], normal: [0, 0, 1], thickness: 1 });
  });

  it('takes a plane with a unit normal, live, and refuses a degenerate one', () => {
    const layer = new VolumeLayer(DATA, W, H, D, {
      depiction: 'plane',
      plane: { position: [1, 1, 1], normal: [0, 3, 4], thickness: 2 },
    });
    expect(layer.plane).toEqual({ position: [1, 1, 1], normal: [0, 0.6, 0.8], thickness: 2 });
    let n = 0;
    layer.changed.connect(() => n++);
    layer.depiction = 'volume';
    layer.plane = { position: [0, 0, 1], normal: [0, 0, -1] };
    expect(n).toBe(2);
    expect(layer.plane.thickness).toBe(1);
    expect(() => (layer.plane = { position: [0, 0, 0], normal: [0, 0, 0] })).toThrow();
    expect(() =>
      normalizeVolumePlane({ position: [0, 0, 0], normal: [0, 0, 1], thickness: 0 }),
    ).toThrow();
  });

  it('packs the grid, the depiction and the plane after the existing uniforms', () => {
    const out = new Float32Array(VOLUME_UNIFORM_FLOATS).fill(7);
    const layer = new VolumeLayer(DATA, W, H, D, {
      depiction: 'plane',
      plane: { position: [1, 2, 1], normal: [0, 0, 2], thickness: 3 },
    });
    packVolumeUniforms(out, layer, identity());
    expect(VOLUME_UNIFORM_FLOATS).toBe(60);
    expect(Array.from(out.subarray(24, 28))).toEqual([4, 3, 2, 1]);
    expect(Array.from(out.subarray(28, 32))).toEqual([0, 0, 1, -1]);
    expect(Array.from(out.subarray(32, 36))).toEqual([1.5, 0, 0, 0]);
    expect(Array.from(out.subarray(36))).toEqual(new Array(24).fill(0));
    layer.depiction = 'volume';
    packVolumeUniforms(out, layer, identity());
    expect(out[27]).toBe(0);
  });

  it('declares the uniform fields in the packed order, the clipping planes last', () => {
    const struct = /struct U \{([\s\S]*?)\};/.exec(VOLUME_SHADER)![1];
    const fields = [...struct.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
    expect(fields).toEqual(['invMvp', 'params', 'params2', 'dims', 'plane', 'plane2', 'clip']);
    expect(struct).toMatch(/clip : array<vec4<f32>, 6>/);
  });
});

describe('MultiChannelVolumeView plane', () => {
  const host = (): VolumeHost & { added: number } => {
    const h = {
      added: 0,
      addVolume: (data: Uint8Array, w: number, hh: number, d: number, opts?: object) => {
        h.added++;
        return new VolumeLayer(data, w, hh, d, opts);
      },
      layers: { clear() {} },
      requestRender() {},
    };
    return h;
  };
  const ch = { data: DATA, width: W, height: H, depth: D };

  it('shows every channel as the plane, and moves it live without adding layers', () => {
    const h = host();
    const view = new MultiChannelVolumeView(h);
    const plane = { position: [0, 0, 1] as V3, normal: [0, 0, 1] as V3 };
    const layers = view.render('multichannel', [ch, ch], { depiction: 'plane', plane });
    expect(layers.map((l) => l.depiction)).toEqual(['plane', 'plane']);
    expect(layers[1].plane.position).toEqual([0, 0, 1]);
    view.setPlane({ position: [0, 2, 0], normal: [0, 1, 0] });
    view.setDepiction('volume');
    expect(layers.map((l) => [l.depiction, l.plane.normal])).toEqual([
      ['volume', [0, 1, 0]],
      ['volume', [0, 1, 0]],
    ]);
    expect(h.added).toBe(2);
    // Kept for the next render.
    expect(view.render('grayscale', [ch])[0].plane.position).toEqual([0, 2, 0]);
  });
});

describe('volume clipping planes', () => {
  it('narrows a ray by every enabled plane', () => {
    // A ray along +z from z = −1 to z = 9: keep 2 ≤ z ≤ 6 → t in [0.3, 0.7]; an off plane clips nothing.
    const r = clipRayRangeByPlanes(
      [0, 1],
      [0, 0, -1],
      [0, 0, 10],
      [
        { position: [0, 0, 2], normal: [0, 0, 1] },
        { position: [0, 0, 6], normal: [0, 0, -1] },
        { position: [0, 0, 100], normal: [0, 0, 1], enabled: false },
      ],
    );
    expect(r[0]).toBeCloseTo(0.3, 9);
    expect(r[1]).toBeCloseTo(0.7, 9);
  });

  it('keeps enabled planes with unit normals, live, and refuses too many', () => {
    const layer = new VolumeLayer(DATA, W, H, D, {
      clippingPlanes: [
        { position: [0, 0, 1], normal: [0, 0, 5] },
        { position: [0, 0, 0], normal: [1, 0, 0], enabled: false },
      ],
    });
    expect(layer.clippingPlanes).toEqual([{ position: [0, 0, 1], normal: [0, 0, 1] }]);
    let n = 0;
    layer.changed.connect(() => n++);
    layer.clippingPlanes = [];
    expect(n).toBe(1);
    expect(layer.clippingPlanes).toEqual([]);
    const many = Array.from({ length: MAX_CLIPPING_PLANES + 1 }, () => ({
      position: [0, 0, 0] as V3,
      normal: [0, 0, 1] as V3,
    }));
    expect(() => (layer.clippingPlanes = many)).toThrow();
  });

  it('packs the count and each plane as a half-space, the unused slots zero', () => {
    const out = new Float32Array(VOLUME_UNIFORM_FLOATS).fill(7);
    const layer = new VolumeLayer(DATA, W, H, D, {
      clippingPlanes: [
        { position: [0, 0, 1], normal: [0, 0, 2] },
        { position: [2, 0, 0], normal: [-1, 0, 0] },
      ],
    });
    packVolumeUniforms(out, layer, identity());
    expect(out[33]).toBe(2);
    expect(Array.from(out.subarray(36, 44))).toEqual([0, 0, 1, -1, -1, 0, 0, 2]);
    expect(Array.from(out.subarray(44))).toEqual(new Array(16).fill(0));
  });

  it('MultiChannelVolumeView clips every channel, live and for the next render', () => {
    const view = new MultiChannelVolumeView({
      addVolume: (data, w, h, d, opts) => new VolumeLayer(data, w, h, d, opts),
      layers: { clear() {} },
      requestRender() {},
    });
    const ch = { data: DATA, width: W, height: H, depth: D };
    const plane = { position: [0, 0, 1] as V3, normal: [0, 0, 1] as V3 };
    const layers = view.render('multichannel', [ch, ch], { clippingPlanes: [plane] });
    expect(layers.map((l) => l.clippingPlanes.length)).toEqual([1, 1]);
    view.setClippingPlanes([]);
    expect(layers.map((l) => l.clippingPlanes.length)).toEqual([0, 0]);
    view.setClippingPlanes([plane]);
    expect(view.render('grayscale', [ch])[0].clippingPlanes).toEqual([plane]);
  });
});
