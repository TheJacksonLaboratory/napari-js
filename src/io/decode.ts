/**
 * Decoding of browser images (`ImageBitmap`, canvases) into the typed pixels napari-js works in.
 *
 * The browser half (drawing into a 2D canvas and reading it back) is a thin wrapper; the
 * pixel arithmetic is in pure functions ({@link rgbaToScalar}) so it is unit-tested without a
 * DOM.
 */

import { luminance8 } from '../color/histogram';

/**
 * How an RGBA pixel becomes one scalar: `'r'` takes the red channel (the cheap, exact choice
 * for a grayscale band served as R = G = B), `'bt601'` the Rec.601 luma
 * `0.299·R + 0.587·G + 0.114·B` (the luminance of a colour composite).
 */
export type ScalarWeights = 'r' | 'bt601';

/** A single-channel 8-bit plane, row-major. */
export interface ScalarPlane {
  data: Uint8Array;
  width: number;
  height: number;
}

/** RGBA8 pixels, row-major, as `getImageData` returns them. */
export interface RgbaPixels {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** Anything a 2D canvas can draw that knows its own size. */
export type DrawableImage = (
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLImageElement
) & {
  readonly width: number;
  readonly height: number;
};

/**
 * Reduce RGBA8 pixels to one 8-bit scalar per pixel with `weights` (default `'bt601'`).
 * `'bt601'` rounds to nearest, so a gray pixel (R = G = B = v) maps to exactly `v`. Pure.
 */
export function rgbaToScalar(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  weights: ScalarWeights = 'bt601',
  out: Uint8Array = new Uint8Array(width * height),
): Uint8Array {
  const n = width * height;
  if (rgba.length < n * 4) {
    throw new Error(`rgbaToScalar: expected ${n * 4} RGBA values, got ${rgba.length}.`);
  }
  if (weights === 'r') {
    for (let i = 0; i < n; i++) out[i] = rgba[i * 4];
  } else {
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      out[i] = Math.round(luminance8(rgba[o], rgba[o + 1], rgba[o + 2]));
    }
  }
  return out;
}

/** The size a `width × height` image takes when its longest side is capped at `maxSide`. */
export function fitWithin(
  width: number,
  height: number,
  maxSide?: number,
): { width: number; height: number } {
  const longest = Math.max(width, height, 1);
  const scale = maxSide != null && maxSide > 0 ? Math.min(1, maxSide / longest) : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Draw `image` scaled to `width × height` (default: its own size) into a 2D canvas and read
 * the RGBA8 pixels back. Uses `OffscreenCanvas` when available (also in a worker), else a DOM
 * canvas. Scaling the WHOLE image into the target — rather than drawing at natural size —
 * keeps a downscale from cropping to the top-left corner. Browser-only.
 */
export function decodeImageRGBA(
  image: DrawableImage,
  width: number = image.width,
  height: number = image.height,
): RgbaPixels {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(w, h);
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
  } else {
    throw new Error('decodeImageRGBA: no OffscreenCanvas or document to decode with.');
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('decodeImageRGBA: 2D context unavailable.');
  ctx.drawImage(image, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, width: w, height: h };
}

/** Options for {@link bitmapToScalar}. */
export interface BitmapToScalarOptions {
  /** Cap the longest side (downscaled in the canvas draw). Default: the image's own size. */
  maxSide?: number;
  /** How RGBA becomes a scalar. Default `'bt601'`. */
  weights?: ScalarWeights;
}

/**
 * Decode an image (typically an `ImageBitmap` tile or stitched slice) into a single-channel
 * uint8 plane, optionally downscaled so its longest side is at most `maxSide`. The image is
 * not closed — the caller owns it. Browser-only (needs a 2D canvas).
 */
export function bitmapToScalar(
  image: DrawableImage,
  opts: BitmapToScalarOptions = {},
): ScalarPlane {
  const size = fitWithin(image.width, image.height, opts.maxSide);
  const rgba = decodeImageRGBA(image, size.width, size.height);
  return {
    data: rgbaToScalar(rgba.data, rgba.width, rgba.height, opts.weights ?? 'bt601'),
    width: rgba.width,
    height: rgba.height,
  };
}
