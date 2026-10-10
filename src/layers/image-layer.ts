import { Layer, type BlendMode } from './layer';
import { Colormap, resolveColormap } from '../color/colormap';
import { type TextureSource, defaultContrastLimits, isGrayscale } from '../io/texture-source';

export type Interpolation = 'nearest' | 'linear';

export interface ImageLayerOptions {
  name?: string;
  /** Scalar colormap; ignored for RGB(A) sources (rendered directly). Defaults to gray. */
  colormap?: Colormap | string;
  /** Normalization window in source-data units. Defaults to the source's dtype range. */
  contrastLimits?: [number, number];
  gamma?: number;
  invert?: boolean;
  /**
   * Scalar sources only: values at or below the low contrast limit draw fully transparent
   * instead of as the colormap's bottom colour — a density or heat map over an image, with
   * "nothing here" see-through. Compared in data units before `invert`, so moving
   * `contrastLimits` moves the cut-off without re-uploading anything. Default false.
   */
  transparentBelow?: boolean;
  opacity?: number;
  blending?: BlendMode;
  visible?: boolean;
  interpolation?: Interpolation;
  scale?: [number, number];
  translate?: [number, number];
}

/**
 * A 2D image layer. Carries the source pixels plus the scalar display pipeline
 * (contrast/gamma/invert/colormap). Display setters are reactive; changing them updates GPU
 * uniforms/LUT — never re-uploads the texture (tracked via {@link colormapVersion}).
 */
export class ImageLayer extends Layer {
  readonly kind = 'image';
  readonly source: TextureSource;
  readonly grayscale: boolean;

  /** Bumped whenever the colormap changes so the visual knows to rebuild its LUT. */
  colormapVersion = 0;

  private _colormap: Colormap | null;
  private _contrastLimits: [number, number];
  private _gamma: number;
  private _invert: boolean;
  private _transparentBelow: boolean;
  private _interpolation: Interpolation;

  constructor(source: TextureSource, opts: ImageLayerOptions = {}) {
    super({ name: opts.name, scale: opts.scale, translate: opts.translate });
    this.source = source;
    this.grayscale = isGrayscale(source);
    this._colormap = this.grayscale ? resolveColormap(opts.colormap ?? 'gray') : null;
    this._contrastLimits = opts.contrastLimits ?? defaultContrastLimits(source);
    this._gamma = opts.gamma ?? 1;
    this._invert = opts.invert ?? false;
    this._transparentBelow = opts.transparentBelow ?? false;
    this._interpolation = opts.interpolation ?? 'linear';
    if (opts.opacity !== undefined) this._opacity = opts.opacity;
    if (opts.blending !== undefined) this._blending = opts.blending;
    if (opts.visible !== undefined) this._visible = opts.visible;
  }

  get colormap(): Colormap | null {
    return this._colormap;
  }
  set colormap(value: Colormap | string | null) {
    // RGB(A) layers ignore colormaps (rendered directly).
    this._colormap = value === null ? null : this.grayscale ? resolveColormap(value) : null;
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

  get invert(): boolean {
    return this._invert;
  }
  set invert(value: boolean) {
    this._invert = value;
    this.changed.emit(this);
  }

  /** See {@link ImageLayerOptions.transparentBelow}. A uniform: no LUT or texture rebuild. */
  get transparentBelow(): boolean {
    return this._transparentBelow;
  }
  set transparentBelow(value: boolean) {
    this._transparentBelow = value;
    this.changed.emit(this);
  }

  get interpolation(): Interpolation {
    return this._interpolation;
  }
  set interpolation(value: Interpolation) {
    this._interpolation = value;
    this.changed.emit(this);
  }
}
