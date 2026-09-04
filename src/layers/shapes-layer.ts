import { Layer, type BlendMode } from './layer';
import { type Colormap, resolveColormap } from '../color/colormap';

export type RGBA = [number, number, number, number];

/** How a shape is drawn: its boundary as 1-pixel lines, or its interior filled. */
export type ShapeDraw = 'outline' | 'fill';

export interface ShapesLayerOptions {
  name?: string;
  /** `outline` (default) draws boundaries; `fill` draws interiors. */
  draw?: ShapeDraw;
  /** One scalar per shape, mapped through {@link colormap} — a cluster id, a
   *  measurement. Without it every shape takes {@link color}. */
  values?: Float32Array;
  /** Colormap for `values` (name or {@link Colormap}). Ignored without values. */
  colormap?: Colormap | string;
  /** Value window mapped onto the colormap. Defaults to the values' own range. */
  contrastLimits?: [number, number];
  gamma?: number;
  /** Flat colour, used when no `values` are supplied. */
  color?: RGBA;
  opacity?: number;
  blending?: BlendMode;
  visible?: boolean;
  scale?: [number, number];
  translate?: [number, number];
}

/** Positions plus, per emitted vertex, the shape it came from. */
export interface ShapeGeometry {
  /** `[x, y, …]` in data coordinates, ready as a `float32x2` vertex buffer. */
  positions: Float32Array;
  /** `shapeIds[i]` is the shape index of vertex `i` — how a per-shape value or
   *  colour reaches a per-vertex attribute without duplicating the value array. */
  shapeIds: Uint32Array;
  /** Vertices in `positions` (`positions.length / 2`). */
  count: number;
}

/** Vertices a ring contributes to each draw mode, or 0 when it is degenerate. */
function verticesFor(ringLength: number, draw: ShapeDraw): number {
  if (draw === 'outline') return ringLength >= 2 ? ringLength * 2 : 0;
  return ringLength >= 3 ? ringLength * 3 : 0;
}

/**
 * Total vertices `coords`/`offsets` expand to, without building the geometry.
 *
 * Lets a caller size a buffer — or refuse — before paying for the expansion, which
 * matters because the expansion is the expensive half at 10⁵–10⁶ shapes.
 */
export function shapeVertexCount(offsets: Uint32Array, draw: ShapeDraw): number {
  let total = 0;
  for (let s = 0; s + 1 < offsets.length; s++) {
    total += verticesFor(offsets[s + 1] - offsets[s], draw);
  }
  return total;
}

/**
 * Rings → a line-list of their edges.
 *
 * Each ring is implicitly closed, so a ring of n vertices yields n edges (the last
 * joining the last vertex to the first) and 2n vertices. Rings shorter than two
 * vertices are skipped rather than drawn as a degenerate edge.
 *
 * Pure and GPU-free, like {@link heightField}: the expansion is the part worth
 * testing, and it is testable without a device.
 */
export function ringsToOutline(coords: Float32Array, offsets: Uint32Array): ShapeGeometry {
  const total = shapeVertexCount(offsets, 'outline');
  const positions = new Float32Array(total * 2);
  const shapeIds = new Uint32Array(total);
  let w = 0;
  for (let s = 0; s + 1 < offsets.length; s++) {
    const start = offsets[s];
    const n = offsets[s + 1] - start;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const a = start + i;
      const b = start + ((i + 1) % n);
      positions[w * 2] = coords[a * 2];
      positions[w * 2 + 1] = coords[a * 2 + 1];
      shapeIds[w] = s;
      w++;
      positions[w * 2] = coords[b * 2];
      positions[w * 2 + 1] = coords[b * 2 + 1];
      shapeIds[w] = s;
      w++;
    }
  }
  return { positions, shapeIds, count: total };
}

/**
 * A point that sees every vertex of a ring — the apex a fan must start from.
 *
 * The vertex mean is NOT such a point in general. `[(0,0), (4,0), (4,4), (2,1),
 * (0,4)]` is star-convex (its kernel contains (2, 0.5)) yet its mean, (2, 1.8),
 * lies OUTSIDE the ring — so a fan from the mean covers exterior pixels and
 * overlaps itself. The mean is only guaranteed to work for CONVEX rings, where
 * every interior point sees everything.
 *
 * So the apex is taken from the ring's KERNEL: the intersection of the interior
 * half-planes of its edges, which is convex by construction and non-empty exactly
 * when the ring is star-convex. Built by clipping the ring's bounding box against
 * each edge in turn (Sutherland–Hodgman), then taking the centroid of what
 * survives — that centroid is in the kernel because the kernel is convex.
 *
 * Null when the kernel is empty, i.e. the ring is not star-convex and no single
 * apex can triangulate it.
 *
 * O(n · k) for a ring of n edges and a kernel of k vertices, both small for a
 * segmentation boundary (10–50 vertices).
 */
export function polygonKernelPoint(
  coords: Float32Array,
  start: number,
  n: number,
): [number, number] | null {
  if (n < 3) return null;
  // Orientation decides which side of an edge is "interior".
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = (start + i) * 2;
    const b = (start + ((i + 1) % n)) * 2;
    area2 += coords[a] * coords[b + 1] - coords[b] * coords[a + 1];
  }
  if (area2 === 0) return null; // degenerate: no interior to find a point in
  const ccw = area2 > 0;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = coords[(start + i) * 2];
    const y = coords[(start + i) * 2 + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  // Start from the bounding box; every half-plane can only shrink it.
  let region: number[] = [minX, minY, maxX, minY, maxX, maxY, minX, maxY];

  for (let i = 0; i < n && region.length >= 6; i++) {
    const ax = coords[(start + i) * 2];
    const ay = coords[(start + i) * 2 + 1];
    const bx = coords[(start + ((i + 1) % n)) * 2];
    const by = coords[(start + ((i + 1) % n)) * 2 + 1];
    // Signed side of the directed edge a→b; interior is left for CCW rings.
    const side = (px: number, py: number): number => {
      const s = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      return ccw ? s : -s;
    };
    const out: number[] = [];
    const m = region.length / 2;
    for (let k = 0; k < m; k++) {
      const px = region[k * 2];
      const py = region[k * 2 + 1];
      const qx = region[((k + 1) % m) * 2];
      const qy = region[((k + 1) % m) * 2 + 1];
      const sp = side(px, py);
      const sq = side(qx, qy);
      if (sp >= 0) out.push(px, py);
      // Crossing the boundary: keep the intersection point.
      if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
        const tt = sp / (sp - sq);
        out.push(px + (qx - px) * tt, py + (qy - py) * tt);
      }
    }
    region = out;
  }
  if (region.length < 6) return null;

  let cx = 0;
  let cy = 0;
  const m = region.length / 2;
  for (let k = 0; k < m; k++) {
    cx += region[k * 2];
    cy += region[k * 2 + 1];
  }
  // The kernel is convex, so the mean of its vertices is inside it.
  return [cx / m, cy / m];
}

/**
 * Rings → a triangle-list fan around a point inside each ring.
 *
 * A ring of n vertices yields n triangles, each `(apex, vᵢ, vᵢ₊₁)`, and 3n
 * vertices. The apex comes from {@link polygonKernelPoint}, so the fan is exact
 * for every **star-convex** ring — which cell and nucleus boundaries are.
 *
 * A ring whose kernel is empty is not star-convex at all (a lobed tissue-region
 * annotation, say): no single apex can triangulate it, and it needs a general
 * triangulation, which this deliberately is not. Such a ring falls back to the
 * vertex mean and may self-overlap — visibly wrong rather than silently dropped.
 *
 * Pure and GPU-free.
 */
export function ringsToFan(coords: Float32Array, offsets: Uint32Array): ShapeGeometry {
  const total = shapeVertexCount(offsets, 'fill');
  const positions = new Float32Array(total * 2);
  const shapeIds = new Uint32Array(total);
  let w = 0;
  for (let s = 0; s + 1 < offsets.length; s++) {
    const start = offsets[s];
    const n = offsets[s + 1] - start;
    if (n < 3) continue;
    const kernel = polygonKernelPoint(coords, start, n);
    let cx: number;
    let cy: number;
    if (kernel) {
      [cx, cy] = kernel;
    } else {
      // Not star-convex: no apex works. The vertex mean keeps the shape roughly
      // where it belongs instead of dropping it.
      cx = 0;
      cy = 0;
      for (let i = 0; i < n; i++) {
        cx += coords[(start + i) * 2];
        cy += coords[(start + i) * 2 + 1];
      }
      cx /= n;
      cy /= n;
    }
    for (let i = 0; i < n; i++) {
      const a = start + i;
      const b = start + ((i + 1) % n);
      positions[w * 2] = cx;
      positions[w * 2 + 1] = cy;
      shapeIds[w] = s;
      w++;
      positions[w * 2] = coords[a * 2];
      positions[w * 2 + 1] = coords[a * 2 + 1];
      shapeIds[w] = s;
      w++;
      positions[w * 2] = coords[b * 2];
      positions[w * 2 + 1] = coords[b * 2 + 1];
      shapeIds[w] = s;
      w++;
    }
  }
  return { positions, shapeIds, count: total };
}

/**
 * A polygon layer (the napari `Shapes` layer analog, restricted to closed rings).
 *
 * Geometry arrives as **flat rings** — `coords` is `[x0,y0,x1,y1,…]` and `offsets`
 * has `shapeCount + 1` entries, so shape `i` occupies
 * `coords[2*offsets[i] .. 2*offsets[i+1])` and closes implicitly. That is the shape
 * segmentation actually comes in, and it is the only shape that survives 10⁵–10⁶
 * cells: one object and one array per polygon would dominate memory long before the
 * GPU noticed.
 *
 * Renders in **2D** (`dims.ndisplay === 2`), over an image, as either 1-pixel
 * boundaries or filled interiors ({@link ShapeDraw}). WebGPU has no line width, so
 * an outline is one device pixel regardless of zoom; a thicker stroke needs quad
 * expansion and is not implemented here.
 *
 * Per-shape `values` colour the shapes through a colormap, so a cluster or a
 * measurement maps to colour without the caller expanding anything per vertex.
 * Changing `values` alone does not rebuild the positions.
 */
export class ShapesLayer extends Layer {
  readonly kind = 'shapes';
  /** Number of shapes (`offsets.length - 1`). */
  readonly shapeCount: number;
  readonly coords: Float32Array;
  readonly offsets: Uint32Array;
  /** Bumped when the geometry changes (draw mode), so the visual re-expands. */
  dataVersion = 0;
  /** Bumped when the per-shape values change, so the visual rewrites only them. */
  valueVersion = 0;
  colormapVersion = 0;

  private _draw: ShapeDraw;
  private _values: Float32Array | null;
  private _color: RGBA;
  private _colormap: Colormap;
  private _contrastLimits: [number, number];
  /** False while the window is DERIVED from the values, so replacing them has to
   *  re-derive it; true once a caller has set one, which must then be respected. */
  private _contrastExplicit: boolean;
  private _gamma: number;

  constructor(coords: Float32Array, offsets: Uint32Array, opts: ShapesLayerOptions = {}) {
    super({ name: opts.name, scale: opts.scale, translate: opts.translate });
    if (coords.length % 2 !== 0) {
      throw new Error(`ShapesLayer: coords length ${coords.length} is not a multiple of 2 (x, y)`);
    }
    if (offsets.length < 1) {
      throw new Error('ShapesLayer: offsets must have at least one entry (shapeCount + 1)');
    }
    // Checking only the LAST offset is not enough: `[0, 99, 7]` ends in bounds
    // while its middle entry runs past `coords`, and the expansion would then read
    // uninitialised memory and emit NaN positions rather than throwing.
    if (offsets[0] !== 0) {
      throw new Error(`ShapesLayer: offsets must start at 0, got ${offsets[0]}`);
    }
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i] < offsets[i - 1]) {
        throw new Error(
          `ShapesLayer: offsets must be nondecreasing, but offsets[${i}] = ${offsets[i]} ` +
            `is less than offsets[${i - 1}] = ${offsets[i - 1]}`,
        );
      }
    }
    const last = offsets[offsets.length - 1];
    if (last * 2 > coords.length) {
      throw new Error(
        `ShapesLayer: offsets end at vertex ${last} but coords hold only ${coords.length / 2}`,
      );
    }
    this.coords = coords;
    this.offsets = offsets;
    this.shapeCount = offsets.length - 1;
    if (opts.values && opts.values.length !== this.shapeCount) {
      throw new Error(
        `ShapesLayer: ${opts.values.length} values for ${this.shapeCount} shapes — one per shape`,
      );
    }
    this._draw = opts.draw ?? 'outline';
    this._values = opts.values ?? null;
    this._color = opts.color ?? [1, 1, 1, 1];
    this._colormap = resolveColormap(opts.colormap ?? 'viridis');
    this._contrastExplicit = opts.contrastLimits !== undefined;
    this._contrastLimits = opts.contrastLimits ?? valueRange(this._values);
    this._gamma = opts.gamma ?? 1;
    if (opts.opacity !== undefined) this._opacity = opts.opacity;
    if (opts.blending !== undefined) this._blending = opts.blending;
    if (opts.visible !== undefined) this._visible = opts.visible;
  }

  get draw(): ShapeDraw {
    return this._draw;
  }
  /** Switching between outline and fill is a GEOMETRY change — different vertex
   *  counts and a different topology — so it bumps `dataVersion`. */
  set draw(value: ShapeDraw) {
    if (value === this._draw) return;
    this._draw = value;
    this.dataVersion++;
    this.changed.emit(this);
  }

  get values(): Float32Array | null {
    return this._values;
  }
  set values(value: Float32Array | null) {
    if (value && value.length !== this.shapeCount) {
      throw new Error(
        `ShapesLayer: ${value.length} values for ${this.shapeCount} shapes — one per shape`,
      );
    }
    this._values = value;
    // A window that was derived from the OLD values describes nothing about the
    // new ones: a layer built without values keeps [0, 1], and assigning [10, 20]
    // would then clamp every shape to the LUT's top entry.
    if (!this._contrastExplicit) this._contrastLimits = valueRange(value);
    this.valueVersion++;
    this.changed.emit(this);
  }

  get color(): RGBA {
    return this._color;
  }
  set color(value: RGBA) {
    this._color = value;
    this.changed.emit(this);
  }

  get colormap(): Colormap {
    return this._colormap;
  }
  set colormap(value: Colormap | string) {
    this._colormap = resolveColormap(value);
    this.colormapVersion++;
    this.changed.emit(this);
  }

  get contrastLimits(): [number, number] {
    // A copy, as every other layer returns: handing out the internal tuple lets
    // `layer.contrastLimits[0] = x` change what is rendered without emitting
    // `changed`, so the visual never learns to redraw.
    return [this._contrastLimits[0], this._contrastLimits[1]];
  }
  set contrastLimits(value: readonly [number, number]) {
    this._contrastExplicit = true;
    this._contrastLimits = [value[0], value[1]];
    this.changed.emit(this);
  }

  get gamma(): number {
    return this._gamma;
  }
  set gamma(value: number) {
    // Non-positive gamma is rejected, as on every other layer: zero collapses the
    // whole normalised range and a negative value inverts it, so the previous
    // valid setting is kept instead.
    this._gamma = value > 0 ? value : this._gamma;
    this.changed.emit(this);
  }

  /** Vertices the current draw mode expands to — the draw call's vertex count. */
  vertexCount(): number {
    return shapeVertexCount(this.offsets, this._draw);
  }

  /** Expand the rings for the current draw mode. */
  buildGeometry(): ShapeGeometry {
    return this._draw === 'outline'
      ? ringsToOutline(this.coords, this.offsets)
      : ringsToFan(this.coords, this.offsets);
  }

  /**
   * The per-vertex scalar the shader maps through the colormap.
   *
   * With `values`, each vertex takes its shape's value. Without them the layer is a
   * flat colour, and the attribute is unused — it is still written (as the shape
   * index) so one pipeline serves both cases.
   */
  buildVertexValues(shapeIds: Uint32Array): Float32Array {
    const out = new Float32Array(shapeIds.length);
    const values = this._values;
    for (let i = 0; i < shapeIds.length; i++) {
      out[i] = values ? values[shapeIds[i]] : shapeIds[i];
    }
    return out;
  }

  /** Axis-aligned bounds of the shapes in data coordinates, or null when empty. */
  bounds(): { min: [number, number]; max: [number, number] } | null {
    const end = this.offsets[this.offsets.length - 1] * 2;
    if (end === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < end; i += 2) {
      const x = this.coords[i];
      const y = this.coords[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { min: [minX, minY], max: [maxX, maxY] };
  }
}

/** Values' own range, widened when flat so the window never divides by zero. */
function valueRange(values: Float32Array | null): [number, number] {
  if (!values || values.length === 0) return [0, 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}
