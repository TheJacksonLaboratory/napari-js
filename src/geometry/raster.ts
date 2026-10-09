import type { Ring } from './ring';

/** A row-major raster: `data[y * width + x]`. */
export interface Grid<T extends ArrayLike<number> = ArrayLike<number>> {
  data: T;
  width: number;
  height: number;
}

/** A 0/1 mask covering the rect `[x, x + width) × [y, y + height)` of a larger frame. */
export interface BBoxMask extends Grid<Uint8Array> {
  x: number;
  y: number;
}

/** A rect in the polygon's frame. */
export interface RasterBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Options for {@link rasterizePolygon}. */
export interface RasterizeOptions {
  /**
   * A window (e.g. the image) to clip the mask to. Applied when `clip` is true, or as the
   * fallback when the polygon's own bbox exceeds `maxPixels`.
   */
  bounds?: RasterBounds;
  /** Always clip to `bounds`. Default false: the mask covers the polygon's full extent. */
  clip?: boolean;
  /** Largest mask allocated. Default 4096². Beyond it the mask is clipped to `bounds`, or throws. */
  maxPixels?: number;
}

/** Default {@link RasterizeOptions.maxPixels}. */
export const RASTER_MAX_PIXELS = 4096 * 4096;

/**
 * Scanline-fill a polygon (outer ring minus its holes) into a mask over its bounding box.
 *
 * Pixel `(px, py)` covers `[px, px + 1) × [py, py + 1)` and is set when its centre
 * `(px + 0.5, py + 0.5)` is inside — the rule under which the pixel-edge rings
 * {@link traceContours} returns rasterize back to exactly the pixels they were traced from.
 *
 * The mask spans the polygon's full extent (its origin may be negative), so a region partly
 * outside an image keeps that part. Null when the polygon has < 3 vertices or covers no pixel
 * centre's row/column range. Pure.
 */
export function rasterizePolygon(
  outer: Ring,
  holes?: readonly Ring[],
  opts: RasterizeOptions = {},
): BBoxMask | null {
  const n = outer.length >> 1;
  if (n < 3) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = outer[i * 2];
    const y = outer[i * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  let x0 = Math.floor(minX);
  let y0 = Math.floor(minY);
  let x1 = Math.ceil(maxX);
  let y1 = Math.ceil(maxY);
  const maxPixels = opts.maxPixels ?? RASTER_MAX_PIXELS;
  const b = opts.bounds;
  if (b && (opts.clip || (x1 - x0) * (y1 - y0) > maxPixels)) {
    x0 = Math.max(x0, Math.floor(b.x));
    y0 = Math.max(y0, Math.floor(b.y));
    x1 = Math.min(x1, Math.ceil(b.x + b.width));
    y1 = Math.min(y1, Math.ceil(b.y + b.height));
  }
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) return null;
  if (width * height > maxPixels) {
    throw new RangeError(
      `rasterizePolygon: a ${width}×${height} mask exceeds maxPixels (${maxPixels}); pass bounds.`,
    );
  }
  const data = new Uint8Array(width * height);
  fillRing(outer, 1, data, x0, y0, width, height);
  if (holes) for (const h of holes) fillRing(h, 0, data, x0, y0, width, height);
  return { data, width, height, x: x0, y: y0 };
}

/** Write `value` into every pixel of the mask whose centre is inside `ring` (even-odd). */
function fillRing(
  ring: Ring,
  value: number,
  data: Uint8Array,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): void {
  const m = ring.length >> 1;
  if (m < 3) return;
  const xs: number[] = [];
  for (let py = 0; py < bh; py++) {
    const y = by + py + 0.5;
    xs.length = 0;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const yi = ring[i * 2 + 1];
      const yj = ring[j * 2 + 1];
      // Half-open in y, so a vertex exactly on the scanline is counted once.
      if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
        const xi = ring[i * 2];
        xs.push(xi + ((y - yi) / (yj - yi)) * (ring[j * 2] - xi));
      }
    }
    xs.sort((a, b) => a - b);
    const row = py * bw;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // Centres px + 0.5 in [xs[k], xs[k + 1]).
      const start = Math.max(0, Math.ceil(xs[k] - 0.5 - bx));
      const end = Math.min(bw, Math.ceil(xs[k + 1] - 0.5 - bx));
      for (let px = start; px < end; px++) data[row + px] = value;
    }
  }
}

/** Options for {@link floodFill}. */
export interface FloodFillOptions {
  /** Interleaved channels per pixel in `data`. Default 1. */
  channels?: number;
  /**
   * Accept a pixel when `|value − seed| ≤ tolerance` in every channel (one number for all, or
   * one per channel). Default 0: exact match.
   */
  tolerance?: number | readonly number[];
  /** 4 (default) or 8-connected growth. */
  connectivity?: 4 | 8;
}

/**
 * Fixed-range flood fill (the Labels fill bucket / a magic wand's growth step): the pixels
 * connected to `(seedX, seedY)` whose value is within `tolerance` of the SEED's (not of their
 * neighbour's, so the fill cannot creep along a gradient). Returns a 0/1 mask the size of the
 * grid — all zeros when the seed is outside it. Pure.
 */
export function floodFill(
  grid: Grid,
  seedX: number,
  seedY: number,
  opts: FloodFillOptions = {},
): Uint8Array {
  const { width: w, height: h, data } = grid;
  const c = opts.channels ?? 1;
  const mask = new Uint8Array(w * h);
  const sx = Math.round(seedX);
  const sy = Math.round(seedY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return mask;
  const tol = new Float64Array(c);
  for (let k = 0; k < c; k++) {
    const t = opts.tolerance ?? 0;
    tol[k] = typeof t === 'number' ? t : (t[k] ?? 0);
  }
  const seed = new Float64Array(c);
  for (let k = 0; k < c; k++) seed[k] = data[(sy * w + sx) * c + k];
  const accept = (i: number): boolean => {
    for (let k = 0; k < c; k++) if (Math.abs(data[i * c + k] - seed[k]) > tol[k]) return false;
    return true;
  };

  if ((opts.connectivity ?? 4) === 8) {
    const stack = [sy * w + sx];
    mask[sy * w + sx] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!mask[j] && accept(j)) {
            mask[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    return mask;
  }

  // 4-connected: scanline fill (fill a run, then seed the rows above and below it).
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const row = y * w;
    if (mask[row + x] || !accept(row + x)) continue;
    let xl = x;
    while (xl > 0 && !mask[row + xl - 1] && accept(row + xl - 1)) xl--;
    let xr = x;
    while (xr < w - 1 && !mask[row + xr + 1] && accept(row + xr + 1)) xr++;
    for (let xi = xl; xi <= xr; xi++) mask[row + xi] = 1;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue;
      for (let xi = xl; xi <= xr; xi++) if (!mask[ny * w + xi]) stack.push(xi, ny);
    }
  }
  return mask;
}
