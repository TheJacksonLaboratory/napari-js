/**
 * Reading a whole pyramid level of a {@link TiledSource} into one in-memory image — what a
 * host needs for anything that is not the streaming 2D view: a 3D volume plane, a surface
 * height field, a navigator thumbnail, a histogram sample.
 *
 * Built on the same level geometry as the streaming view ({@link selectLevel},
 * {@link levelDims}, {@link tileGrid}), so the two paths cannot disagree about which pixels a
 * level holds.
 */

import { levelDims, selectLevel, tileGrid } from './pyramid';
import type { PixelChunk, PixelDtype, TiledSource, TypedImageSource } from './texture-source';
import {
  decodeImageRGBA,
  fitWithin,
  rgbaToScalar,
  type RgbaPixels,
  type ScalarWeights,
} from './decode';
import { abortable, runPool, throwIfAborted } from './pool';

/** WebGPU's default `maxTextureDimension2D`: a stitched image's longest side must fit it. */
export const DEFAULT_MAX_TEXTURE_DIM = 8192;

/**
 * Default tile requests in flight per stitched level. Firing a whole grid at once (hundreds of
 * requests for a large level) overwhelms a tile server; a small pool keeps the pipe full.
 */
export const DEFAULT_TILE_CONCURRENCY = 6;

/** The pyramid geometry {@link chooseStitchLevel} reads. */
export type PyramidGeometry = Pick<
  TiledSource,
  'width' | 'height' | 'tileSize' | 'levels' | 'levelScales'
>;

/** Budget for {@link chooseStitchLevel}. */
export interface StitchBudget {
  /** Most tiles one stitched level may take (`cols × rows`). */
  maxTiles: number;
  /** Longest side the stitched level may have. Default {@link DEFAULT_MAX_TEXTURE_DIM}. */
  maxTextureDim?: number;
  /**
   * The longest side the caller will downscale to. Levels finer than needed for it are skipped:
   * the search starts at the coarsest level that still has at least `maxSide` pixels on its
   * longest side (by {@link selectLevel}), so a 256² thumbnail of a 100k² slide reads a few
   * tiles, not the budget's worth.
   */
  maxSide?: number;
}

/** The level {@link chooseStitchLevel} picked, and its size and tile grid. */
export interface StitchLevelChoice {
  level: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** False when no level is within budget and this is the coarsest one, used anyway. */
  fits: boolean;
}

/**
 * Pick the level to stitch: the finest one whose tile grid fits `maxTiles` and whose longest
 * side fits `maxTextureDim`, but no finer than `maxSide` needs. When no level fits, the
 * coarsest level with `fits: false`. Pure.
 */
export function chooseStitchLevel(
  source: PyramidGeometry,
  budget: StitchBudget,
): StitchLevelChoice {
  const levels = Math.max(1, source.levels);
  const maxDim = budget.maxTextureDim ?? DEFAULT_MAX_TEXTURE_DIM;
  const longest = Math.max(source.width, source.height, 1);
  const start =
    budget.maxSide != null && budget.maxSide > 0
      ? selectLevel(budget.maxSide / longest, levels, source.levelScales)
      : 0;
  let choice: StitchLevelChoice | null = null;
  for (let level = start; level < levels; level++) {
    const d = levelDims(source.width, source.height, level, source.levelScales);
    const g = tileGrid(source.width, source.height, level, source.tileSize, source.levelScales);
    const fits = g.cols * g.rows <= budget.maxTiles && Math.max(d.width, d.height) <= maxDim;
    choice = { level, width: d.width, height: d.height, cols: g.cols, rows: g.rows, fits };
    if (fits) return choice;
  }
  return choice!;
}

/** Options for {@link readLevel}. */
export interface ReadLevelOptions extends StitchBudget {
  /** Tile requests in flight. Default {@link DEFAULT_TILE_CONCURRENCY}. */
  concurrency?: number;
  /** Cancels the read: no new tiles are requested and the promise rejects with the reason. */
  signal?: AbortSignal;
  /**
   * How an `ImageBitmap` tile becomes RGBA8 pixels. Default: draw it into a 2D canvas
   * ({@link decodeImageRGBA}). Override to decode in a worker, or with a fake in tests.
   */
  decode?: (image: ImageBitmap) => RgbaPixels;
  /** For a single-channel source with `ImageBitmap` tiles: how RGBA becomes a scalar. Default `'bt601'`. */
  weights?: ScalarWeights;
  /**
   * Close each `ImageBitmap` tile once it is decoded. Default true: `readLevel` is the tile's
   * only consumer. Pass false for a source that caches and re-serves its bitmaps.
   */
  closeTiles?: boolean;
}

/** A stitched level: the pixels, plus which level they came from. */
export interface StitchedImage extends TypedImageSource {
  /** The pyramid level that was read. */
  readonly level: number;
  /** False when no level was within budget and the coarsest one was read anyway. */
  readonly fits: boolean;
}

/**
 * Read slice `z` of `source` into one in-memory image.
 *
 * Picks the level with {@link chooseStitchLevel}, fetches its tile grid with at most
 * `concurrency` requests in flight, stitches the tiles (edge tiles may be smaller, and are
 * clipped to the level if larger), and box-downscales the result when its longest side exceeds
 * `maxSide` or `maxTextureDim`. The result has the source's `channels` and `dtype`.
 *
 * Tiles may be typed arrays (in the source's channels/dtype) or `ImageBitmap`s (uint8 sources
 * only), which are decoded with `decode` — RGBA for a 4-channel source, a scalar by `weights`
 * for a single-channel one.
 */
export async function readLevel(
  source: TiledSource,
  z: number,
  opts: ReadLevelOptions,
): Promise<StitchedImage> {
  const { signal } = opts;
  throwIfAborted(signal);
  const choice = chooseStitchLevel(source, opts);
  const { level, width, height, cols, rows } = choice;
  const channels = source.channels;
  const out = allocate(source.dtype, width * height * channels);
  const ts = source.tileSize;
  const decode = opts.decode ?? ((image: ImageBitmap) => decodeImageRGBA(image));
  const closeTiles = opts.closeTiles ?? true;
  const close = (chunk: PixelChunk): void => {
    if (closeTiles && !ArrayBuffer.isView(chunk.data)) chunk.data.close?.();
  };

  await runPool(
    cols * rows,
    opts.concurrency ?? DEFAULT_TILE_CONCURRENCY,
    async (i) => {
      const col = i % cols;
      const row = (i - col) / cols;
      const chunk = await abortable(
        source.fetchTile({ level, col, row, z }, signal),
        signal,
        close,
      );
      throwIfAborted(signal);
      try {
        const pixels = tilePixels(chunk, source, decode, opts.weights ?? 'bt601');
        blit(pixels, chunk.width, chunk.height, out, width, height, col * ts, row * ts, channels);
      } finally {
        close(chunk);
      }
    },
    signal,
  );

  const target = fitWithin(
    width,
    height,
    Math.min(opts.maxSide ?? Infinity, opts.maxTextureDim ?? DEFAULT_MAX_TEXTURE_DIM),
  );
  const image: TypedImageSource = {
    kind: 'typed',
    width,
    height,
    channels,
    dtype: source.dtype,
    data: out,
  };
  const sized =
    target.width < width || target.height < height
      ? downscaleImage(image, target.width, target.height)
      : image;
  return { ...sized, level, fits: choice.fits };
}

/**
 * Box-filter (area-average) downscale of typed pixels to `width × height`. Each output pixel
 * averages the source pixels its footprint covers; integer dtypes round to nearest. Returns
 * the input unchanged when the target is not smaller. Pure.
 */
export function downscaleImage(
  src: TypedImageSource,
  width: number,
  height: number,
): TypedImageSource {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (w >= src.width && h >= src.height) return src;
  const c = src.channels;
  const sw = src.width;
  const sx = sw / w;
  const sy = src.height / h;
  const xs0 = new Int32Array(w);
  const xs1 = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    xs0[x] = Math.min(sw - 1, Math.floor(x * sx));
    xs1[x] = Math.max(xs0[x] + 1, Math.min(sw, Math.floor((x + 1) * sx)));
  }
  const out = allocate(src.dtype, w * h * c);
  const round = src.dtype !== 'float32';
  const acc = new Float64Array(w * c);
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(src.height - 1, Math.floor(y * sy));
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * sy)));
    acc.fill(0);
    for (let yy = y0; yy < y1; yy++) {
      const rowBase = yy * sw;
      for (let x = 0; x < w; x++) {
        for (let xx = xs0[x]; xx < xs1[x]; xx++) {
          const s = (rowBase + xx) * c;
          for (let k = 0; k < c; k++) acc[x * c + k] += src.data[s + k];
        }
      }
    }
    for (let x = 0; x < w; x++) {
      const n = (y1 - y0) * (xs1[x] - xs0[x]);
      for (let k = 0; k < c; k++) {
        const v = acc[x * c + k] / n;
        out[(y * w + x) * c + k] = round ? Math.round(v) : v;
      }
    }
  }
  return { kind: 'typed', width: w, height: h, channels: c, dtype: src.dtype, data: out };
}

export function allocate(
  dtype: PixelDtype,
  length: number,
): Uint8Array | Uint16Array | Float32Array {
  if (dtype === 'uint16') return new Uint16Array(length);
  if (dtype === 'float32') return new Float32Array(length);
  return new Uint8Array(length);
}

/** A tile's pixels in the source's channel layout (decoding a bitmap tile). */
function tilePixels(
  chunk: PixelChunk,
  source: TiledSource,
  decode: (image: ImageBitmap) => RgbaPixels,
  weights: ScalarWeights,
): ArrayLike<number> {
  if (ArrayBuffer.isView(chunk.data)) {
    const need = chunk.width * chunk.height * source.channels;
    if (chunk.data.length < need) {
      throw new Error(
        `readLevel: tile has ${chunk.data.length} values, expected ${need} ` +
          `(${chunk.width}×${chunk.height}×${source.channels}).`,
      );
    }
    return chunk.data;
  }
  if (source.dtype !== 'uint8') {
    throw new Error(`readLevel: an ImageBitmap tile needs a uint8 source, not ${source.dtype}.`);
  }
  const rgba = decode(chunk.data);
  if (rgba.width !== chunk.width || rgba.height !== chunk.height) {
    throw new Error(
      `readLevel: decoded tile is ${rgba.width}×${rgba.height}, chunk says ` +
        `${chunk.width}×${chunk.height}.`,
    );
  }
  return source.channels === 4
    ? rgba.data
    : rgbaToScalar(rgba.data, rgba.width, rgba.height, weights);
}

/** Copy a `tw × th` tile into `out` at `(x0, y0)`, clipped to the `width × height` level. */
function blit(
  tile: ArrayLike<number>,
  tw: number,
  th: number,
  out: Uint8Array | Uint16Array | Float32Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  c: number,
): void {
  const cw = Math.min(tw, width - x0);
  const ch = Math.min(th, height - y0);
  if (cw <= 0 || ch <= 0) return;
  const typed = ArrayBuffer.isView(tile) ? (tile as Uint8Array) : null;
  for (let y = 0; y < ch; y++) {
    const s = y * tw * c;
    const d = ((y0 + y) * width + x0) * c;
    if (typed) out.set(typed.subarray(s, s + cw * c), d);
    else for (let i = 0; i < cw * c; i++) out[d + i] = tile[s + i];
  }
}
