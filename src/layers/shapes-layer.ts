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
 * Rings → a triangle-list fan around each ring's centroid.
 *
 * A ring of n vertices yields n triangles, each `(centroid, vᵢ, vᵢ₊₁)`, and 3n
 * vertices. This is exact for **star-convex** rings — which cell and nucleus
 * boundaries are — and self-overlaps on a ring that folds back past its own
 * centroid (a lobed tissue-region annotation); such shapes need a general
 * triangulation, which this deliberately is not.
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
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < n; i++) {
      cx += coords[(start + i) * 2];
      cy += coords[(start + i) * 2 + 1];
    }
    cx /= n;
    cy /= n;
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
  private _gamma: number;

  constructor(coords: Float32Array, offsets: Uint32Array, opts: ShapesLayerOptions = {}) {
    super({ name: opts.name, scale: opts.scale, translate: opts.translate });
    if (coords.length % 2 !== 0) {
      throw new Error(`ShapesLayer: coords length ${coords.length} is not a multiple of 2 (x, y)`);
    }
    if (offsets.length < 1) {
      throw new Error('ShapesLayer: offsets must have at least one entry (shapeCount + 1)');
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
    return this._contrastLimits;
  }
  set contrastLimits(value: readonly [number, number]) {
    this._contrastLimits = [value[0], value[1]];
    this.changed.emit(this);
  }

  get gamma(): number {
    return this._gamma;
  }
  set gamma(value: number) {
    this._gamma = value;
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
