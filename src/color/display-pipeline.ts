import type { Colormap, RGB } from './colormap';

/**
 * Floor on the contrast-window width, so a degenerate window (`hi === lo`) doesn't divide by
 * zero. A shader whose CPU reference is {@link windowGamma} must use this same value, or the
 * two map a valid narrow window differently.
 */
export const WINDOW_EPSILON = 1e-8;

/**
 * CPU reference for the scalar display math the `image-colormap` WGSL shader performs:
 * window → invert → gamma. Returns the normalized LUT coordinate `t` in 0..1. Kept pure and
 * tested so the shader has a ground truth (see docs/04) and so histograms/readback can reuse
 * the exact same math. `value` and the clim are in the same units.
 */
export function windowGamma(
  value: number,
  climLo: number,
  climHi: number,
  gamma: number,
  invert: boolean,
): number {
  const denom = Math.max(climHi - climLo, WINDOW_EPSILON);
  let t = clamp01((value - climLo) / denom);
  if (invert) t = 1 - t;
  return Math.pow(t, gamma);
}

/** Map a scalar value through window/gamma and a colormap to linear RGB. */
export function mapScalar(
  value: number,
  opts: { climLo: number; climHi: number; gamma: number; invert: boolean; colormap: Colormap },
): RGB {
  return opts.colormap.sample(
    windowGamma(value, opts.climLo, opts.climHi, opts.gamma, opts.invert),
  );
}

/**
 * CPU reference for a scalar {@link ImageLayer} pixel, alpha included: window → invert →
 * gamma → colormap, with the colormap's alpha ({@link Colormap.sampleRGBA}) and, under
 * `transparentBelow`, alpha 0 for every value at or below `climLo` (before invert). Returns
 * straight (not premultiplied) RGBA before the layer opacity. The image shader's scalar path.
 */
export function mapScalarRGBA(
  value: number,
  opts: {
    climLo: number;
    climHi: number;
    gamma: number;
    invert: boolean;
    colormap: Colormap;
    transparentBelow?: boolean;
  },
): [number, number, number, number] {
  const c = opts.colormap.sampleRGBA(
    windowGamma(value, opts.climLo, opts.climHi, opts.gamma, opts.invert),
  );
  if (opts.transparentBelow && value <= opts.climLo) c[3] = 0;
  return c;
}

/**
 * Additive composite of premultiplied RGB contributions (channels with `blending: 'additive'`
 * over a black background), clamped to 1 — the CPU reference for multi-channel fluorescence.
 */
export function additiveComposite(colors: readonly RGB[]): RGB {
  const out: RGB = [0, 0, 0];
  for (const c of colors) {
    out[0] += c[0];
    out[1] += c[1];
    out[2] += c[2];
  }
  return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])];
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
