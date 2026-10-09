import { acquireDevice, type DeviceContext } from './engine/device';
import { CanvasTarget } from './engine/canvas';
import { Renderer } from './engine/renderer';
import { attachCameraControls, type CameraControlOptions } from './camera/controls';
import type { Layer } from './layers/layer';
import type { Fit3D } from './layers/layer';
import { attachOrbitControls } from './camera/controls3d';
import { readTextureToRGBA, type PixelData } from './engine/readback';
import { histogramRGBA, type Histogram } from './color/histogram';
import type { RenderInputs } from './engine/renderer';
import { ViewerBase } from './viewer-base';

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
  /** Default framing policy for 3D adds; see {@link Fit3D}. Per-add `fit` overrides it. */
  fit3d?: Fit3D;
}

/**
 * The napari-js viewer: a headless {@link ViewerModel} (layers + camera) plus a WebGPU
 * renderer. Construction kicks off async device acquisition — await {@link ready} before
 * the first render. Adding layers / mutating display props schedules a coalesced redraw.
 *
 * Layer construction, framing and the canvas ↔ world maths live in {@link ViewerBase}, which
 * the GPU-free `HeadlessViewer` in `napari-js/testing` shares; this class adds the device,
 * the renderer, pointer controls and readback.
 */
export class Viewer extends ViewerBase {
  readonly ready: Promise<void>;

  declare protected readonly canvas: HTMLCanvasElement;
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
  private disposed = false;

  constructor(options: ViewerOptions) {
    super(options.canvas, options.fit3d ?? 'always');
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
