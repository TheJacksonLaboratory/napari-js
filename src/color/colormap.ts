import { VIRIDIS_LUT, MAGMA_LUT, INFERNO_LUT } from './matplotlib-luts';

export type RGB = [number, number, number];

/**
 * A control point in a colormap: normalized position `t` (0..1) → linear RGB, or RGBA, in
 * 0..1. A stop without alpha is opaque. Alpha is interpolated like the channels and carried
 * in the LUT; {@link ImageLayer} honours it (a scalar pixel's alpha is the LUT's alpha ×
 * opacity), the other colormapped layers use the RGB only.
 */
export interface ColorStop {
  t: number;
  color: RGB | [number, number, number, number];
}

/**
 * A colormap defined by sorted control points, linearly interpolated. Mirrors napari's
 * `Colormap` concept; sampled into a LUT texture for the GPU (see ./lut.ts).
 */
export class Colormap {
  readonly stops: ColorStop[];

  constructor(
    readonly name: string,
    stops: ColorStop[],
  ) {
    if (stops.length < 2) {
      throw new Error(`Colormap "${name}" needs at least two stops.`);
    }
    this.stops = [...stops].sort((p, q) => p.t - q.t);
  }

  /** Sample the colormap at `t` (clamped to 0..1), returning linear RGB. */
  sample(t: number): RGB {
    const [r, g, b] = this.sampleRGBA(t);
    return [r, g, b];
  }

  /**
   * Sample the colormap at `t` (clamped to 0..1), returning linear RGB plus alpha, interpolated
   * between the stops (a stop without alpha counts as 1). What {@link buildLut} stores.
   */
  sampleRGBA(t: number): [number, number, number, number] {
    const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
    const { stops } = this;
    if (x <= stops[0].t) return rgba(stops[0].color);
    const last = stops[stops.length - 1];
    if (x >= last.t) return rgba(last.color);
    for (let i = 1; i < stops.length; i++) {
      const hi = stops[i];
      if (x <= hi.t) {
        const lo = stops[i - 1];
        const span = hi.t - lo.t || 1;
        const f = (x - lo.t) / span;
        const a0 = lo.color[3] ?? 1;
        const a1 = hi.color[3] ?? 1;
        return [
          lo.color[0] + (hi.color[0] - lo.color[0]) * f,
          lo.color[1] + (hi.color[1] - lo.color[1]) * f,
          lo.color[2] + (hi.color[2] - lo.color[2]) * f,
          a0 + (a1 - a0) * f,
        ];
      }
    }
    return rgba(last.color);
  }
}

function rgba(c: ColorStop['color']): [number, number, number, number] {
  return [c[0], c[1], c[2], c[3] ?? 1];
}

function ramp(name: string, color: RGB): Colormap {
  return new Colormap(name, [
    { t: 0, color: [0, 0, 0] },
    { t: 1, color },
  ]);
}

// Single-hue ramps (napari's red/green/blue/gray).
export const GRAY = ramp('gray', [1, 1, 1]);
export const RED = ramp('red', [1, 0, 0]);
export const GREEN = ramp('green', [0, 1, 0]);
export const BLUE = ramp('blue', [0, 0, 1]);

/**
 * Build a `Colormap` from a flat RGB lookup table — `[r0, g0, b0, r1, g1, b1, …]`, bytes
 * 0..`maxValue` (default 255) — with evenly spaced stops (`t = i / (n - 1)`). This is the form
 * the exact matplotlib tables in `napari-js/colormaps` take (`Uint8Array(768)`); sampling the
 * result at `i / (n - 1)` returns entry `i` exactly, so `buildLut` reproduces the table.
 */
export function lutColormap(name: string, lut: ArrayLike<number>, maxValue = 255): Colormap {
  const n = Math.floor(lut.length / 3);
  if (n < 2 || lut.length % 3 !== 0) {
    throw new Error(`lutColormap("${name}") needs 3·n RGB values with n >= 2, got ${lut.length}.`);
  }
  const m = maxValue || 255;
  const stops: ColorStop[] = new Array(n);
  for (let i = 0; i < n; i++) {
    stops[i] = { t: i / (n - 1), color: [lut[i * 3] / m, lut[i * 3 + 1] / m, lut[i * 3 + 2] / m] };
  }
  return new Colormap(name, stops);
}

// Perceptual maps: matplotlib's exact 256-entry tables (≈1 KB each). Every other matplotlib map
// is in the opt-in `napari-js/colormaps` subpath.
export const VIRIDIS = /* @__PURE__ */ lutColormap('viridis', VIRIDIS_LUT);
export const MAGMA = /* @__PURE__ */ lutColormap('magma', MAGMA_LUT);
export const INFERNO = /* @__PURE__ */ lutColormap('inferno', INFERNO_LUT);

export const NAMED_COLORMAPS: Record<string, Colormap> = {
  gray: GRAY,
  grey: GRAY,
  red: RED,
  green: GREEN,
  blue: BLUE,
  viridis: VIRIDIS,
  magma: MAGMA,
  inferno: INFERNO,
};

/** Resolve a colormap name or pass through a `Colormap`. Throws on an unknown name. */
export function resolveColormap(cmap: Colormap | string): Colormap {
  if (cmap instanceof Colormap) return cmap;
  const found = NAMED_COLORMAPS[cmap.toLowerCase()];
  if (!found) {
    throw new Error(
      `Unknown colormap "${cmap}". Known: ${Object.keys(NAMED_COLORMAPS).join(', ')}.`,
    );
  }
  return found;
}

/**
 * Build a `Colormap` from a lookup table of RGB triples (bytes 0..`maxValue`, default 255),
 * with evenly spaced stops (`t = i / (len - 1)`). Useful for an arbitrary LUT produced outside
 * the named-colormap registry — e.g. a UI colormap picker that yields 256 RGB rows, or a reversed
 * ramp. Needs at least two entries.
 */
export function colormapFromLut(
  name: string,
  lut: ReadonlyArray<readonly [number, number, number]>,
  maxValue = 255,
): Colormap {
  if (lut.length < 2) {
    throw new Error(`colormapFromLut("${name}") needs at least two LUT entries.`);
  }
  const m = maxValue || 255;
  const n = lut.length;
  const stops: ColorStop[] = lut.map((c, i) => ({
    t: i / (n - 1),
    color: [c[0] / m, c[1] / m, c[2] / m] as RGB,
  }));
  return new Colormap(name, stops);
}

/**
 * Build a black→`hex` ramp `Colormap` — a channel "tint" for additive multichannel compositing
 * (fluorescence). Accepts `#rgb` / `#rrggbb` (the leading `#` is optional); unparseable channels
 * fall back to 0, and an empty/missing value defaults to white.
 */
export function tintColormap(hex: string): Colormap {
  const h = (hex || '#ffffff').replace('#', '');
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return new Colormap(`tint-${full}`, [
    { t: 0, color: [0, 0, 0] },
    { t: 1, color: [r / 255, g / 255, b / 255] },
  ]);
}

/**
 * Reverse a colormap's ramp (a flipped LUT) — `t → 1 - t` on every stop. Resolves a named
 * colormap to its stops first. Useful to emulate invert / reverse-scale where a layer has no
 * per-layer invert flag (e.g. {@link VolumeLayer}).
 */
export function reverseColormap(cmap: Colormap | string): Colormap {
  const c = cmap instanceof Colormap ? cmap : resolveColormap(cmap);
  return new Colormap(
    `${c.name}-reversed`,
    c.stops.map((s) => ({ t: 1 - s.t, color: s.color })),
  );
}
