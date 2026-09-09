import { Layer, type BlendMode, type Fit3D } from './layer';
import { Colormap, resolveColormap } from '../color/colormap';
import type { SurfaceBounds } from './surface-layer';

export interface Points3DLayerOptions {
  /** Whether adding this layer frames the orbit camera; overrides the viewer's default. */
  fit?: Fit3D;
  name?: string;
  /** Colormap applied to per-point `values` (name or {@link Colormap}). */
  colormap?: Colormap | string;
  /** Normalization window in value units (default: data min/max). */
  contrastLimits?: [number, number];
  gamma?: number;
  /** Marker diameter in screen pixels. */
  size?: number;
  opacity?: number;
  blending?: BlendMode;
  visible?: boolean;
  /**
   * Per-point opacity multiplier (length N, 0..1), on top of the layer's `opacity`.
   *
   * This is what lets a subset be emphasised without a second layer. With one opacity for
   * the whole cloud, a host that wants to highlight a selection has to split the points
   * into two layers, keep both in step through every colormap and size change, and accept
   * that the two are depth-sorted against each other as separate draws. A per-point alpha
   * is the same effect in one layer and one draw.
   */
  alphas?: Float32Array;
  /** Per-point size multiplier (length N) on top of `size`, for making a subset findable. */
  sizes?: Float32Array;
}

/** Interleaved GPU instance = [x, y, z, value, alpha, sizeScale] → 6 floats. */
export const POINTS3D_INSTANCE_FLOATS = 6;

/**
 * A 3D scatter of point markers (napari Points-in-3D analog): `positions` (N×3, world/data coords,
 * x-fastest) with optional per-point scalar `values` colored through a colormap. Rendered as
 * depth-tested, screen-facing billboards under the orbit camera. Renders only when
 * `dims.ndisplay === 3`. (The 2D {@link PointsLayer} covers `ndisplay === 2`.)
 */
export class Points3DLayer extends Layer {
  readonly kind = 'points3d';
  /** N — number of points. */
  readonly count: number;
  /** N×3 point positions in world/data coords, x-fastest. */
  readonly positions: Float32Array;
  /** Per-point scalar (length N) mapped through the colormap. */
  values: Float32Array;

  colormapVersion = 0;

  /**
   * Bumped by every change to the instance data, so the visual re-uploads instead of the
   * host discarding and re-adding the layer.
   *
   * Without it, changing what the points are coloured BY means building a new layer — and
   * because adding a 3D layer frames the camera, that turns a recolour into a camera jump
   * the host then has to undo. {@link PointsLayer} already works this way; this is the 3D
   * layer catching up.
   */
  dataVersion = 0;

  private _alphas: Float32Array | null;
  private _sizes: Float32Array | null;

  private _colormap: Colormap;
  private _contrastLimits: [number, number];
  private _gamma: number;
  private _size: number;

  constructor(positions: Float32Array, values?: Float32Array, opts: Points3DLayerOptions = {}) {
    super({ name: opts.name });
    if (positions.length % 3 !== 0) {
      throw new Error(`Points3D positions length (${positions.length}) must be a multiple of 3.`);
    }
    const n = positions.length / 3;
    const vals = values ?? new Float32Array(n);
    if (vals.length !== n) {
      throw new Error(`Points3D values length (${vals.length}) must equal point count (${n}).`);
    }
    this.positions = positions;
    this.values = vals;
    this.count = n;
    this._alphas = checkLength(opts.alphas, n, 'alphas');
    this._sizes = checkLength(opts.sizes, n, 'sizes');
    this._colormap = resolveColormap(opts.colormap ?? 'viridis');
    this._contrastLimits = opts.contrastLimits ?? valueRange(vals);
    this._gamma = opts.gamma ?? 1;
    this._size = opts.size ?? 6;
    this._blending = opts.blending ?? 'translucent';
    if (opts.opacity !== undefined) this._opacity = opts.opacity;
    if (opts.visible !== undefined) this._visible = opts.visible;
  }

  /**
   * Per-point opacity multiplier, or null when the layer is uniformly opaque.
   *
   * Assigning a wrong-length array throws rather than being padded or truncated: a short
   * alpha array against a long cloud would silently hide the tail, which looks like missing
   * data rather than like a bug in the caller.
   */
  get alphas(): Float32Array | null {
    return this._alphas;
  }
  set alphas(value: Float32Array | null | undefined) {
    this._alphas = checkLength(value ?? undefined, this.count, 'alphas');
    this.dataVersion++;
    this.changed.emit(this);
  }

  /** Per-point size multiplier, or null when every marker is `size`. */
  get sizes(): Float32Array | null {
    return this._sizes;
  }
  set sizes(value: Float32Array | null | undefined) {
    this._sizes = checkLength(value ?? undefined, this.count, 'sizes');
    this.dataVersion++;
    this.changed.emit(this);
  }

  /**
   * Replace the per-point scalars in place, keeping the geometry and the camera.
   *
   * The point of the setter is that recolouring is not a new layer: same positions, same
   * bounds, nothing for the camera to reframe.
   */
  setValues(next: Float32Array): void {
    checkLength(next, this.count, 'values');
    this.values = next;
    this.dataVersion++;
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

  get size(): number {
    return this._size;
  }
  set size(value: number) {
    this._size = value > 0 ? value : this._size;
    this.changed.emit(this);
  }

  /** Axis-aligned bounds + a center/radius the viewer uses to frame the orbit camera. */
  bounds(): SurfaceBounds {
    const p = this.positions;
    if (p.length === 0) {
      return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 1 };
    }
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const c = p[i + a];
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

  /**
   * Interleave into the GPU instance buffer (N × [x, y, z, value, alpha, sizeScale]).
   *
   * The two per-point channels default to 1 so an unstyled layer renders exactly as it did
   * before they existed — they multiply the layer-wide `opacity` and `size` rather than
   * replacing them.
   */
  buildInstanceData(): Float32Array {
    const n = this.count;
    const out = new Float32Array(n * POINTS3D_INSTANCE_FLOATS);
    const alphas = this._alphas;
    const sizes = this._sizes;
    for (let i = 0; i < n; i++) {
      const o = i * POINTS3D_INSTANCE_FLOATS;
      out[o] = this.positions[i * 3];
      out[o + 1] = this.positions[i * 3 + 1];
      out[o + 2] = this.positions[i * 3 + 2];
      out[o + 3] = this.values[i];
      out[o + 4] = alphas ? alphas[i] : 1;
      out[o + 5] = sizes ? sizes[i] : 1;
    }
    return out;
  }
}

/** Validate a per-point array's length, so a mismatch surfaces here and not as a render. */
function checkLength(
  values: Float32Array | undefined,
  n: number,
  what: string,
): Float32Array | null {
  if (!values) return null;
  if (values.length !== n) {
    throw new Error(`Points3D ${what} length (${values.length}) must equal point count (${n}).`);
  }
  return values;
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
