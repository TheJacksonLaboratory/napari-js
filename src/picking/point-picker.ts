import type { Camera3D } from '../camera/camera3d';
import type { Points3DLayer } from '../layers/points3d-layer';
import type { ProjectedPickOptions } from './pick';
import type { ProjectedPoints } from './project';
import { ScreenIndex, pickLinear, SCREEN_INDEX_MIN_POINTS } from './screen-index';

/** What a {@link PointPicker} needs from a viewer — `Viewer` and `HeadlessViewer` provide it. */
export interface PointPickerHost {
  readonly camera3d: Camera3D;
  projectPoints(positions: Float32Array, out?: Partial<ProjectedPoints>): ProjectedPoints | null;
  /** Canvas size in CSS pixels. */
  viewportSize(): [number, number];
}

export interface PointPickerOptions {
  /**
   * The largest distance in CSS pixels a drawn marker can reach from its centre — the
   * largest pick radius you will pass, times any per-point size scale. Centres within this
   * margin outside the canvas stay pickable. See {@link ScreenIndexOptions.maxReach}.
   */
  maxReach?: number;
  /** Grid cell in CSS pixels; see {@link ScreenIndexOptions.cell}. */
  cell?: number;
  /**
   * Below this many points a pick is a linear scan rather than an index build (identical
   * answer). Default {@link SCREEN_INDEX_MIN_POINTS}.
   */
  indexThreshold?: number;
}

/**
 * Depth-aware picking for a {@link Points3DLayer}, with the caching policy built in.
 *
 * {@link projectPoints}, {@link ScreenIndex} and {@link nearestProjectedIndex} are the
 * mechanism; this is the policy every host otherwise re-derives: keep the projection
 * buffers and reuse them, project LAZILY — on the first pick after the camera, the canvas
 * size or the layer's data moved, never on the camera event itself, so an orbit drag pays
 * nothing — and build the screen index in the same lazy slot once the cloud is large enough
 * for it to pay off.
 *
 * Invalidated by `camera3d.changed`, by `layer.dataVersion`, and by a canvas resize.
 * Styling (`alphas`, `sizes`, `colors`) does not move the projection.
 *
 * Unless a pick's options say otherwise, it follows what the layer draws: a point with
 * per-point alpha 0 (or colour alpha 0) is not pickable, and a point's radius is scaled by
 * its per-point `sizes` entry.
 */
export class PointPicker {
  private projection: ProjectedPoints | undefined;
  private index: ScreenIndex | null = null;
  private stale = true;
  private projectedVersion = -1;
  private projectedW = 0;
  private projectedH = 0;
  private projectedOk = false;
  private readonly off: () => void;
  private disposed = false;
  /** Largest per-point size scale, cached on the layer's style clock. */
  private maxScale = 1;
  private maxScaleOf: { sizes: Float32Array | null; styleVersion: number } | null = null;

  constructor(
    private readonly host: PointPickerHost,
    readonly layer: Points3DLayer,
    private readonly opts: PointPickerOptions = {},
  ) {
    this.off = host.camera3d.changed.connect(() => {
      this.stale = true;
    });
  }

  /**
   * The index of the point drawn under canvas-local CSS pixel `(canvasX, canvasY)`, or -1:
   * front-most wins, ties by cursor distance ({@link nearestProjectedIndex}'s rule).
   *
   * `radius` is the pick radius in CSS pixels. With an explicit `opts.radiusAt` it must be
   * the largest radius that returns, since it bounds the search.
   */
  pick(canvasX: number, canvasY: number, radius: number, opts?: ProjectedPickOptions): number {
    if (this.disposed) throw new Error('PointPicker: pick() after dispose().');
    if (!this.refresh()) return -1;
    const resolved = opts ?? {};
    const style = this.styleOptions(radius, resolved);
    const projection = this.projection!;
    return this.index
      ? this.index.pick(canvasX, canvasY, style.reach, style.opts)
      : pickLinear(projection, canvasX, canvasY, style.reach, style.opts);
  }

  /** The cached projection — refreshed if stale — or null before the canvas has a size. */
  projected(): ProjectedPoints | null {
    return this.refresh() ? this.projection! : null;
  }

  /** Force the next pick to re-project (e.g. after mutating `layer.positions` in place). */
  invalidate(): void {
    this.stale = true;
  }

  /** Stop listening to the camera and drop the buffers. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.off();
    this.projection = undefined;
    this.index = null;
  }

  private refresh(): boolean {
    const [w, h] = this.host.viewportSize();
    if (
      !this.stale &&
      this.projectedVersion === this.layer.dataVersion &&
      this.projectedW === w &&
      this.projectedH === h
    ) {
      return this.projectedOk;
    }
    this.stale = false;
    this.projectedVersion = this.layer.dataVersion;
    this.projectedW = w;
    this.projectedH = h;
    this.index = null;
    // Reuses the previous buffers when the point count is unchanged.
    const projected = this.host.projectPoints(this.layer.positions, this.projection);
    this.projectedOk = projected !== null;
    if (!projected) return false;
    this.projection = projected;
    const threshold = this.opts.indexThreshold ?? SCREEN_INDEX_MIN_POINTS;
    if (this.layer.count >= threshold) {
      this.index = new ScreenIndex(projected, w, h, {
        maxReach: this.opts.maxReach,
        cell: this.opts.cell,
      });
    }
    return true;
  }

  /** Default `radiusAt` / `pickable` from the layer's per-point style, unless given. */
  private styleOptions(
    radius: number,
    opts: ProjectedPickOptions,
  ): { reach: number; opts: ProjectedPickOptions } {
    const { sizes, alphas, colors } = this.layer;
    let reach = radius;
    let radiusAt = opts.radiusAt;
    if (!radiusAt && sizes) {
      reach = radius * this.largestSizeScale(sizes);
      radiusAt = (i) => radius * sizes[i];
    }
    let pickable = opts.pickable;
    if (!pickable && (alphas || colors)) {
      pickable = (i) => (!alphas || alphas[i] > 0) && (!colors || colors[i * 4 + 3] > 0);
    }
    return { reach, opts: { radiusAt, pickable } };
  }

  /** One pass over `sizes` per style change, not per pick. */
  private largestSizeScale(sizes: Float32Array): number {
    const key = this.maxScaleOf;
    if (!key || key.sizes !== sizes || key.styleVersion !== this.layer.styleVersion) {
      let max = 0;
      for (let i = 0; i < sizes.length; i++) if (sizes[i] > max) max = sizes[i];
      this.maxScale = max;
      this.maxScaleOf = { sizes, styleVersion: this.layer.styleVersion };
    }
    return this.maxScale;
  }
}
