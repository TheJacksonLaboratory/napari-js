import { Layer, type BlendMode } from './layer';
import {
  checkPointSymbols,
  pointSymbolCode,
  resolvePointSymbol,
  POINT_SYMBOL_LAYER_DEFAULT,
  type PointSymbol,
  type PointSymbolAlias,
} from './point-symbols';
import { GridIndex } from '../picking/grid-index';

export type { PointSymbol, PointSymbolAlias } from './point-symbols';
export type RGBA = [number, number, number, number];

/** Per-point or broadcast scalar/color inputs. */
type SizeInput = number | number[] | Float32Array;

/**
 * A points colour: one RGBA (0..1) for every point, one RGBA per point, or a packed
 * `Float32Array` of per-point RGBA (length 4N, `[r0, g0, b0, a0, r1, …]`).
 *
 * The packed form is what a host that computes colours in bulk already has. Without it, N
 * colours have to be exploded into N four-element arrays only for the layer to flatten them
 * back into its instance buffer — for half a million points, half a million short-lived arrays
 * per recolour. The packed array is copied straight into the instance stride.
 */
export type PointColorInput = RGBA | RGBA[] | Float32Array;
type ColorInput = PointColorInput;

export interface PointsLayerOptions {
  name?: string;
  /** Marker diameter in data units (single value or per-point). */
  size?: SizeInput;
  /** Fill color: single RGBA 0..1, per-point RGBA, or packed per-point RGBA (length 4N). */
  faceColor?: ColorInput;
  /** Border color: single, per-point, or packed per-point RGBA (length 4N). */
  borderColor?: ColorInput;
  /** Border thickness in data units. */
  borderWidth?: number;
  /**
   * Marker shape for every point without a per-point code: a {@link PointSymbol} name or a
   * napari alias (`'o'`, `'s'`, `'+'`, …). Default `'disc'`.
   */
  symbol?: PointSymbol | PointSymbolAlias;
  /**
   * Per-point marker shapes, napari's per-point `symbol`: one code per point, the code being
   * the symbol's index in {@link POINT_SYMBOLS} (see {@link pointSymbolCode}). A code of
   * {@link POINT_SYMBOL_LAYER_DEFAULT} (255) draws that point with the layer's `symbol`.
   * Length must equal the point count; an unknown code throws.
   */
  symbols?: Uint8Array | null;
  opacity?: number;
  blending?: BlendMode;
  visible?: boolean;
  scale?: [number, number];
  translate?: [number, number];
}

/** Options for {@link PointsLayer.pick}. Distances and radii are in WORLD units. */
export interface PointsPickOptions {
  /**
   * Slack around every marker: a point is hit when the query is within
   * `max(its radius, tolerance)` of its centre — so a tiny marker can still be hovered.
   * Default 0 (the drawn marker only).
   */
  tolerance?: number;
  /**
   * Hit radius for point `i`, overriding the drawn one (`sizeAt(i) / 2`, in world units) —
   * e.g. a host that draws a selected marker larger. Still floored at `tolerance`.
   */
  radiusAt?: (i: number) => number;
  /**
   * The largest radius `radiusAt` returns. It bounds which grid cells are searched, so a
   * larger radius is missed. Default: the largest drawn marker radius.
   */
  maxRadius?: number;
  /** False for a point the host does not draw or does not want picked. */
  pickable?: (i: number) => boolean;
  /**
   * Which of several hit points wins:
   *  - `'topmost'` (default, napari's `get_value`): the last drawn — highest index — whatever
   *    its distance, because that is the marker on top, the one the user sees.
   *  - `'nearest'`: the centre nearest the query; an exact tie goes to the later (topmost).
   */
  tieBreak?: 'topmost' | 'nearest';
}

const STRIDE = 12; // x, y, size, fr,fg,fb,fa, br,bg,bb,ba, symbol (code, or -1 = layer symbol)

function normalizePositions(positions: Float32Array | number[][]): Float32Array {
  if (positions instanceof Float32Array) return positions;
  const out = new Float32Array(positions.length * 2);
  positions.forEach((p, i) => {
    out[i * 2] = p[0];
    out[i * 2 + 1] = p[1];
  });
  return out;
}

/**
 * A scatter layer of point markers (the napari Points layer analog). Positions are `[x, y]`
 * pairs in data coordinates; size/colors may be uniform or per-point. Marker shape is one of
 * {@link PointSymbol}, per layer or per point. Mutating display props emits `changed`;
 * structural changes (positions/size/colors/per-point symbols) also bump {@link dataVersion}
 * so the visual rebuilds its instance buffer.
 */
export class PointsLayer extends Layer {
  readonly kind = 'points';
  readonly count: number;
  positions: Float32Array;
  dataVersion = 0;

  private _size: SizeInput;
  private _faceColor: ColorInput;
  private _borderColor: ColorInput;
  private _borderWidth: number;
  private _symbol: PointSymbol;
  private _symbols: Uint8Array | null;
  /** Lazily built pick index, and what it was built from. */
  private _pickIndex: {
    grid: GridIndex;
    positions: Float32Array;
    dataVersion: number;
    maxSize: number;
  } | null = null;

  constructor(positions: Float32Array | number[][], opts: PointsLayerOptions = {}) {
    super({ name: opts.name, scale: opts.scale, translate: opts.translate });
    this.positions = normalizePositions(positions);
    this.count = this.positions.length / 2;
    this._size = opts.size ?? 10;
    this._faceColor = checkColor(opts.faceColor ?? [1, 1, 1, 1], this.count, 'faceColor');
    this._borderColor = checkColor(opts.borderColor ?? [0, 0, 0, 1], this.count, 'borderColor');
    this._borderWidth = opts.borderWidth ?? 0;
    this._symbol = resolvePointSymbol(opts.symbol ?? 'disc');
    this._symbols = opts.symbols ? checkPointSymbols(opts.symbols, this.count) : null;
    if (opts.opacity !== undefined) this._opacity = opts.opacity;
    if (opts.blending !== undefined) this._blending = opts.blending;
    if (opts.visible !== undefined) this._visible = opts.visible;
  }

  get size(): SizeInput {
    return this._size;
  }
  set size(value: SizeInput) {
    this._size = value;
    this.dataVersion++;
    this.changed.emit(this);
  }

  get faceColor(): ColorInput {
    return this._faceColor;
  }
  set faceColor(value: ColorInput) {
    this._faceColor = checkColor(value, this.count, 'faceColor');
    this.dataVersion++;
    this.changed.emit(this);
  }

  get borderColor(): ColorInput {
    return this._borderColor;
  }
  set borderColor(value: ColorInput) {
    this._borderColor = checkColor(value, this.count, 'borderColor');
    this.dataVersion++;
    this.changed.emit(this);
  }

  /** Border thickness in data units. A uniform: changing it does not rebuild the instances. */
  get borderWidth(): number {
    return this._borderWidth;
  }
  set borderWidth(value: number) {
    this._borderWidth = value;
    this.changed.emit(this);
  }

  /** The layer's marker shape — every point's, unless {@link symbols} overrides it. */
  get symbol(): PointSymbol {
    return this._symbol;
  }
  set symbol(value: PointSymbol | PointSymbolAlias) {
    this._symbol = resolvePointSymbol(value);
    this.changed.emit(this);
  }

  /**
   * Per-point symbol codes (see {@link PointsLayerOptions.symbols}), or null when every point
   * uses {@link symbol}. Kept by reference; reassign (not mutate) it to redraw.
   */
  get symbols(): Uint8Array | null {
    return this._symbols;
  }
  set symbols(value: Uint8Array | null) {
    this._symbols = value ? checkPointSymbols(value, this.count) : null;
    this.dataVersion++;
    this.changed.emit(this);
  }

  /** The layer symbol's code: its index in {@link POINT_SYMBOLS} (disc 0, ring 1, square 2, …). */
  symbolCode(): number {
    return pointSymbolCode(this._symbol);
  }

  /** The symbol code point `i` is drawn with: its per-point code, else the layer's. */
  symbolCodeAt(i: number): number {
    const c = this._symbols ? this._symbols[i] : POINT_SYMBOL_LAYER_DEFAULT;
    return c === POINT_SYMBOL_LAYER_DEFAULT ? this.symbolCode() : c;
  }

  /** Per-point size at index `i`. */
  sizeAt(i: number): number {
    const s = this._size;
    return typeof s === 'number' ? s : s[i];
  }

  /**
   * Index of the point under world coordinates `(worldX, worldY)`, or -1 — napari's
   * `layer.get_value(position)` for points, and what a hover or click handler wants.
   *
   * A point is hit when the query lies within `max(radius, tolerance)` of its centre, the
   * radius being the drawn marker's (`sizeAt(i) / 2`, a disc whatever the symbol) or
   * `radiusAt(i)`. {@link PointsPickOptions.tieBreak} decides between several hits.
   *
   * Backed by a {@link GridIndex} over the data positions, built on the first pick and
   * rebuilt only after {@link dataVersion} moves or `positions` is replaced — so a pointer
   * move costs a few cells, not a scan. Query and radii are taken through the layer's
   * `scale`/`translate`; with an anisotropic scale distances use the geometric-mean scale.
   */
  pick(worldX: number, worldY: number, opts: PointsPickOptions = {}): number {
    const { tolerance = 0, radiusAt, pickable, tieBreak = 'topmost' } = opts;
    const [sx, sy] = this.scale;
    const [tx, ty] = this.translate;
    const k = Math.sqrt(Math.abs(sx * sy)) || 1; // world units per data unit
    const qx = (worldX - tx) / sx;
    const qy = (worldY - ty) / sy;
    const index = this.pickIndex();
    const maxRadius = opts.maxRadius ?? (index.maxSize / 2) * k;
    const reach = Math.max(tolerance, maxRadius) / k; // in data units
    const pos = this.positions;
    const topmost = tieBreak === 'topmost';
    let best = -1;
    let bestD2 = Infinity;
    index.grid.forEachCandidate(qx, qy, reach, (i) => {
      const dx = (pos[i * 2] - qx) * k;
      const dy = (pos[i * 2 + 1] - qy) * k;
      const d2 = dx * dx + dy * dy;
      const r = Math.max(radiusAt ? radiusAt(i) : (this.sizeAt(i) / 2) * k, tolerance);
      if (!(d2 <= r * r)) return;
      if (pickable && !pickable(i)) return;
      // Candidates do not arrive in index order, so both rules compare indices explicitly.
      if (topmost ? i > best : d2 < bestD2 || (d2 === bestD2 && i > best)) {
        best = i;
        bestD2 = d2;
      }
    });
    return best;
  }

  private pickIndex(): { grid: GridIndex; maxSize: number } {
    const cached = this._pickIndex;
    if (cached && cached.positions === this.positions && cached.dataVersion === this.dataVersion) {
      return cached;
    }
    let maxSize = 0;
    for (let i = 0; i < this.count; i++) {
      const sz = this.sizeAt(i);
      if (sz > maxSize) maxSize = sz;
    }
    // Cells at least one marker wide, so a typical query visits a 2×2 block.
    const bounds = GridIndex.boundsOf(this.positions);
    const cell = Math.max(GridIndex.suggestCell(bounds, this.count), maxSize);
    const grid = new GridIndex(this.positions, { cell, bounds });
    this._pickIndex = { grid, positions: this.positions, dataVersion: this.dataVersion, maxSize };
    return this._pickIndex;
  }

  /**
   * Build the interleaved instance buffer (count × 12 floats) for the GPU:
   * `x, y, size, face rgba, border rgba, symbol`. The symbol slot holds the per-point code,
   * or -1 for "the layer symbol" — so the layer `symbol` stays a uniform and changing it does
   * not rebuild the buffer.
   */
  buildInstanceData() {
    const out = new Float32Array(this.count * STRIDE);
    const symbols = this._symbols;
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      out[o] = this.positions[i * 2];
      out[o + 1] = this.positions[i * 2 + 1];
      out[o + 2] = this.sizeAt(i);
      writeColor(out, o + 3, this._faceColor, i);
      writeColor(out, o + 7, this._borderColor, i);
      const code = symbols ? symbols[i] : POINT_SYMBOL_LAYER_DEFAULT;
      out[o + 11] = code === POINT_SYMBOL_LAYER_DEFAULT ? -1 : code;
    }
    return out;
  }
}

/**
 * Validate a packed colour array's length, so a mismatch surfaces at the assignment and not as
 * a render. A short array would otherwise read past its end and colour the tail with NaN.
 */
function checkColor(color: ColorInput, n: number, what: string): ColorInput {
  if (color instanceof Float32Array && color.length !== n * 4) {
    throw new Error(
      `Points ${what} length (${color.length}) must equal 4 × point count (${n * 4}).`,
    );
  }
  return color;
}

function writeColor(out: Float32Array, offset: number, color: ColorInput, i: number): void {
  if (color instanceof Float32Array) {
    // Packed per-point RGBA: copy the four floats directly, no tuple in between.
    const s = i * 4;
    out[offset] = color[s];
    out[offset + 1] = color[s + 1];
    out[offset + 2] = color[s + 2];
    out[offset + 3] = color[s + 3];
    return;
  }
  const c = Array.isArray(color[0]) ? (color as RGBA[])[i] : (color as RGBA);
  out[offset] = c[0];
  out[offset + 1] = c[1];
  out[offset + 2] = c[2];
  out[offset + 3] = c[3];
}

export const POINTS_INSTANCE_STRIDE = STRIDE;
