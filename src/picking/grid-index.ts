/**
 * A uniform bucket grid over any 2D coordinate set — `[x0, y0, x1, y1, …]` in whatever units
 * the caller works in (screen pixels, data, world).
 *
 * The shared core of {@link ScreenIndex} (projected points on the canvas) and
 * {@link PointsLayer.pick} (2D markers in data space): both need "which points are near
 * here?" without a scan of every point per pointer move. It answers only that — the
 * candidates in the cells a query circle overlaps. Distance tests, radii, depth and tie
 * rules belong to the caller, because they are what differs between pickers.
 *
 * Counting sort into a flat CSR-style pair of typed arrays rather than an array of arrays:
 * at a few million points, a few million small arrays is its own performance problem.
 */

/** An axis-aligned rectangle, inclusive of both ends. */
export interface GridBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GridIndexOptions {
  /**
   * Cell edge, in the coordinates' units. About the largest pick radius in play: a query
   * visits every cell its circle overlaps, so a much smaller cell visits many and a much
   * larger one makes each a linear scan. Default: from the point density
   * ({@link GridIndex.suggestCell}).
   */
  cell?: number;
  /**
   * The region the grid covers. Points outside it (and NaN points) are not indexed, so a
   * query never returns them. Default: the bounding box of the finite points.
   */
  bounds?: GridBounds;
}

/** Most cells an automatically sized grid may have, as a multiple of the point count. */
const AUTO_CELLS_PER_POINT = 4;
const AUTO_MIN_CELLS = 4096;

export class GridIndex {
  /** Cell edge, in the coordinates' units. */
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  /** The covered region: cell (0, 0) starts at `(bounds.minX, bounds.minY)`. */
  readonly bounds: GridBounds;
  /** The indexed coordinates, by reference. */
  readonly xy: Float32Array;

  /** Start of each cell's slice in {@link items}; length `cols*rows + 1`. */
  private readonly starts: Int32Array;
  /** Point indices grouped by cell, ascending within a cell. */
  private readonly items: Int32Array;

  /**
   * The column count is `floor(span / cell) + 1`, not `ceil(span / cell)`, so the inclusive
   * upper bound has a cell of its own even when the span divides evenly by the cell.
   */
  constructor(xy: Float32Array, opts: GridIndexOptions = {}) {
    this.xy = xy;
    const n = xy.length >> 1;
    const bounds = opts.bounds ?? GridIndex.boundsOf(xy);
    this.bounds = bounds;
    const spanX = Math.max(0, bounds.maxX - bounds.minX);
    const spanY = Math.max(0, bounds.maxY - bounds.minY);
    let cell = opts.cell ?? GridIndex.suggestCell(bounds, n);
    if (!(cell > 0) || !Number.isFinite(cell)) cell = Math.max(spanX, spanY, 1);
    this.cell = cell;
    this.cols = Math.floor(spanX / cell) + 1;
    this.rows = Math.floor(spanY / cell) + 1;

    const cellCount = this.cols * this.rows;
    const counts = new Int32Array(cellCount + 1);
    // Pass 1: count. Out-of-bounds and NaN points get -1 and are not indexed.
    const cellOf = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const c = this.cellIndex(xy[i * 2], xy[i * 2 + 1]);
      cellOf[i] = c;
      if (c >= 0) counts[c + 1]++;
    }
    for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
    this.starts = counts;
    // Pass 2: place. `cursor` walks a copy so `starts` keeps the slice boundaries.
    const cursor = Int32Array.from(counts.subarray(0, cellCount));
    this.items = new Int32Array(counts[cellCount]);
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      if (c >= 0) this.items[cursor[c]++] = i;
    }
  }

  /**
   * A cell edge for `n` points over `bounds`: about four points per cell if they were
   * spread evenly, and never so small that the grid has more than
   * `max(4096, 4n)` cells.
   */
  static suggestCell(bounds: GridBounds, n: number): number {
    const spanX = Math.max(0, bounds.maxX - bounds.minX);
    const spanY = Math.max(0, bounds.maxY - bounds.minY);
    const span = Math.max(spanX, spanY);
    if (!(span > 0) || !Number.isFinite(span)) return 1;
    const maxCells = Math.max(AUTO_MIN_CELLS, AUTO_CELLS_PER_POINT * n);
    // Evenly spread, `n / 4` cells hold four points each.
    let cell = Math.sqrt(
      (Math.max(spanX, span * 1e-6) * Math.max(spanY, span * 1e-6) * 4) / Math.max(n, 1),
    );
    if (!(cell > 0)) cell = span;
    while ((Math.floor(spanX / cell) + 1) * (Math.floor(spanY / cell) + 1) > maxCells) cell *= 2;
    return cell;
  }

  /** Bounding box of the finite points — the default {@link bounds}; zero at the origin if none. */
  static boundsOf(xy: Float32Array): GridBounds {
    return finiteBounds(xy);
  }

  /** How many points the grid holds — the rest were out of bounds or NaN. */
  get indexed(): number {
    return this.items.length;
  }

  private cellIndex(x: number, y: number): number {
    const gx = x - this.bounds.minX;
    const gy = y - this.bounds.minY;
    // NaN fails both comparisons, so an unplaced point is excluded here.
    if (!(gx >= 0) || !(gy >= 0)) return -1;
    const cx = Math.floor(gx / this.cell);
    const cy = Math.floor(gy / this.cell);
    if (cx >= this.cols || cy >= this.rows) return -1;
    return cy * this.cols + cx;
  }

  /**
   * Call `visit(i)` for every indexed point in the cells the circle `(x, y, radius)` overlaps
   * — a superset of the points within `radius`, each once, row by row and in ascending
   * index order within a cell. The caller does the distance test.
   */
  forEachCandidate(x: number, y: number, radius: number, visit: (i: number) => void): void {
    const gx = x - this.bounds.minX;
    const gy = y - this.bounds.minY;
    const minCx = Math.max(0, Math.floor((gx - radius) / this.cell));
    const maxCx = Math.min(this.cols - 1, Math.floor((gx + radius) / this.cell));
    const minCy = Math.max(0, Math.floor((gy - radius) / this.cell));
    const maxCy = Math.min(this.rows - 1, Math.floor((gy + radius) / this.cell));
    const { starts, items } = this;
    // NaN bounds (a NaN query) fail every loop test, so nothing is visited.
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        const c = cy * this.cols + cx;
        for (let s = starts[c], end = starts[c + 1]; s < end; s++) visit(items[s]);
      }
    }
  }
}

/** Bounding box of the finite points; a zero box at the origin when there are none. */
function finiteBounds(xy: Float32Array): GridBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 1 < xy.length; i += 2) {
    const x = xy[i];
    const y = xy[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}
