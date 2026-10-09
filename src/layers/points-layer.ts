import { Layer, type BlendMode } from './layer';

export type PointSymbol = 'disc' | 'ring' | 'square';
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
  symbol?: PointSymbol;
  opacity?: number;
  blending?: BlendMode;
  visible?: boolean;
  scale?: [number, number];
  translate?: [number, number];
}

const STRIDE = 12; // x, y, size, fr,fg,fb,fa, br,bg,bb,ba, borderWidth

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
 * {@link PointSymbol}. Mutating display props emits `changed`; structural changes
 * (positions/size/colors) also bump {@link dataVersion} so the visual rebuilds its instance
 * buffer.
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

  constructor(positions: Float32Array | number[][], opts: PointsLayerOptions = {}) {
    super({ name: opts.name, scale: opts.scale, translate: opts.translate });
    this.positions = normalizePositions(positions);
    this.count = this.positions.length / 2;
    this._size = opts.size ?? 10;
    this._faceColor = checkColor(opts.faceColor ?? [1, 1, 1, 1], this.count, 'faceColor');
    this._borderColor = checkColor(opts.borderColor ?? [0, 0, 0, 1], this.count, 'borderColor');
    this._borderWidth = opts.borderWidth ?? 0;
    this._symbol = opts.symbol ?? 'disc';
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

  get borderWidth(): number {
    return this._borderWidth;
  }
  set borderWidth(value: number) {
    this._borderWidth = value;
    this.dataVersion++;
    this.changed.emit(this);
  }

  get symbol(): PointSymbol {
    return this._symbol;
  }
  set symbol(value: PointSymbol) {
    this._symbol = value;
    this.changed.emit(this);
  }

  symbolCode(): number {
    return this._symbol === 'disc' ? 0 : this._symbol === 'ring' ? 1 : 2;
  }

  /** Per-point size at index `i`. */
  sizeAt(i: number): number {
    const s = this._size;
    return typeof s === 'number' ? s : s[i];
  }

  /** Build the interleaved instance buffer (count × 12 floats) for the GPU. */
  buildInstanceData() {
    const out = new Float32Array(this.count * STRIDE);
    for (let i = 0; i < this.count; i++) {
      const o = i * STRIDE;
      out[o] = this.positions[i * 2];
      out[o + 1] = this.positions[i * 2 + 1];
      out[o + 2] = this.sizeAt(i);
      writeColor(out, o + 3, this._faceColor, i);
      writeColor(out, o + 7, this._borderColor, i);
      out[o + 11] = this._borderWidth;
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
