import type { Colormap } from './colormap';

/** Default LUT resolution: 256 entries, the napari/OpenGL convention. */
export const LUT_SIZE = 256;

/**
 * Build an `size`×1 RGBA8 lookup table from a colormap by sampling at evenly spaced
 * positions. Suitable for upload as a `rgba8unorm` texture sampled by the fragment shader.
 * Alpha comes from the colormap's stops ({@link Colormap.sampleRGBA}): 255 for an RGB-only
 * colormap. Pure and GPU-free (unit-tested).
 */
export function buildLut(colormap: Colormap, size: number = LUT_SIZE) {
  const lut = new Uint8Array(size * 4);
  const last = size - 1;
  for (let i = 0; i < size; i++) {
    const [r, g, b, a] = colormap.sampleRGBA(last === 0 ? 0 : i / last);
    const o = i * 4;
    lut[o] = to8(r);
    lut[o + 1] = to8(g);
    lut[o + 2] = to8(b);
    lut[o + 3] = to8(a);
  }
  return lut;
}

function to8(v: number): number {
  const x = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return Math.round(x * 255);
}
