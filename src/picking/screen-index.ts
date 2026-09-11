import { nearestProjectedIndex, type ProjectedPickOptions } from './pick';
import type { ProjectedPoints } from './project';

/**
 * A uniform grid over the canvas, so picking does not scan the whole cloud.
 *
 * {@link nearestProjectedIndex} is linear, which is the right shape for a few thousand
 * points and the wrong one for a few million: measured at 3.7M projected points, one scan
 * took ~14 ms, and it runs on every pointer move — most of a frame's budget spent deciding
 * what is under the cursor, before the tooltip or the render.
 *
 * The grid is rebuilt when the PROJECTION changes, not when the pointer moves. Measured at
 * 3.7M points: a linear pick is 12.6 ms and an indexed one 0.066 ms — about 190x — against
 * a 43.5 ms build.
 *
 * BUILD IT LAZILY, on the first pick after the projection changed, not eagerly when the
 * camera moves. Those numbers only pay off that way round. An orbit drag changes the camera
 * every frame, so rebuilding eagerly would spend 43.5 ms per frame to serve picks the user
 * is not making — strictly worse than the linear scan it replaces. Deferred, the rebuild
 * happens once when the drag stops and the pointer next moves, and every pick after that is
 * essentially free.
 *
 * Counting sort into a flat CSR-style pair of arrays rather than an array of arrays: at
 * these sizes a few million small arrays is its own performance problem, and two typed
 * arrays are one allocation each.
 */

/** Smallest cell edge in pixels. Below this the grid costs more in cells than it saves. */
const MIN_CELL = 8;

/**
 * How far outside the canvas a marker's CENTRE may sit and still be indexed.
 *
 * A marker has size. Its centre can be off the canvas while part of it is drawn — and
 * therefore pickable — so an index that keeps only centres inside the viewport disagrees
 * with the linear picker along every edge. Default 32 px covers the marker sizes this
 * layer draws; a caller using larger ones passes its own.
 */
const DEFAULT_MAX_REACH = 32;

export interface ScreenIndexOptions {
  /**
   * Cell edge in pixels. About the largest marker radius in play: the query visits every
   * cell within the search radius, so a cell much smaller than the radius visits many and
   * a cell much larger makes each one a linear scan.
   */
  cell?: number;
  /**
   * The largest distance a drawn marker can reach from its centre, in pixels. Centres
   * within this margin of the canvas are indexed; anything further out cannot be picked.
   */
  maxReach?: number;
}

export class ScreenIndex {
  /** Cell edge in screen pixels. */
  readonly cell: number;

  readonly cols: number;

  readonly rows: number;

  /** Margin in pixels by which the grid overhangs the canvas on every side. */
  readonly margin: number;

  /** Grid origin in screen coordinates — `-margin`, so cell 0 starts outside the canvas. */
  private readonly originX: number;

  private readonly originY: number;

  /** Start of each cell's slice in {@link items}; length `cols*rows + 1`. */
  private readonly starts: Int32Array;

  /** Point indices, grouped by cell. */
  private readonly items: Int32Array;

  private readonly screen: Float32Array;

  private readonly depth: Float32Array | null;

  /**
   * The grid OVERHANGS the canvas by {@link ScreenIndexOptions.maxReach} on every side.
   *
   * Without the overhang this disagreed with the linear picker along the edges: a marker
   * centred at x = -2 with a radius of 6 is drawn, and is under a cursor at x = 1, but its
   * centre is off the canvas and a viewport-sized grid dropped it. Worse, whether a given
   * edge was affected depended on arithmetic — `ceil(600/32)` overhangs to 608 and hid the
   * bug on that edge, while `ceil(800/32)` is exact and exposed it. An index that is
   * accidentally correct on two edges out of four is the harder kind of wrong.
   *
   * So the origin starts at `-margin` and the grid is sized to cover the canvas plus the
   * margin on both sides. Every point a marker could reach the cursor from is in a real
   * cell, and nothing depends on whether the viewport divides evenly by the cell size.
   */
  constructor(projected: ProjectedPoints, vw: number, vh: number, opts: ScreenIndexOptions = {}) {
    this.screen = projected.screen;
    this.depth = projected.depth ?? null;
    this.cell = Math.max(MIN_CELL, opts.cell ?? 32);
    this.margin = Math.max(0, opts.maxReach ?? DEFAULT_MAX_REACH);
    this.originX = -this.margin;
    this.originY = -this.margin;
    this.cols = Math.max(1, Math.ceil((vw + 2 * this.margin) / this.cell));
    this.rows = Math.max(1, Math.ceil((vh + 2 * this.margin) / this.cell));

    const n = this.screen.length >> 1;
    const cellCount = this.cols * this.rows;
    const counts = new Int32Array(cellCount + 1);

    // Pass 1: count. Points beyond the margin, and NaN ones, are not indexed — no marker
    // reaches the cursor from there, so leaving them out shrinks the grid.
    const cellOf = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(this.screen[i * 2], this.screen[i * 2 + 1]);
      if (c < 0) continue;
      cellOf[i] = c;
      counts[c + 1]++;
    }
    for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
    this.starts = counts;

    // Pass 2: place. `cursor` walks a copy so `starts` keeps the slice boundaries.
    const cursor = Int32Array.from(counts.subarray(0, cellCount));
    this.items = new Int32Array(counts[cellCount]);
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      if (c < 0) continue;
      this.items[cursor[c]++] = i;
    }
  }

  /** How many points the grid actually holds — the rest were off screen or NaN. */
  get indexed(): number {
    return this.items.length;
  }

  private cellIndex(x: number, y: number): number {
    const gx = x - this.originX;
    const gy = y - this.originY;
    // NaN fails both comparisons, so an unprojected point is excluded here.
    if (!(gx >= 0) || !(gy >= 0)) return -1;
    const cx = Math.floor(gx / this.cell);
    const cy = Math.floor(gy / this.cell);
    if (cx >= this.cols || cy >= this.rows) return -1;
    return cy * this.cols + cx;
  }

  /**
   * The point under `(x, y)`, front-most first — the same answer
   * {@link nearestProjectedIndex} gives, reached without touching every point.
   *
   * `radius` bounds which cells are visited, so a `radiusAt` that returns MORE than it must
   * still be missed outside that bound. Pass the largest per-point radius as `radius` when
   * using one.
   */
  pick(x: number, y: number, radius: number, opts: ProjectedPickOptions = {}): number {
    const { radiusAt, pickable } = opts;
    // Same origin shift as the build, or the query would read the wrong cells.
    const gx = x - this.originX;
    const gy = y - this.originY;
    const minCx = Math.max(0, Math.floor((gx - radius) / this.cell));
    const maxCx = Math.min(this.cols - 1, Math.floor((gx + radius) / this.cell));
    const minCy = Math.max(0, Math.floor((gy - radius) / this.cell));
    const maxCy = Math.min(this.rows - 1, Math.floor((gy + radius) / this.cell));
    const r2 = radius * radius;

    let best = -1;
    let bestDepth = Infinity;
    let bestD2 = Infinity;
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const c = cy * this.cols + cx;
        for (let s = this.starts[c]; s < this.starts[c + 1]; s++) {
          const i = this.items[s];
          const dx = this.screen[i * 2] - x;
          const dy = this.screen[i * 2 + 1] - y;
          const d2 = dx * dx + dy * dy;
          if (radiusAt) {
            const r = radiusAt(i);
            if (!(d2 <= r * r)) continue;
          } else if (!(d2 <= r2)) continue;
          if (pickable && !pickable(i)) continue;
          if (!this.depth) {
            if (d2 < bestD2) {
              bestD2 = d2;
              best = i;
            }
            continue;
          }
          const z = this.depth[i];
          if (z < bestDepth) {
            bestDepth = z;
            bestD2 = d2;
            best = i;
          } else if (z === bestDepth && d2 < bestD2) {
            bestD2 = d2;
            best = i;
          }
        }
      }
    }
    return best;
  }
}

/**
 * Index the cloud when it is worth it, and say so.
 *
 * Below the threshold the linear scan is already sub-millisecond and the grid is pure
 * overhead — the build is a full pass over the points, so for a small cloud it costs more
 * than every pick it would serve.
 */
export const SCREEN_INDEX_MIN_POINTS = 50_000;

/** The pick a caller should use when it has no index: identical answer, linear cost. */
export function pickLinear(
  projected: ProjectedPoints,
  x: number,
  y: number,
  radius: number,
  opts?: ProjectedPickOptions,
): number {
  return nearestProjectedIndex(projected.screen, x, y, radius, projected.depth, opts);
}
