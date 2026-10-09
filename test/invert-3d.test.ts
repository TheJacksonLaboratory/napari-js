import { describe, it, expect } from 'vitest';
import { VolumeLayer } from '../src/layers/volume-layer';
import { SurfaceLayer } from '../src/layers/surface-layer';
import { Points3DLayer } from '../src/layers/points3d-layer';
import { Camera3D } from '../src/camera/camera3d';
import { identity } from '../src/math/mat4';
import { mapScalar, windowGamma } from '../src/color/display-pipeline';
import { resolveColormap } from '../src/color/colormap';
import { MultiChannelVolumeView, type VolumeHost } from '../src/views/multichannel-volume-view';
import { packVolumeUniforms, VOLUME_UNIFORM_FLOATS } from '../src/visuals/volume-visual';
import { packSurfaceUniforms, SURFACE_UNIFORM_FLOATS } from '../src/visuals/surface-visual';
import { packPoints3DUniforms, POINTS3D_UNIFORM_FLOATS } from '../src/visuals/points3d-visual';
import { IMAGE_COLORMAP_SHADER } from '../src/visuals/image-colormap-shader';
import { VOLUME_SHADER } from '../src/visuals/volume-shader';
import { SURFACE_SHADER } from '../src/visuals/surface-shader';
import { POINTS3D_SHADER } from '../src/visuals/points3d-shader';

const volume = (opts = {}): VolumeLayer => new VolumeLayer(new Uint8Array(8), 2, 2, 2, opts);
const VERTS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]);
const surface = (opts = {}): SurfaceLayer =>
  new SurfaceLayer(VERTS, new Uint32Array([0, 1, 2]), undefined, opts);
const POS = new Float32Array([0, 0, 0, 2, 0, 0, 2, 4, 6]);
const VALS = new Float32Array([10, 20, 30]);
const points = (opts = {}): Points3DLayer => new Points3DLayer(POS, VALS, opts);

/**
 * `invert` on the 3D layers, with ImageLayer's semantics: window → invert → gamma → colormap.
 * Without it a host reverses the colormap instead, which is not the same thing once gamma ≠ 1
 * (colormap(1 − t^γ) vs colormap((1 − t)^γ)) and has to be undone on every colormap change.
 */
describe('invert on 3D layers', () => {
  const kinds = [
    ['VolumeLayer', volume],
    ['SurfaceLayer', surface],
    ['Points3DLayer', points],
  ] as const;

  for (const [name, make] of kinds) {
    it(`${name}: defaults off, honours the option, and is a live setter`, () => {
      expect(make().invert).toBe(false);
      expect(make({ invert: true }).invert).toBe(true);
      const layer = make();
      let emitted = 0;
      layer.changed.connect(() => emitted++);
      const colormapVersion = layer.colormapVersion;
      layer.invert = true;
      expect(layer.invert).toBe(true);
      expect(emitted).toBe(1);
      // A uniform, not a LUT rebuild: inverting is not a colormap change.
      expect(layer.colormapVersion).toBe(colormapVersion);
    });
  }

  it('Points3DLayer: invert stays off the data and style clocks', () => {
    const p = points();
    const { dataVersion, styleVersion } = p;
    p.invert = true;
    expect(p.dataVersion).toBe(dataVersion);
    expect(p.styleVersion).toBe(styleVersion);
  });
});

describe('invert in the uniforms', () => {
  it('volume: params2.w, next to an unchanged normalized window', () => {
    const out = new Float32Array(VOLUME_UNIFORM_FLOATS);
    const layer = volume({ contrastLimits: [51, 204], gamma: 2, rendering: 'iso' });
    packVolumeUniforms(out, layer, identity());
    expect(out[16]).toBeCloseTo(0.2, 6);
    expect(out[17]).toBeCloseTo(0.8, 6);
    expect(Array.from(out.subarray(18, 24))).toEqual([2, 1, 2, 0.5, 192, 0]);
    layer.invert = true;
    packVolumeUniforms(out, layer, identity());
    expect(out[23]).toBe(1);
  });

  it('surface: flags.y, beside the wireframe flag', () => {
    const out = new Float32Array(SURFACE_UNIFORM_FLOATS);
    const layer = surface({ wireframe: true, contrastLimits: [0, 2], gamma: 0.5 });
    const cam = new Camera3D();
    packSurfaceUniforms(out, layer, cam, 640, 480);
    expect(Array.from(out.subarray(16, 20))).toEqual([0, 2, 0.5, 1]);
    expect(Array.from(out.subarray(24, 28))).toEqual([1, 0, 0, 0]);
    layer.invert = true;
    packSurfaceUniforms(out, layer, cam, 640, 480);
    expect(Array.from(out.subarray(24, 28))).toEqual([1, 1, 0, 0]);
    // The headlight is a unit vector from the target toward the eye.
    expect(Math.hypot(out[20], out[21], out[22])).toBeCloseTo(1, 5);
  });

  it('points3d: flags.y, beside the per-point colour flag', () => {
    const out = new Float32Array(POINTS3D_UNIFORM_FLOATS);
    const layer = points({ invert: true });
    packPoints3DUniforms(out, layer, identity(), 100, 100);
    expect(Array.from(out.subarray(24, 28))).toEqual([0, 1, 0, 0]);
  });
});

describe('invert matches the CPU reference (windowGamma)', () => {
  it('Points3DLayer.colorAt inverts before gamma, like ImageLayer', () => {
    const colormap = resolveColormap('viridis');
    const p = points({ invert: true, gamma: 2, contrastLimits: [0, 40] });
    const want = mapScalar(10, { climLo: 0, climHi: 40, gamma: 2, invert: true, colormap });
    expect(p.colorAt(0)).toEqual([...want, 1]);
    // (1 − 0.25)² = 0.5625, not 1 − 0.25² = 0.9375: the order is the point.
    expect(windowGamma(10, 0, 40, 2, true)).toBeCloseTo(0.5625, 10);
    expect(p.colorAt(0).slice(0, 3)).toEqual(colormap.sample(0.5625));
  });

  it('per-point colours are drawn as given, invert or not', () => {
    const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
    const p = points({ colors, invert: true });
    expect(p.colorAt(2)).toEqual([0, 0, 1, 1]);
  });

  // The WGSL cannot run here, so pin its ORDER to windowGamma's instead: in each scalar shader the
  // flip `x = 1.0 - x` is gated by the flag the packer writes, and happens before `pow(x, gamma)`.
  const shaders = [
    ['image', IMAGE_COLORMAP_SHADER, 'u.flags.y'],
    ['volume', VOLUME_SHADER, 'u.params2.w'],
    ['surface', SURFACE_SHADER, 'u.flags.y'],
    ['points3d', POINTS3D_SHADER, 'u.flags.y'],
  ] as const;
  for (const [name, code, flag] of shaders) {
    it(`${name} shader: window → invert (${flag}) → gamma`, () => {
      const flip = /if \((u\.[\w.]+) > 0\.5\) \{ (\w+) = 1\.0 - \2; \}/.exec(code);
      expect(flip, 'invert flip').not.toBeNull();
      const [, gate, v] = flip!;
      expect(gate).toBe(flag);
      const gammaAt = code.indexOf(`pow(${v}, `, flip!.index);
      expect(gammaAt, 'gamma after the flip').toBeGreaterThan(flip!.index);
    });
  }
});

describe('MultiChannelVolumeView invert', () => {
  const host = (): VolumeHost => ({
    addVolume: (data, w, h, d, opts) => new VolumeLayer(data, w, h, d, opts),
    layers: { clear() {} },
    requestRender() {},
  });
  const ch = { data: new Uint8Array(8), width: 2, height: 2, depth: 2 };

  it('passes a channel’s invert to its layer and updates it live', () => {
    const view = new MultiChannelVolumeView(host());
    const [a, b] = view.render('multichannel', [
      { ...ch, tint: '#ff0000', invert: true },
      { ...ch, tint: '#00ff00' },
    ]);
    expect(a.invert).toBe(true);
    expect(b.invert).toBe(false);
    const colormap = b.colormap;
    view.updateChannel(1, { invert: true });
    expect(b.invert).toBe(true);
    expect(b.colormap).toBe(colormap); // the tint is left alone
  });
});
