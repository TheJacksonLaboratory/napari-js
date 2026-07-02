import { Layer } from './layer';
import type { RGB } from '../color/colormap';

/** Per-axis colours (linear RGB 0..1). Default follows the common X=red, Y=green, Z=blue. */
export interface AxesColors {
  x: RGB;
  y: RGB;
  z: RGB;
}

export interface AxesLayerOptions {
  name?: string;
  /** Physical size of one voxel per axis (e.g. µm). Metadata for a host scale legend; the
   *  geometry itself is in voxel/world units. */
  voxelSize?: [number, number, number];
  /** Number of tick marks along each axis (uniform divisions). 0 disables ticks. */
  tickCount?: number;
  /** Draw the volume bounding-box wireframe. */
  boundingBox?: boolean;
  visible?: boolean;
  colors?: AxesColors;
}

const DEFAULT_COLORS: AxesColors = {
  x: [0.93, 0.27, 0.27],
  y: [0.3, 0.85, 0.35],
  z: [0.4, 0.55, 1.0],
};
const BOX_COLOR: RGB = [0.5, 0.5, 0.55];

/**
 * A 3D coordinate-axes / scale gizmo for the volume view (napari's axes visual analog). Drawn as
 * GPU line segments in the same centred world box the {@link VolumeLayer} occupies
 * (`[-w/2,w/2] × [-h/2,h/2] × [-d/2,d/2]`): three coloured axes from the box's min corner, tick
 * marks, and an optional bounding box. `voxelSize` is carried so a host can label the physical
 * scale. Renders only in 3D (`ndisplay === 3`).
 */
export class AxesLayer extends Layer {
  readonly kind = 'axes';
  colors: AxesColors;

  /** Bumped when a geometry-affecting property changes so the visual rebuilds its vertex buffer. */
  geometryVersion = 0;

  private _width: number;
  private _height: number;
  private _depth: number;
  private _voxelSize: [number, number, number];
  private _tickCount: number;
  private _boundingBox: boolean;

  constructor(width: number, height: number, depth: number, opts: AxesLayerOptions = {}) {
    super({ name: opts.name });
    this._width = width;
    this._height = height;
    this._depth = depth;
    this._voxelSize = opts.voxelSize ?? [1, 1, 1];
    this._tickCount = opts.tickCount ?? 5;
    this._boundingBox = opts.boundingBox ?? true;
    this.colors = opts.colors ?? DEFAULT_COLORS;
    if (opts.visible !== undefined) this._visible = opts.visible;
  }

  /** Box extent per axis (world units). Mutable so a host can restretch the gizmo live (e.g. a
   *  Z-height control) — the visual rebuilds its line geometry on the version bump. */
  get width(): number {
    return this._width;
  }
  set width(v: number) {
    this._width = v;
    this.geometryVersion++;
    this.changed.emit(this);
  }
  get height(): number {
    return this._height;
  }
  set height(v: number) {
    this._height = v;
    this.geometryVersion++;
    this.changed.emit(this);
  }
  get depth(): number {
    return this._depth;
  }
  set depth(v: number) {
    this._depth = v;
    this.geometryVersion++;
    this.changed.emit(this);
  }

  get voxelSize(): [number, number, number] {
    return [this._voxelSize[0], this._voxelSize[1], this._voxelSize[2]];
  }
  set voxelSize(v: [number, number, number]) {
    this._voxelSize = [v[0], v[1], v[2]];
    this.geometryVersion++;
    this.changed.emit(this);
  }

  get tickCount(): number {
    return this._tickCount;
  }
  set tickCount(v: number) {
    this._tickCount = Math.max(0, Math.floor(v));
    this.geometryVersion++;
    this.changed.emit(this);
  }

  get boundingBox(): boolean {
    return this._boundingBox;
  }
  set boundingBox(v: boolean) {
    this._boundingBox = v;
    this.geometryVersion++;
    this.changed.emit(this);
  }

  /** Physical extent of each axis (`dim * voxelSize`), for a host scale legend. */
  get physicalExtent(): [number, number, number] {
    return [
      this.width * this._voxelSize[0],
      this.height * this._voxelSize[1],
      this.depth * this._voxelSize[2],
    ];
  }
}

/**
 * Build the gizmo's line-segment geometry as interleaved `[x,y,z, r,g,b]` vertices (two per
 * segment, `line-list` topology). Pure (no GPU) so it's unit-testable. Geometry lives in the
 * centred world box matching the volume.
 */
export function axesLineVertices(layer: AxesLayer): Float32Array {
  const { width: w, height: h, depth: d, colors } = layer;
  const hx = w / 2;
  const hy = h / 2;
  const hz = d / 2;
  const out: number[] = [];
  const seg = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    c: RGB,
  ): void => {
    out.push(ax, ay, az, c[0], c[1], c[2], bx, by, bz, c[0], c[1], c[2]);
  };

  if (layer.boundingBox) {
    const xs = [-hx, hx];
    const ys = [-hy, hy];
    const zs = [-hz, hz];
    for (const y of ys) for (const z of zs) seg(-hx, y, z, hx, y, z, BOX_COLOR);
    for (const x of xs) for (const z of zs) seg(x, -hy, z, x, hy, z, BOX_COLOR);
    for (const x of xs) for (const y of ys) seg(x, y, -hz, x, y, hz, BOX_COLOR);
  }

  // Coloured axes from the box's min corner.
  const ox = -hx;
  const oy = -hy;
  const oz = -hz;
  seg(ox, oy, oz, ox + w, oy, oz, colors.x);
  seg(ox, oy, oz, ox, oy + h, oz, colors.y);
  seg(ox, oy, oz, ox, oy, oz + d, colors.z);

  // Tick marks at uniform divisions along each axis.
  const n = layer.tickCount;
  if (n > 0) {
    const tick = Math.max(w, h, d) * 0.03;
    for (let i = 1; i <= n; i++) {
      seg(ox + (w * i) / n, oy, oz, ox + (w * i) / n, oy + tick, oz, colors.x);
      seg(ox, oy + (h * i) / n, oz, ox + tick, oy + (h * i) / n, oz, colors.y);
      seg(ox, oy, oz + (d * i) / n, ox + tick, oy, oz + (d * i) / n, colors.z);
    }
  }

  return new Float32Array(out);
}
