import { Layer, type BlendMode } from './layer';
import { Colormap, resolveColormap } from '../color/colormap';

export type VolumeRendering = 'mip' | 'translucent' | 'iso';

export interface VolumeLayerOptions {
  name?: string;
  colormap?: Colormap | string;
  /** Normalization window in source-data units (default [0,255] for uint8). */
  contrastLimits?: [number, number];
  gamma?: number;
  rendering?: VolumeRendering;
  /** Iso threshold as a windowed value 0..1 (iso mode). */
  isoThreshold?: number;
  opacity?: number;
  blending?: BlendMode;
  visible?: boolean;
  /**
   * World size of one voxel per axis (x, y, z) — napari's `scale`. The rendered box is
   * `[width*sx, height*sy, depth*sz]`, so an anisotropic stack (e.g. XY downsampled but Z not)
   * keeps its true proportions instead of the raw voxel-count aspect. Default `[1, 1, 1]`.
   */
  voxelSize?: readonly [number, number, number];
}

/**
 * A 3D scalar volume (the napari Image-in-3D / volume analog), rendered by fragment
 * raymarching. `data` is an 8-bit scalar field of size `width*height*depth` in x-fastest
 * order. uint16/float volumes are a follow-up. Rendered only when `dims.ndisplay === 3`.
 */
export class VolumeLayer extends Layer {
  readonly kind = 'volume';
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly data: Uint8Array;

  colormapVersion = 0;
  /** Bumped when the box geometry (voxelSize) changes so the visual rebuilds its model matrix. */
  geometryVersion = 0;

  private _voxelSize: [number, number, number];

  private _colormap: Colormap;
  private _contrastLimits: [number, number];
  private _gamma: number;
  private _rendering: VolumeRendering;
  private _isoThreshold: number;

  constructor(
    data: Uint8Array,
    width: number,
    height: number,
    depth: number,
    opts: VolumeLayerOptions = {},
  ) {
    super({ name: opts.name });
    if (data.length < width * height * depth) {
      throw new Error(`Volume data (${data.length}) smaller than ${width}×${height}×${depth}.`);
    }
    this.data = data;
    this.width = width;
    this.height = height;
    this.depth = depth;
    const vs = opts.voxelSize;
    this._voxelSize = vs ? [vs[0], vs[1], vs[2]] : [1, 1, 1];
    this._colormap = resolveColormap(opts.colormap ?? 'viridis');
    this._contrastLimits = opts.contrastLimits ?? [0, 255];
    this._gamma = opts.gamma ?? 1;
    this._rendering = opts.rendering ?? 'mip';
    this._isoThreshold = opts.isoThreshold ?? 0.5;
    this._blending = opts.blending ?? 'translucent';
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

  /** World size of one voxel per axis (napari's `scale`); the rendered box is `dims * voxelSize`.
   *  Mutable so a host can restretch an axis live (e.g. a Z-height gizmo) — only the model matrix
   *  rebuilds, the volume texture is untouched. */
  get voxelSize(): readonly [number, number, number] {
    return [this._voxelSize[0], this._voxelSize[1], this._voxelSize[2]];
  }
  set voxelSize(value: readonly [number, number, number]) {
    this._voxelSize = [value[0], value[1], value[2]];
    this.geometryVersion++;
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

  get rendering(): VolumeRendering {
    return this._rendering;
  }
  set rendering(value: VolumeRendering) {
    this._rendering = value;
    this.changed.emit(this);
  }

  renderingCode(): number {
    return this._rendering === 'mip' ? 0 : this._rendering === 'translucent' ? 1 : 2;
  }

  get isoThreshold(): number {
    return this._isoThreshold;
  }
  set isoThreshold(value: number) {
    this._isoThreshold = value;
    this.changed.emit(this);
  }
}
