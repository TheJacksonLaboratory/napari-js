import type { Grid } from './raster';
import { ringArea } from './ring';

/** Pixel connectivity: 4 (edge neighbours) or 8 (edge and corner neighbours). */
export type Connectivity = 4 | 8;

/** Connected components of a raster, from {@link labelComponents}. */
export interface Components {
  /** Component id per pixel, 1-based; 0 for background. */
  labels: Int32Array;
  /** Number of components. */
  count: number;
  /** Pixel count per component id (`sizes[0]` unused). */
  sizes: Int32Array;
  /** The raster value each component has (`values[0]` unused). */
  values: Float64Array;
  /** Bounding box per component id, `[x0, y0, x1, y1]` (exclusive), flat. */
  bboxes: Int32Array;
}

/**
 * Label the connected components of a raster: maximal `connectivity`-connected sets of pixels
 * with the SAME non-zero value. For a 0/1 mask these are its blobs; for an integer label image
 * (e.g. a segmentation) each instance becomes one component per connected piece. Ids are
 * assigned in raster order of each component's first pixel. Pure.
 */
export function labelComponents(grid: Grid, connectivity: Connectivity = 4): Components {
  const { data, width: w, height: h } = grid;
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  const values: number[] = [0];
  const boxes: number[] = [0, 0, 0, 0];
  const stack: number[] = [];
  let count = 0;
  for (let start = 0; start < w * h; start++) {
    const v = data[start];
    if (!v || labels[start]) continue;
    const id = ++count;
    labels[start] = id;
    stack.push(start);
    let size = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w;
      const y = (i - x) / w;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (connectivity === 4 && dx !== 0 && dy !== 0)) continue;
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!labels[j] && data[j] === v) {
            labels[j] = id;
            stack.push(j);
          }
        }
      }
    }
    sizes.push(size);
    values.push(v);
    boxes.push(x0, y0, x1, y1);
  }
  return {
    labels,
    count,
    sizes: Int32Array.from(sizes),
    values: Float64Array.from(values),
    bboxes: Int32Array.from(boxes),
  };
}

/** One traced component: its outline, its holes, and what it was traced from. */
export interface Contour {
  /**
   * The outer ring, flat `[x0, y0, …]`, along pixel EDGES (vertices on integer pixel corners,
   * collinear runs merged), offset by `origin`. Clockwise on screen (positive {@link ringArea}).
   * A single pixel is its unit square.
   */
  outer: number[];
  /** Interior rings (counter-clockwise on screen), each enclosing ≥ `minHoleSize` pixels. */
  holes: number[][];
  /** Pixel count of the component. */
  size: number;
  /** The raster value the component has (1 for a 0/1 mask; the label id for a label image). */
  value: number;
}

/** Options for {@link traceContours}. */
export interface TraceOptions {
  /** Skip components with fewer pixels. Default 1. */
  minSize?: number;
  /** Drop holes enclosing fewer pixels. Default 1. */
  minHoleSize?: number;
  /**
   * Connectivity of a component (default 4). Background is taken with the complementary
   * connectivity (8 for 4), so outlines never cross and two pixels touching only at a corner
   * are separate shapes (4) or one shape pinched at the corner (8).
   */
  connectivity?: Connectivity;
  /** Added to every vertex — the mask's position in its frame. Default `[0, 0]`. No clamping. */
  origin?: readonly [number, number];
}

/**
 * Trace every component of a raster (see {@link labelComponents}) into an outer ring plus holes,
 * largest first. Rings follow pixel edges, so {@link rasterizePolygon} of a contour (outer minus
 * holes) gives back exactly its pixels — a mask survives any number of trace → rasterize round
 * trips unchanged. Coordinates are mask-local plus `origin`, never clamped. Pure.
 */
export function traceContours(grid: Grid, opts: TraceOptions = {}): Contour[] {
  const connectivity = opts.connectivity ?? 4;
  const minSize = opts.minSize ?? 1;
  const minHoleSize = opts.minHoleSize ?? 1;
  const [ox, oy] = opts.origin ?? [0, 0];
  const comps = labelComponents(grid, connectivity);
  const ids: number[] = [];
  for (let id = 1; id <= comps.count; id++) if (comps.sizes[id] >= minSize) ids.push(id);
  ids.sort((a, b) => comps.sizes[b] - comps.sizes[a] || a - b);

  const out: Contour[] = [];
  for (const id of ids) {
    const rings = traceComponent(comps, grid.width, grid.height, id, connectivity);
    let outer: number[] | null = null;
    const holes: number[][] = [];
    for (const r of rings) {
      const a = ringArea(r);
      if (a > 0) outer = outer && ringArea(outer) >= a ? outer : r;
      else if (-a >= minHoleSize) holes.push(r);
    }
    if (!outer) continue;
    const shift = (r: number[]): number[] =>
      ox || oy ? r.map((v, i) => v + (i & 1 ? oy : ox)) : r;
    out.push({
      outer: shift(outer),
      holes: holes.map(shift),
      size: comps.sizes[id],
      value: comps.values[id],
    });
  }
  return out;
}

/**
 * The boundary loops of one component: every pixel side between the component and anything
 * else becomes a directed edge (component on the right going clockwise on screen), and the
 * edges are linked into loops. Where two edges leave one corner (two component pixels touching
 * only diagonally) the link stays on the same pixel for 4-connectivity, crosses for 8.
 */
function traceComponent(
  comps: Components,
  w: number,
  h: number,
  id: number,
  connectivity: Connectivity,
): number[][] {
  const { labels, bboxes } = comps;
  const bx0 = bboxes[id * 4];
  const by0 = bboxes[id * 4 + 1];
  const bx1 = bboxes[id * 4 + 2];
  const by1 = bboxes[id * 4 + 3];
  const vw = bx1 - bx0 + 1; // corner grid of the bbox
  const vertexOf = (x: number, y: number): number => (y - by0) * vw + (x - bx0);
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === id;

  // Edges: from-vertex, to-vertex, owning pixel. Up to two edges leave a vertex.
  const from: number[] = [];
  const to: number[] = [];
  const pix: number[] = [];
  const out1 = new Int32Array((bx1 - bx0 + 1) * (by1 - by0 + 1)).fill(-1);
  const out2 = new Int32Array(out1.length).fill(-1);
  const add = (ax: number, ay: number, cx: number, cy: number, p: number): void => {
    const e = from.length;
    const a = vertexOf(ax, ay);
    from.push(a);
    to.push(vertexOf(cx, cy));
    pix.push(p);
    if (out1[a] < 0) out1[a] = e;
    else out2[a] = e;
  };
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      if (labels[y * w + x] !== id) continue;
      const p = y * w + x;
      if (!inside(x, y - 1)) add(x, y, x + 1, y, p); // top: left → right
      if (!inside(x + 1, y)) add(x + 1, y, x + 1, y + 1, p); // right: down
      if (!inside(x, y + 1)) add(x + 1, y + 1, x, y + 1, p); // bottom: right → left
      if (!inside(x - 1, y)) add(x, y + 1, x, y, p); // left: up
    }
  }

  const used = new Uint8Array(from.length);
  const rings: number[][] = [];
  for (let start = 0; start < from.length; start++) {
    if (used[start]) continue;
    const ring: number[] = [];
    let e = start;
    while (!used[e]) {
      used[e] = 1;
      const v = from[e];
      ring.push(bx0 + (v % vw), by0 + Math.floor(v / vw));
      const next = to[e];
      const a = out1[next];
      const b = out2[next];
      if (b < 0 || used[b]) e = a;
      else if (used[a]) e = b;
      else {
        // A pinch corner: two unused edges leave it.
        const samePixel = pix[a] === pix[e] ? a : b;
        e = connectivity === 4 ? samePixel : samePixel === a ? b : a;
      }
    }
    rings.push(mergeCollinear(ring));
  }
  return rings;
}

/** Drop vertices that sit on a straight run between their neighbours. */
function mergeCollinear(ring: number[]): number[] {
  const n = ring.length >> 1;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n;
    const q = (i + 1) % n;
    const dx1 = ring[i * 2] - ring[p * 2];
    const dy1 = ring[i * 2 + 1] - ring[p * 2 + 1];
    const dx2 = ring[q * 2] - ring[i * 2];
    const dy2 = ring[q * 2 + 1] - ring[i * 2 + 1];
    if (dx1 * dy2 - dy1 * dx2 !== 0) out.push(ring[i * 2], ring[i * 2 + 1]);
  }
  return out;
}
