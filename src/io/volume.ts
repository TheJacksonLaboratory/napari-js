/**
 * Assembling a downsampled uint8 volume from the z-slices of a {@link TiledSource} — the input
 * {@link VolumeLayer} takes — with bounded concurrency, progress and cancellation.
 */

import type { TiledSource, TypedImageSource } from './texture-source';
import { defaultContrastLimits } from './texture-source';
import { levelDims } from './pyramid';
import { rgbaToScalar, fitWithin, type RgbaPixels, type ScalarWeights } from './decode';
import { chooseStitchLevel, readLevel, DEFAULT_MAX_TEXTURE_DIM } from './stitch';
import { runPool, throwIfAborted } from './pool';

/** Default slices read in parallel by {@link assembleVolume}. */
export const DEFAULT_SLICE_CONCURRENCY = 8;

/** Default tile budget per slice for {@link assembleVolume}: up to 12 × 12 tiles. */
export const DEFAULT_MAX_STITCH_TILES = 144;

/** Options for {@link assembleVolume}. */
export interface AssembleVolumeOptions {
  /** Longest in-plane side of the volume; each slice is downscaled to fit it. */
  maxSide: number;
  /** Slices read in parallel. Default {@link DEFAULT_SLICE_CONCURRENCY}. */
  concurrency?: number;
  /** Tile requests in flight per slice. Default: {@link readLevel}'s. */
  tileConcurrency?: number;
  /** Tile budget per slice. Default {@link DEFAULT_MAX_STITCH_TILES}. */
  maxTiles?: number;
  /** Longest side a slice's stitched level may have. Default {@link DEFAULT_MAX_TEXTURE_DIM}. */
  maxTextureDim?: number;
  /** How an RGBA slice becomes a scalar. Default `'bt601'` (luminance). */
  weights?: ScalarWeights;
  /**
   * For a uint16/float32 source: the `[lo, hi]` window mapped onto 0..255 (clamped). Default
   * the dtype's full range ({@link defaultContrastLimits}).
   */
  contrastLimits?: [number, number];
  /** Called after each slice lands with how many are done out of `total`. */
  onProgress?: (done: number, total: number) => void;
  /** Cancels the assembly: no new slices or tiles are requested and the promise rejects. */
  signal?: AbortSignal;
  /** Passed to {@link readLevel} (decode `ImageBitmap` tiles). */
  decode?: (image: ImageBitmap) => RgbaPixels;
  /** Passed to {@link readLevel}. Default true. */
  closeTiles?: boolean;
}

/** A uint8 scalar volume, x-fastest then y then z — {@link VolumeLayer}'s layout. */
export interface AssembledVolume {
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
}

/**
 * Read slices `zIndices` of `source` (in that order — pass every n-th z to subsample depth)
 * into one uint8 volume whose longest in-plane side is at most `maxSide`.
 *
 * Every slice goes through {@link readLevel} with the same budget, so all of them come from the
 * same pyramid level and have the same size, known before the first tile is fetched. RGBA slices are reduced by `weights`; uint16/float32 ones are windowed by
 * `contrastLimits`. Slices land as they arrive, `onProgress` reporting each.
 */
export async function assembleVolume(
  source: TiledSource,
  zIndices: readonly number[],
  opts: AssembleVolumeOptions,
): Promise<AssembledVolume> {
  const { signal } = opts;
  throwIfAborted(signal);
  const depth = zIndices.length;
  const budget = {
    maxTiles: opts.maxTiles ?? DEFAULT_MAX_STITCH_TILES,
    maxTextureDim: opts.maxTextureDim ?? DEFAULT_MAX_TEXTURE_DIM,
    maxSide: opts.maxSide,
  };
  // The size every slice will have, known before any is fetched: the chosen level, fitted.
  const choice = chooseStitchLevel(source, budget);
  const lvl = levelDims(source.width, source.height, choice.level, source.levelScales);
  const { width, height } = fitWithin(
    lvl.width,
    lvl.height,
    Math.min(budget.maxSide, budget.maxTextureDim),
  );
  const plane = width * height;
  const data = new Uint8Array(plane * depth);
  const limits = opts.contrastLimits ?? defaultContrastLimits(source);
  let done = 0;

  await runPool(
    depth,
    opts.concurrency ?? DEFAULT_SLICE_CONCURRENCY,
    async (p) => {
      const img: TypedImageSource = await readLevel(source, zIndices[p], {
        ...budget,
        concurrency: opts.tileConcurrency,
        signal,
        decode: opts.decode,
        weights: opts.weights,
        closeTiles: opts.closeTiles,
      });
      throwIfAborted(signal);
      toScalar8(img, data.subarray(p * plane, (p + 1) * plane), opts.weights ?? 'bt601', limits);
      done++;
      opts.onProgress?.(done, depth);
    },
    signal,
  );
  return { data, width, height, depth };
}

/** Write `img` into `out` as one uint8 per pixel. */
function toScalar8(
  img: TypedImageSource,
  out: Uint8Array,
  weights: ScalarWeights,
  [lo, hi]: [number, number],
): void {
  const n = img.width * img.height;
  if (img.channels === 4) {
    rgbaToScalar(img.data, img.width, img.height, weights, out);
    return;
  }
  if (img.dtype === 'uint8') {
    out.set(img.data.subarray(0, n) as Uint8Array);
    return;
  }
  const span = hi - lo || 1;
  for (let i = 0; i < n; i++) {
    const t = (img.data[i] - lo) / span;
    out[i] = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
  }
}
