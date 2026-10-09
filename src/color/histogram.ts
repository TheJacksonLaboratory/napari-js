/** A binned intensity histogram over a value range. */
export interface Histogram {
  counts: Uint32Array;
  bins: number;
  min: number;
  max: number;
}

/** Rec.601 luma of an 8-bit RGB triple (0..255). */
export function luminance8(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Histogram of per-pixel luminance over RGBA8 data (alpha ignored), `bins` bins across the
 * 0..255 range. Pure and GPU-free (unit-tested); the viewer feeds it readback pixels.
 */
export function histogramRGBA(data: Uint8ClampedArray | Uint8Array, bins: number): Histogram {
  if (bins < 1) throw new Error('histogram bins must be >= 1.');
  const counts = new Uint32Array(bins);
  const scale = bins / 256;
  for (let i = 0; i + 3 < data.length; i += 4) {
    const l = luminance8(data[i], data[i + 1], data[i + 2]);
    let b = Math.floor(l * scale);
    if (b >= bins) b = bins - 1;
    else if (b < 0) b = 0;
    counts[b]++;
  }
  return { counts, bins, min: 0, max: 255 };
}

/**
 * Histogram of scalar samples over `[min, max]` into `bins` bins (values clamped into range).
 * Used for per-channel, native-bit-depth histograms (e.g. a uint16 image channel). Pure.
 */
export function histogramScalar(
  data: ArrayLike<number>,
  bins: number,
  min: number,
  max: number,
): Histogram {
  if (bins < 1) throw new Error('histogram bins must be >= 1.');
  const counts = new Uint32Array(bins);
  const range = max - min || 1;
  for (let i = 0; i < data.length; i++) {
    let b = Math.floor(((data[i] - min) / range) * bins);
    if (b >= bins) b = bins - 1;
    else if (b < 0) b = 0;
    counts[b]++;
  }
  return { counts, bins, min, max };
}

/** Options for {@link autoContrastLimits}. */
export interface AutoContrastOptions {
  /**
   * Ignore a first or last bin that is larger than its neighbour (unscanned padding, a clipped
   * background) so it does not pull the window. Default true.
   */
  dropDominantEnds?: boolean;
}

/**
 * Saturation-based auto contrast: the `[lo, hi]` window that clips about `saturation` (a
 * fraction, clamped to 0..0.5) of the counted pixels at EACH end of the histogram. `lo` is the
 * lower edge of the first bin the cumulative count passes the cut in, `hi` the upper edge of the
 * last, so whole bins are kept. Falls back to the histogram's `[min, max]` when it is empty.
 * Pure.
 */
export function autoContrastLimits(
  histogram: Histogram,
  saturation: number,
  opts: AutoContrastOptions = {},
): [number, number] {
  const { min, max } = histogram;
  const counts = Array.from(histogram.counts);
  const n = counts.length;
  if (n === 0) return [min, max];
  if (opts.dropDominantEnds ?? true) {
    if (n > 2 && counts[0] > counts[1]) counts[0] = 0;
    if (n > 2 && counts[n - 1] > counts[n - 2]) counts[n - 1] = 0;
  }
  let total = 0;
  for (const c of counts) total += c;
  if (total <= 0) return [min, max];
  const cut = total * Math.max(0, Math.min(0.5, saturation));
  const width = (max - min) / n;
  let lo = 0;
  for (let acc = 0; lo < n - 1; lo++) {
    acc += counts[lo];
    if (acc > cut) break;
  }
  let hi = n - 1;
  for (let acc = 0; hi > 0; hi--) {
    acc += counts[hi];
    if (acc > cut) break;
  }
  if (hi < lo) hi = lo;
  return [min + lo * width, min + (hi + 1) * width];
}
