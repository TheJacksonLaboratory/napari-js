import { acquireDevice, type DeviceContext } from './engine/device';
import { CanvasTarget } from './engine/canvas';
import { Renderer } from './engine/renderer';
import { ViewerModel } from './scene/viewer-model';
import type { Camera } from './camera/camera';
import type { LayerList } from './scene/layer-list';
import { attachCameraControls, type CameraControlOptions } from './camera/controls';
import { ImageLayer, type ImageLayerOptions } from './layers/image-layer';
import { PointsLayer, type PointsLayerOptions } from './layers/points-layer';
import { LabelsLayer, type LabelsLayerOptions, type LabelData } from './layers/labels-layer';
import { VolumeLayer, type VolumeLayerOptions } from './layers/volume-layer';
import { AxesLayer, type AxesLayerOptions } from './layers/axes-layer';
import { SurfaceLayer, type SurfaceLayerOptions } from './layers/surface-layer';
import { Points3DLayer, type Points3DLayerOptions } from './layers/points3d-layer';
import { ShapesLayer, type ShapesLayerOptions } from './layers/shapes-layer';
import type { Layer } from './layers/layer';
import { toTextureSource, depthOf, type ImageInput } from './io/texture-source';
import { worldViewport, type Rect } from './io/pyramid';
import type { Dims } from './scene/dims';
import type { Camera3D, CameraDragMode } from './camera/camera3d';
import { attachOrbitControls } from './camera/controls3d';
import { readTextureToRGBA, type PixelData } from './engine/readback';
import { histogramRGBA, histogramScalar, type Histogram } from './color/histogram';
import type { RenderInputs } from './engine/renderer';

export interface ViewerOptions {
  canvas: HTMLCanvasElement;
  /** Background clear color (RGBA 0..1). */
  background?: GPUColor;
  /** Attach pointer/wheel pan-zoom controls (default true). */
  controls?: boolean;
  /** Observe the canvas with a ResizeObserver and redraw on size changes (default true). */
  autoResize?: boolean;
  /** Wheel-zoom sensitivity (smaller = gentler), in BOTH 2D pan-zoom and the 3D orbit dolly;
   *  see {@link DEFAULT_WHEEL_ZOOM_SPEED}. */
  wheelZoomSpeed?: number;
  /** Click-to-zoom step (default 2× in / 0.5× out; 0 disables). 2D only. */
  clickZoomFactor?: number;
  /** Ease zoom toward its target over this time constant in ms instead of jumping to it; 0 for
   *  instant. See {@link DEFAULT_ZOOM_SMOOTHING_MS}. 2D only. */
  zoomSmoothingMs?: number;
}

/**
 * The napari-js viewer: a headless {@link ViewerModel} (layers + camera) plus a WebGPU
 * renderer. Construction kicks off async device acquisition — await {@link ready} before
 * the first render. Adding layers / mutating display props schedules a coalesced redraw.
 */
export class Viewer {
  readonly ready: Promise<void>;
  readonly model = new ViewerModel();

  private readonly canvas: HTMLCanvasElement;
  private readonly background: GPUColor;
  private controlsEnabled: boolean;
  private readonly autoResize: boolean;
  private readonly cameraControlOpts: CameraControlOptions;

  private ctx?: DeviceContext;
  private target?: CanvasTarget;
  private renderer?: Renderer;
  private detachControls?: () => void;
  private lastControlsNdisplay?: 2 | 3;
  private resizeObserver?: ResizeObserver;
  private frameScheduled = false;
  private firstImageFitted = false;
  private disposed = false;

  constructor(options: ViewerOptions) {
    this.canvas = options.canvas;
    this.background = options.background ?? { r: 0.07, g: 0.07, b: 0.09, a: 1 };
    this.controlsEnabled = options.controls ?? true;
    this.autoResize = options.autoResize ?? true;
    this.cameraControlOpts = {
      wheelZoomSpeed: options.wheelZoomSpeed,
      zoomSmoothingMs: options.zoomSmoothingMs,
      clickZoomFactor: options.clickZoomFactor,
    };
    this.ready = this.init();
  }

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

  get device(): GPUDevice | undefined {
    return this.ctx?.device;
  }

  private async init(): Promise<void> {
    await this.setupGpu();

    // DOM/model listeners are wired once (they reference `this.renderer`, which is
    // reassigned on device recovery, so they keep working across a device loss).
    this.model.layers.added.connect((layer) => {
      this.renderer?.addLayer(layer);
      this.requestRender();
    });
    this.model.layers.removed.connect((layer) => {
      this.renderer?.removeLayer(layer.id);
      this.requestRender();
    });
    this.model.changed.connect(() => this.requestRender());

    // Wire controls unconditionally; `installControls` honours `controlsEnabled`, so toggling
    // it at runtime (region drawing ↔ navigation) re-attaches/detaches correctly.
    this.installControls();
    this.model.dims.changed.connect(() => this.installControls());
    if (this.autoResize && typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.requestRender());
      this.resizeObserver.observe(this.canvas);
    }
    this.requestRender();
  }

  /** Acquire the device, (re)build the canvas target + renderer, register existing layers,
   *  and arm device-loss recovery. Run on first init and again after a device loss. */
  private async setupGpu(): Promise<void> {
    this.ctx = await acquireDevice();
    this.target = new CanvasTarget(this.canvas, this.ctx.device);
    this.target.syncSize();
    this.renderer = new Renderer(this.ctx.device, this.target, {
      float32Filterable: this.ctx.features.float32Filterable,
      onNeedsRedraw: () => this.requestRender(),
    });
    for (const layer of this.model.layers) {
      this.renderer.addLayer(layer);
    }
    void this.ctx.device.lost.then((info) => {
      // `destroyed` = we called dispose()/destroy() ourselves — don't try to recover.
      if (this.disposed || info.reason === 'destroyed') return;
      console.warn(`[napari-js] WebGPU device lost (${info.reason}): ${info.message}. Recovering…`);
      void this.recover();
    });
  }

  /** Re-acquire the GPU and rebuild all resources after a device loss. */
  private async recover(): Promise<void> {
    try {
      await this.setupGpu();
      this.requestRender();
    } catch (err) {
      console.error('[napari-js] device recovery failed:', err);
    }
  }

  /** Attach the 2D pan/zoom or 3D orbit controls to match `dims.ndisplay`. Detaches and stays
   *  detached while {@link controlsEnabled} is false (e.g. a host owns the pointer for drawing). */
  private installControls(): void {
    if (!this.controlsEnabled) {
      this.detachControls?.();
      this.detachControls = undefined;
      this.lastControlsNdisplay = undefined;
      return;
    }
    const nd = this.model.dims.ndisplay;
    if (nd === this.lastControlsNdisplay && this.detachControls) return;
    this.lastControlsNdisplay = nd;
    this.detachControls?.();
    this.detachControls =
      nd === 3
        ? attachOrbitControls(this.canvas, this.model.camera3d, this.cameraControlOpts)
        : attachCameraControls(this.canvas, this.model.camera, this.cameraControlOpts);
  }

  /**
   * Enable or disable pointer pan/zoom (2D) / orbit (3D) controls at runtime. Disable so a host
   * can take over the pointer for region drawing without the camera also panning/zooming; call
   * again with `true` to restore navigation. Mirrors the `controls` constructor option.
   */
  setControlsEnabled(enabled: boolean): void {
    if (this.controlsEnabled === enabled) return;
    this.controlsEnabled = enabled;
    this.installControls();
  }

  /** Whether pointer pan/zoom/orbit controls are currently attached. */
  get controlsActive(): boolean {
    return this.controlsEnabled;
  }

  private renderInputs(): RenderInputs {
    return {
      camera2d: this.model.camera,
      camera3d: this.model.camera3d,
      ndisplay: this.model.dims.ndisplay,
      z: this.model.dims.z,
    };
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
    // Frame the camera on the WORLD box (dims × voxelSize), not the raw voxel counts, so an
    // anisotropic/downsampled volume is framed at its true rendered size.
    const [sx, sy, sz] = layer.voxelSize;
    this.model.camera3d.frame(width * sx, height * sy, depth * sz);
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
    const b = layer.bounds();
    this.model.camera3d.target = b.center;
    this.model.camera3d.distance = Math.max(b.radius * 2.5, 1e-3);
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
    const b = layer.bounds();
    this.model.camera3d.target = b.center;
    this.model.camera3d.distance = Math.max(b.radius * 2.5, 1e-3);
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

  private maybeFitFirst(width: number, height: number): void {
    if (this.firstImageFitted) return;
    const vw = this.canvas.clientWidth;
    const vh = this.canvas.clientHeight;
    if (vw > 0 && vh > 0) {
      this.model.camera.fit(width, height, vw, vh);
      this.firstImageFitted = true;
    }
  }

  /** Request a coalesced redraw on the next animation frame. No-op until {@link ready}. */
  requestRender(): void {
    if (this.frameScheduled || !this.renderer || !this.target) return;
    this.frameScheduled = true;
    requestAnimationFrame(() => {
      this.frameScheduled = false;
      this.renderFrame();
    });
  }

  private renderFrame(): void {
    if (!this.renderer || !this.target) return;
    this.target.syncSize();
    this.renderer.render(this.renderInputs(), this.allLayers(), this.background);
  }

  private allLayers(): readonly Layer[] {
    return this.model.layers.items;
  }

  /**
   * Read back the composited displayed pixels as RGBA8 (top row first), by rendering the
   * current scene into an offscreen texture at the canvas's device-pixel size.
   */
  async readDisplayedPixels(): Promise<PixelData> {
    if (!this.renderer || !this.target || !this.ctx) {
      throw new Error('Viewer is not ready — await `viewer.ready` first.');
    }
    const w = Math.max(1, this.canvas.width);
    const h = Math.max(1, this.canvas.height);
    const cssW = this.canvas.clientWidth || w;
    const cssH = this.canvas.clientHeight || h;
    // Use the canvas/swapchain format (e.g. bgra8unorm on Metal) so the offscreen pass matches the
    // layer pipelines, which are built for the target format — a mismatch (e.g. forcing rgba8unorm)
    // makes the readback render pass incompatible with the pipelines. readTextureToRGBA swizzles
    // BGRA→RGBA so callers always get RGBA bytes.
    const format = this.target?.format ?? 'rgba8unorm';
    const texture = this.ctx.device.createTexture({
      size: [w, h],
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.renderer.renderInto(
      texture.createView(),
      this.renderInputs(),
      this.allLayers(),
      cssW,
      cssH,
      this.background,
      w,
      h,
    );
    const data = await readTextureToRGBA(this.ctx.device, texture, w, h, format);
    texture.destroy();
    return { width: w, height: h, channels: 4, data };
  }

  /** Composite the displayed image to a PNG `Blob`. */
  async screenshot(): Promise<Blob> {
    const px = await this.readDisplayedPixels();
    if (typeof OffscreenCanvas !== 'undefined') {
      const off = new OffscreenCanvas(px.width, px.height);
      const ctx = off.getContext('2d')!;
      const image = ctx.createImageData(px.width, px.height);
      image.data.set(px.data);
      ctx.putImageData(image, 0, 0);
      return off.convertToBlob({ type: 'image/png' });
    }
    const el = document.createElement('canvas');
    el.width = px.width;
    el.height = px.height;
    const ctx = el.getContext('2d')!;
    const image = ctx.createImageData(px.width, px.height);
    image.data.set(px.data);
    ctx.putImageData(image, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      el.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
    });
  }

  /** Luminance histogram (over `bins` bins) of the currently displayed composite. */
  async histogram(bins = 256): Promise<Histogram> {
    const px = await this.readDisplayedPixels();
    return histogramRGBA(px.data, bins);
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

  dispose(): void {
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.detachControls?.();
    this.renderer?.dispose();
    this.ctx?.device.destroy();
    this.ctx = undefined;
    this.target = undefined;
    this.renderer = undefined;
  }
}
