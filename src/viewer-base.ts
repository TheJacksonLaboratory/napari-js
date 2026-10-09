import { ViewerModel } from './scene/viewer-model';
import type { Camera } from './camera/camera';
import type { LayerList } from './scene/layer-list';
import { ImageLayer, type ImageLayerOptions } from './layers/image-layer';
import { PointsLayer, type PointsLayerOptions } from './layers/points-layer';
import { LabelsLayer, type LabelsLayerOptions, type LabelData } from './layers/labels-layer';
import { VolumeLayer, type VolumeLayerOptions } from './layers/volume-layer';
import { AxesLayer, type AxesLayerOptions } from './layers/axes-layer';
import { SurfaceLayer, type SurfaceLayerOptions, type SurfaceBounds } from './layers/surface-layer';
import { Points3DLayer, type Points3DLayerOptions } from './layers/points3d-layer';
import { ShapesLayer, type ShapesLayerOptions } from './layers/shapes-layer';
import type { Fit3D } from './layers/layer';
import { unionBounds, Fit3DState, framingFor } from './scene/fit';
import { projectPoints, type ProjectedPoints } from './picking/project';
import { toTextureSource, depthOf, type ImageInput } from './io/texture-source';
import { worldViewport, type Rect } from './io/pyramid';
import type { Dims } from './scene/dims';
import type { Camera3D, CameraDragMode } from './camera/camera3d';
import { histogramScalar, type Histogram } from './color/histogram';

/**
 * The slice of an `HTMLCanvasElement` the viewer's GPU-free logic reads: its CSS layout size,
 * its drawing-buffer size, and its client rect. An `HTMLCanvasElement` satisfies it; the
 * headless viewer in `napari-js/testing` supplies a virtual one.
 */
export interface CanvasGeometry {
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly width: number;
  readonly height: number;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/**
 * Everything a viewer does that does not need a GPU: the {@link ViewerModel}, layer
 * construction for every `add*`, 3D framing, and the canvas ↔ world / projection maths.
 *
 * It exists so {@link Viewer} and the headless viewer in `napari-js/testing` are one
 * implementation rather than two that drift: a test double that re-implements `addSurface` or
 * `fitToLayers` tests the double, not the library. Each subclass supplies only the canvas
 * geometry and what it does about rendering.
 */
export abstract class ViewerBase {
  readonly model = new ViewerModel();

  /** Resolves once the viewer can render. */
  abstract readonly ready: Promise<void>;

  private firstImageFitted = false;
  private readonly fit3d: Fit3DState;

  protected constructor(
    protected readonly canvas: CanvasGeometry,
    fit3d: Fit3D = 'always',
  ) {
    this.fit3d = new Fit3DState(fit3d);
  }

  /** Request a coalesced redraw. */
  abstract requestRender(): void;

  /** Release the viewer's resources. */
  abstract dispose(): void;

  get camera(): Camera {
    return this.model.camera;
  }

  get layers(): LayerList {
    return this.model.layers;
  }

  get dims(): Dims {
    return this.model.dims;
  }

  get camera3d(): Camera3D {
    return this.model.camera3d;
  }

  /** Set what a pointer drag does in 3D: 'rotate' (default), 'pan', or 'zoom' (dolly). */
  setCameraDragMode(mode: CameraDragMode): void {
    this.model.camera3d.dragMode = mode;
  }

  /** Add an image layer. Accepts typed pixels or a decoded image (see {@link ImageInput}). */
  addImage(input: ImageInput, opts: ImageLayerOptions = {}): ImageLayer {
    const source = toTextureSource(input);
    const layer = new ImageLayer(source, opts);
    this.model.layers.add(layer);
    this.model.dims.depth = Math.max(this.model.dims.depth, depthOf(source));
    this.maybeFitFirst(source.width, source.height);
    return layer;
  }

  /** Add a points (scatter) layer. Positions are `[x, y]` pairs in data coordinates. */
  addPoints(positions: Float32Array | number[][], opts: PointsLayerOptions = {}): PointsLayer {
    const layer = new PointsLayer(positions, opts);
    this.model.layers.add(layer);
    return layer;
  }

  /**
   * Add a 2D polygon layer from flat rings: `coords` is `[x0,y0,x1,y1,…]` in data
   * coordinates and `offsets` has `shapeCount + 1` vertex offsets, so shape `i` is
   * `coords[2*offsets[i] .. 2*offsets[i+1])` and closes implicitly. Draws boundaries
   * (`draw: 'outline'`, the default) or interiors (`'fill'`), optionally coloured by
   * one scalar per shape through a colormap. Stays in 2D — unlike the volume/surface
   * adders it does not switch `ndisplay`.
   */
  addShapes(
    coords: Float32Array,
    offsets: Uint32Array,
    opts: ShapesLayerOptions = {},
  ): ShapesLayer {
    const layer = new ShapesLayer(coords, offsets, opts);
    this.model.layers.add(layer);
    return layer;
  }

  /** Add a labels (segmentation) layer from an integer id image (uint8/uint16/uint32). */
  addLabels(
    data: LabelData,
    width: number,
    height: number,
    opts: LabelsLayerOptions = {},
  ): LabelsLayer {
    const layer = new LabelsLayer(data, width, height, opts);
    this.model.layers.add(layer);
    this.maybeFitFirst(width, height);
    return layer;
  }

  /**
   * Add a 3D volume layer (uint8 scalar field, x-fastest). Switches the viewer to 3D
   * (`dims.ndisplay = 3`) and frames the orbit camera on the volume.
   */
  addVolume(
    data: Uint8Array,
    width: number,
    height: number,
    depth: number,
    opts: VolumeLayerOptions = {},
  ): VolumeLayer {
    const layer = new VolumeLayer(data, width, height, depth, opts);
    this.model.layers.add(layer);
    if (this.shouldFit3D(opts.fit)) {
      // Frame the camera on the WORLD box (dims × voxelSize), not the raw voxel counts, so an
      // anisotropic/downsampled volume is framed at its true rendered size.
      const [sx, sy, sz] = layer.voxelSize;
      this.model.camera3d.frame(width * sx, height * sy, depth * sz);
    }
    this.model.dims.ndisplay = 3;
    return layer;
  }

  /**
   * Add a 3D triangular-mesh surface (the napari `Surface` layer analog): `vertices` (N×3,
   * world/data coords, x-fastest), `faces` (M×3 triangle indices), and optional per-vertex
   * `values` colored through a colormap (defaults to coloring by z). Switches the viewer to 3D
   * (`dims.ndisplay = 3`) and frames the orbit camera on the mesh bounds. Build a height-field
   * mesh from a 2D scalar image with {@link heightField}.
   */
  addSurface(
    vertices: Float32Array,
    faces: Uint32Array,
    values?: Float32Array,
    opts: SurfaceLayerOptions = {},
  ): SurfaceLayer {
    const layer = new SurfaceLayer(vertices, faces, values, opts);
    this.model.layers.add(layer);
    if (this.shouldFit3D(opts.fit)) this.frameOn(layer.bounds());
    this.model.dims.ndisplay = 3;
    return layer;
  }

  /**
   * Add a 3D scatter of point markers (the napari Points-in-3D analog): `positions` (N×3,
   * world/data coords, x-fastest) with optional per-point `values` colored through a colormap.
   * Switches the viewer to 3D (`dims.ndisplay = 3`) and frames the orbit camera on the points.
   */
  addPoints3D(
    positions: Float32Array,
    values?: Float32Array,
    opts: Points3DLayerOptions = {},
  ): Points3DLayer {
    const layer = new Points3DLayer(positions, values, opts);
    this.model.layers.add(layer);
    if (this.shouldFit3D(opts.fit)) this.frameOn(layer.bounds());
    this.model.dims.ndisplay = 3;
    return layer;
  }

  /**
   * Add a 3D coordinate-axes / scale gizmo sized to a `[width,height,depth]` volume (it shares
   * the volume's centred world box). Renders only in 3D; toggle with `layer.visible`.
   */
  addAxes(width: number, height: number, depth: number, opts: AxesLayerOptions = {}): AxesLayer {
    const layer = new AxesLayer(width, height, depth, opts);
    this.model.layers.add(layer);
    return layer;
  }

  /** Convert canvas client coordinates to data/world coordinates (for picking). */
  canvasToWorld(clientX: number, clientY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left - rect.width / 2;
    const py = clientY - rect.top - rect.height / 2;
    const { zoom } = this.model.camera;
    const [cx, cy] = this.model.camera.center;
    return [cx + px / zoom, cy + py / zoom];
  }

  /** Inverse of {@link canvasToWorld}: data/world coords → canvas client coords. Lets a host
   *  position an overlay (e.g. region polygons) over the rendered canvas. */
  worldToCanvas(worldX: number, worldY: number): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    const { zoom } = this.model.camera;
    const [cx, cy] = this.model.camera.center;
    return [
      rect.left + rect.width / 2 + (worldX - cx) * zoom,
      rect.top + rect.height / 2 + (worldY - cy) * zoom,
    ];
  }

  /** The data/world rectangle currently visible (2D), in data coordinates. A host can clamp
   *  this to the image bounds to obtain the displayed source rect. */
  visibleWorldRect(): Rect {
    const vw = this.canvas.clientWidth || this.canvas.width || 1;
    const vh = this.canvas.clientHeight || this.canvas.height || 1;
    const { zoom } = this.model.camera;
    const [cx, cy] = this.model.camera.center;
    return worldViewport(cx, cy, zoom, vw, vh);
  }

  /**
   * Frame the orbit camera on the union of every 3D layer that has bounds.
   *
   * The deliberate counterpart to {@link Fit3D}: with `once` or `never` the host decides
   * when framing happens, and this is how it asks. Returns false when nothing 3D is
   * mounted, so it is safe to call on a scene that is still loading.
   *
   * A successful fit COUNTS as the scene's framing. Otherwise, under `once`, framing here
   * and then adding one more layer would reframe on that layer alone — silently undoing
   * the union the host just asked for, which is the opposite of what an explicit call
   * should do.
   */
  fitToLayers(): boolean {
    const b = unionBounds(this.model.layers);
    if (!b) return false;
    this.frameOn(b);
    this.fit3d.markFitted();
    return true;
  }

  /**
   * Let the next 3D add frame again under the `once` policy.
   *
   * Call it when the scene's subject changes — a new dataset, a cleared viewer — so the
   * first add of the new scene frames while the rest of it leaves the pose alone.
   */
  resetFit3D(): void {
    this.fit3d.reset();
  }

  /**
   * Project world points to canvas CSS pixels under the current 3D camera.
   *
   * The convenience form of {@link projectPoints}: it supplies the live view-projection and
   * the canvas size, which is what a host would otherwise have to assemble itself — and
   * getting the viewport in CSS rather than device pixels wrong is the usual way an overlay
   * ends up offset on a retina display. Null before the canvas has a size.
   */
  projectPoints(positions: Float32Array, out?: Partial<ProjectedPoints>): ProjectedPoints | null {
    const vw = this.canvas.clientWidth || this.canvas.width;
    const vh = this.canvas.clientHeight || this.canvas.height;
    if (!vw || !vh) return null;
    return projectPoints(this.model.camera3d.viewProjection(vw, vh), positions, vw, vh, out);
  }

  /**
   * Per-channel, native-bit-depth histogram of a single-channel {@link ImageLayer} computed
   * directly from its in-memory source data (uint8 → 0..255, uint16 → 0..65535, float32 →
   * data min/max). Returns `null` for RGBA, tiled, or external sources (no in-memory scalars).
   */
  layerHistogram(layer: ImageLayer, bins = 256): Histogram | null {
    const src = layer.source;
    if (src.kind !== 'typed' || src.channels !== 1) return null;
    let min: number;
    let max: number;
    if (src.dtype === 'uint8') [min, max] = [0, 255];
    else if (src.dtype === 'uint16') [min, max] = [0, 65535];
    else {
      min = Infinity;
      max = -Infinity;
      for (let i = 0; i < src.data.length; i++) {
        if (src.data[i] < min) min = src.data[i];
        if (src.data[i] > max) max = src.data[i];
      }
      if (!isFinite(min)) [min, max] = [0, 1];
    }
    return histogramScalar(src.data, bins, min, max);
  }

  /** Whether this add should move the camera, recording that a framing happened. */
  private shouldFit3D(override?: Fit3D): boolean {
    return this.fit3d.claim(override);
  }

  private frameOn(b: SurfaceBounds): void {
    // The viewer is the only party that knows both the camera's field of view and the
    // canvas's shape, which is exactly what a correct framing distance needs.
    const vw = this.canvas.clientWidth || this.canvas.width || 1;
    const vh = this.canvas.clientHeight || this.canvas.height || 1;
    const { target, distance } = framingFor(b, {
      fov: this.model.camera3d.fov,
      aspect: vw / vh,
    });
    this.model.camera3d.target = target;
    this.model.camera3d.distance = distance;
  }

  private maybeFitFirst(width: number, height: number): void {
    if (this.firstImageFitted) return;
    const vw = this.canvas.clientWidth;
    const vh = this.canvas.clientHeight;
    if (vw > 0 && vh > 0) {
      this.model.camera.fit(width, height, vw, vh);
      this.firstImageFitted = true;
    }
  }
}
