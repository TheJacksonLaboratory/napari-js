import { Layer, type BlendMode, type Fit3D } from './layer';
import { Colormap, resolveColormap } from '../color/colormap';

export interface SurfaceLayerOptions {
  /** Whether adding this layer frames the orbit camera; overrides the viewer's default. */
  fit?: Fit3D;
  name?: string;
  /** Colormap applied to per-vertex `values` (name or {@link Colormap}). */
  colormap?: Colormap | string;
  /** Normalization window in vertex-value units (default: data min/max). */
  contrastLimits?: [number, number];
  gamma?: number;
  opacity?: number;
  blending?: BlendMode;
  visible?: boolean;
  /** Render as a wireframe (triangle edges as lines) instead of a filled, shaded surface. */
  wireframe?: boolean;
}

/** Axis-aligned bounds of a mesh, plus a center + framing radius for the 3D camera. */
export interface SurfaceBounds {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  /** Half the bounding-box diagonal — a good orbit-camera framing radius. */
  radius: number;
}

export interface HeightFieldOptions {
  /** World height of a fully-normalized (value = 1) sample (default 0.3 × max(cols, rows)). */
  zScale?: number;
  /** Value window mapped to the 0..1 height displacement (default: data min/max). */
  zLimits?: [number, number];
  /** Take every `stride`-th sample in x and y to decimate a large image (default 1). */
  stride?: number;
  /** Center the mesh on the origin on all axes (instead of the positive octant), so it can be
   *  wrapped in an origin-centered {@link AxesLayer} gizmo and framed like a volume. Default false. */
  center?: boolean;
}

/** Interleaved GPU vertex = [x, y, z, value] → 4 floats. */
export const SURFACE_VERTEX_FLOATS = 4;

/**
 * A 3D triangular-mesh layer — the napari `Surface` layer analog: `vertices` (N×3, world/data
 * coords, x-fastest), `faces` (M×3 triangle indices), and per-vertex scalar `values` colored
 * through a colormap (windowed by {@link contrastLimits} + {@link gamma}). Rendered with depth
 * testing and screen-space flat shading. Renders only when `dims.ndisplay === 3`. If `values`
 * are omitted, each vertex is colored by its own z, so a height field colors by height.
 */
export class SurfaceLayer extends Layer {
  readonly kind = 'surface';
  /** N — number of vertices. */
  readonly vertexCount: number;
  /** 3M — length of {@link faces} (drawn with `drawIndexed`). */
  readonly indexCount: number;
  /** N×3 vertex positions in world/data coords, x-fastest. */
  readonly vertices: Float32Array;
  /** M×3 triangle indices into the vertices. */
  readonly faces: Uint32Array;
  /** Per-vertex scalar (length N) mapped through the colormap. */
  readonly values: Float32Array;

  colormapVersion = 0;

  private _colormap: Colormap;
  private _contrastLimits: [number, number];
  private _gamma: number;
  private _wireframe: boolean;

  constructor(
    vertices: Float32Array,
    faces: Uint32Array,
    values?: Float32Array,
    opts: SurfaceLayerOptions = {},
  ) {
    super({ name: opts.name });
    if (vertices.length % 3 !== 0) {
      throw new Error(`Surface vertices length (${vertices.length}) must be a multiple of 3.`);
    }
    if (faces.length % 3 !== 0) {
      throw new Error(`Surface faces length (${faces.length}) must be a multiple of 3.`);
    }
    const n = vertices.length / 3;
    const vals = values ?? deriveZValues(vertices);
    if (vals.length !== n) {
      throw new Error(`Surface values length (${vals.length}) must equal vertex count (${n}).`);
    }
    this.vertices = vertices;
    this.faces = faces;
    this.values = vals;
    this.vertexCount = n;
    this.indexCount = faces.length;
    this._colormap = resolveColormap(opts.colormap ?? 'viridis');
    this._contrastLimits = opts.contrastLimits ?? valueRange(vals);
    this._gamma = opts.gamma ?? 1;
    this._wireframe = opts.wireframe ?? false;
    this._blending = opts.blending ?? 'opaque';
    if (opts.opacity !== undefined) this._opacity = opts.opacity;
    if (opts.visible !== undefined) this._visible = opts.visible;
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
    return [this._contrastLimits[0], this._contrastLimits[1]];
  }
  set contrastLimits(value: readonly [number, number]) {
    this._contrastLimits = [value[0], value[1]];
    this.changed.emit(this);
  }

  get gamma(): number {
    return this._gamma;
  }
  set gamma(value: number) {
    this._gamma = value > 0 ? value : this._gamma;
    this.changed.emit(this);
  }

  /** Render as a wireframe (edges only) vs a filled, shaded surface. Live — no geometry rebuild. */
  get wireframe(): boolean {
    return this._wireframe;
  }
  set wireframe(value: boolean) {
    this._wireframe = value;
    this.changed.emit(this);
  }

  /** Axis-aligned bounds + a center/radius the viewer uses to frame the orbit camera. */
  bounds(): SurfaceBounds {
    const v = this.vertices;
    if (v.length === 0) {
      return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 1 };
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const c = v[i + a];
        if (c < min[a]) min[a] = c;
        if (c > max[a]) max[a] = c;
      }
    }
    const center: [number, number, number] = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    const radius = 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    return { min, max, center, radius };
  }

  /** Line-list index buffer of the triangle edges, for wireframe rendering: each face (a,b,c) →
   *  the three edges (a,b) (b,c) (c,a) as index pairs. Shared edges are emitted twice (harmless
   *  overdraw). Length = `faces.length * 2`. */
  buildEdgeIndices(): Uint32Array {
    const out = new Uint32Array(this.faces.length * 2);
    let e = 0;
    for (let t = 0; t < this.faces.length; t += 3) {
      const a = this.faces[t];
      const b = this.faces[t + 1];
      const c = this.faces[t + 2];
      out[e++] = a;
      out[e++] = b;
      out[e++] = b;
      out[e++] = c;
      out[e++] = c;
      out[e++] = a;
    }
    return out;
  }

  /** Interleave positions + values into the GPU vertex buffer (N × [x, y, z, value]). */
  buildVertexData(): Float32Array {
    const n = this.vertexCount;
    const out = new Float32Array(n * SURFACE_VERTEX_FLOATS);
    for (let i = 0; i < n; i++) {
      const o = i * SURFACE_VERTEX_FLOATS;
      out[o] = this.vertices[i * 3];
      out[o + 1] = this.vertices[i * 3 + 1];
      out[o + 2] = this.vertices[i * 3 + 2];
      out[o + 3] = this.values[i];
    }
    return out;
  }
}

/**
 * Build a height-field mesh from a 2D scalar grid (`data`, x-fastest, `cols`×`rows`): the classic
 * "surface plot" where z = normalized intensity. Returns generic `{ vertices, faces, values }`
 * for {@link SurfaceLayer}. Pure + GPU-free (unit-tested). `values` carry the raw intensities so
 * the layer's colormap/contrast still map the original data range.
 */
export function heightField(
  data: ArrayLike<number>,
  cols: number,
  rows: number,
  opts: HeightFieldOptions = {},
): { vertices: Float32Array; faces: Uint32Array; values: Float32Array } {
  if (cols < 2 || rows < 2) {
    throw new Error(`heightField needs at least a 2×2 grid (got ${cols}×${rows}).`);
  }
  const stride = Math.max(1, Math.floor(opts.stride ?? 1));
  // Grid node counts after decimation (always include the last row/col so the extent is preserved).
  const gw = Math.floor((cols - 1) / stride) + 1;
  const gh = Math.floor((rows - 1) / stride) + 1;
  const zScale = opts.zScale ?? 0.3 * Math.max(cols, rows);

  const sampleAt = (gx: number, gy: number): number => {
    const col = Math.min(cols - 1, gx * stride);
    const row = Math.min(rows - 1, gy * stride);
    return data[row * cols + col];
  };

  let [lo, hi] = opts.zLimits ?? [Infinity, -Infinity];
  if (!opts.zLimits) {
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        const v = sampleAt(gx, gy);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    if (!(hi > lo)) hi = lo + 1;
  }
  const span = hi - lo || 1;

  const vertices = new Float32Array(gw * gh * 3);
  const values = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const idx = gy * gw + gx;
      const raw = sampleAt(gx, gy);
      const t = (raw - lo) / span;
      const tz = t < 0 ? 0 : t > 1 ? 1 : t; // clamp height into [0, zScale]; `values` keep raw for colour
      vertices[idx * 3] = Math.min(cols - 1, gx * stride); // world x = data column
      vertices[idx * 3 + 1] = Math.min(rows - 1, gy * stride); // world y = data row
      vertices[idx * 3 + 2] = tz * zScale; // world z = intensity normalized within [lo, hi]
      values[idx] = raw;
    }
  }

  // Two triangles per grid cell, consistent winding.
  const faces = new Uint32Array((gw - 1) * (gh - 1) * 6);
  let f = 0;
  for (let gy = 0; gy < gh - 1; gy++) {
    for (let gx = 0; gx < gw - 1; gx++) {
      const v00 = gy * gw + gx;
      const v10 = v00 + 1;
      const v01 = v00 + gw;
      const v11 = v01 + 1;
      faces[f++] = v00;
      faces[f++] = v10;
      faces[f++] = v11;
      faces[f++] = v00;
      faces[f++] = v11;
      faces[f++] = v01;
    }
  }

  if (opts.center) centerVerticesInPlace(vertices);
  return { vertices, faces, values };
}

/** Offset an N×3 position array so its bounding box is centered on the origin (all axes). */
function centerVerticesInPlace(vertices: Float32Array): void {
  if (vertices.length === 0) return;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const c = vertices[i + a];
      if (c < min[a]) min[a] = c;
      if (c > max[a]) max[a] = c;
    }
  }
  const cx = (min[0] + max[0]) / 2;
  const cy = (min[1] + max[1]) / 2;
  const cz = (min[2] + max[2]) / 2;
  for (let i = 0; i < vertices.length; i += 3) {
    vertices[i] -= cx;
    vertices[i + 1] -= cy;
    vertices[i + 2] -= cz;
  }
}

/** Default per-vertex values = each vertex's z, so a bare mesh colors by height. */
function deriveZValues(vertices: Float32Array): Float32Array {
  const n = vertices.length / 3;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = vertices[i * 3 + 2];
  return out;
}

/** Min/max of a value array, widened to a unit window when degenerate. */
function valueRange(values: Float32Array): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!isFinite(lo)) return [0, 1];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}
