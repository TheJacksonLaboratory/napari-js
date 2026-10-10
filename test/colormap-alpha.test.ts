import { describe, it, expect } from 'vitest';
import { Colormap, GRAY, VIRIDIS, reverseColormap } from '../src/color/colormap';
import { buildLut, LUT_SIZE } from '../src/color/lut';
import { mapScalar, mapScalarRGBA } from '../src/color/display-pipeline';
import { ImageLayer } from '../src/layers/image-layer';
import { toTextureSource } from '../src/io/texture-source';
import { packImageDisplayUniforms, IMAGE_UNIFORM_FLOATS } from '../src/visuals/image-visual';
import { IMAGE_COLORMAP_SHADER } from '../src/visuals/image-colormap-shader';

/** Transparent at the bottom, opaque red at the top: a density overlay. */
const FADE = new Colormap('fade', [
  { t: 0, color: [0, 0, 0, 0] },
  { t: 0.5, color: [1, 0, 0] }, // no alpha → opaque
  { t: 1, color: [1, 1, 0, 1] },
]);

const scalarImage = (data: Float32Array, opts = {}): ImageLayer =>
  new ImageLayer(
    toTextureSource({
      kind: 'typed',
      dtype: 'float32',
      channels: 1,
      width: data.length,
      height: 1,
      data,
    }),
    opts,
  );

describe('RGBA colormap stops', () => {
  it('interpolates alpha like the channels; a stop without alpha is opaque', () => {
    expect(FADE.sampleRGBA(0)).toEqual([0, 0, 0, 0]);
    expect(FADE.sampleRGBA(0.25)).toEqual([0.5, 0, 0, 0.5]);
    expect(FADE.sampleRGBA(0.75)).toEqual([1, 0.5, 0, 1]);
    // Clamped, like sample().
    expect(FADE.sampleRGBA(-1)).toEqual([0, 0, 0, 0]);
  });

  it('keeps sample() RGB-only, so existing callers see no change', () => {
    expect(FADE.sample(0.25)).toEqual([0.5, 0, 0]);
    expect(GRAY.sampleRGBA(0.5)).toEqual([0.5, 0.5, 0.5, 1]);
  });

  it('carries alpha into the LUT; an RGB colormap still builds an opaque one', () => {
    const lut = buildLut(FADE, LUT_SIZE);
    expect(lut[3]).toBe(0);
    expect(lut[(LUT_SIZE - 1) * 4 + 3]).toBe(255);
    const quarter = Math.round((LUT_SIZE - 1) / 4);
    expect(lut[quarter * 4 + 3]).toBe(Math.round((quarter / (LUT_SIZE - 1)) * 2 * 255));
    const opaque = buildLut(VIRIDIS, LUT_SIZE);
    for (let i = 0; i < LUT_SIZE; i++) expect(opaque[i * 4 + 3]).toBe(255);
  });

  it('survives reverseColormap', () => {
    expect(reverseColormap(FADE).sampleRGBA(1)).toEqual([0, 0, 0, 0]);
  });
});

describe('mapScalarRGBA (CPU reference for the scalar image path)', () => {
  const base = { climLo: 10, climHi: 20, gamma: 1, invert: false, colormap: FADE };

  it('agrees with mapScalar on RGB and adds the colormap alpha', () => {
    for (const v of [5, 12.5, 15, 20, 30]) {
      const c = mapScalarRGBA(v, base);
      expect(c.slice(0, 3)).toEqual(mapScalar(v, base));
    }
    expect(mapScalarRGBA(12.5, base)[3]).toBe(0.5);
  });

  it('transparentBelow zeroes alpha at and below the low limit only', () => {
    const opts = { ...base, colormap: GRAY, transparentBelow: true };
    expect(mapScalarRGBA(10, opts)[3]).toBe(0);
    expect(mapScalarRGBA(-3, opts)[3]).toBe(0);
    expect(mapScalarRGBA(10.001, opts)[3]).toBe(1);
    // Compared on the raw value, before invert: inverting does not move the cut-off.
    expect(mapScalarRGBA(10, { ...opts, invert: true })[3]).toBe(0);
    expect(mapScalarRGBA(11, { ...opts, invert: true })[3]).toBe(1);
    expect(mapScalarRGBA(10, { ...opts, transparentBelow: false })[3]).toBe(1);
  });
});

describe('ImageLayer.transparentBelow', () => {
  it('defaults off, honours the option, and is a live uniform setter', () => {
    expect(scalarImage(new Float32Array(4)).transparentBelow).toBe(false);
    const layer = scalarImage(new Float32Array(4), { transparentBelow: true });
    expect(layer.transparentBelow).toBe(true);
    let emitted = 0;
    layer.changed.connect(() => emitted++);
    const v = layer.colormapVersion;
    layer.transparentBelow = false;
    expect(emitted).toBe(1);
    expect(layer.colormapVersion).toBe(v); // no LUT rebuild
  });

  it('packs into flags.z next to the window, which moves the cut-off without a rebuild', () => {
    const out = new Float32Array(IMAGE_UNIFORM_FLOATS);
    const layer = scalarImage(new Float32Array(4), {
      contrastLimits: [2, 8],
      gamma: 0.5,
      opacity: 0.75,
      invert: true,
      transparentBelow: true,
    });
    packImageDisplayUniforms(out, layer, 1, false);
    expect(Array.from(out.subarray(20, 28))).toEqual([2, 8, 0.5, 0.75, 0, 1, 1, 0]);
    layer.contrastLimits = [3, 8];
    packImageDisplayUniforms(out, layer, 1 / 2, false);
    expect(out[20]).toBe(1.5); // in sample units
    layer.transparentBelow = false;
    packImageDisplayUniforms(out, layer, 1, true);
    expect([out[24], out[26]]).toEqual([1, 0]);
  });
});

describe('image shader contract (alpha)', () => {
  it('multiplies the LUT alpha in and cuts at climLo before invert', () => {
    const s = IMAGE_COLORMAP_SHADER;
    expect(s).toContain('flags : vec4<f32>,    // isRgba, invert, transparentBelow, 0');
    expect(s).toContain('let below = u.flags.z > 0.5 && raw.r <= climLo;');
    expect(s).toContain('let scalarA = select(lut.a * opacity, 0.0, below);');
    expect(s).toContain('let a = select(scalarA, raw.a * opacity, isRgba);');
    // The cut-off test reads `raw`, not the inverted `t`.
    expect(s.indexOf('let below')).toBeGreaterThan(s.indexOf('t = 1.0 - t'));
  });
});
