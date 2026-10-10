import { ViewerBase, type CanvasGeometry } from '../viewer-base';
import type { ViewerOptions } from '../viewer';
import type { PixelData } from '../engine/readback';
import { histogramRGBA, type Histogram } from '../color/histogram';

/** A canvas's client rect in CSS pixels, as `getBoundingClientRect()` reports it. */
export interface CanvasRect {
  /** Default 0. */
  left?: number;
  /** Default 0. */
  top?: number;
  width: number;
  height: number;
}

/**
 * Options for {@link HeadlessViewer}: everything {@link ViewerOptions} takes, all optional — so
 * code that builds a `Viewer` can be handed this instead — plus the virtual canvas's geometry.
 */
export interface HeadlessViewerOptions extends Partial<ViewerOptions> {
  /**
   * The virtual canvas's client rect. It drives `canvasToWorld`/`worldToCanvas`, framing and
   * `projectPoints` exactly as a real canvas's would. Wins over `canvas`; when neither is
   * given the canvas is 800×600 at the page origin.
   */
  canvasRect?: CanvasRect;
}

const DEFAULT_RECT: Required<CanvasRect> = { left: 0, top: 0, width: 800, height: 600 };

/**
 * The geometry the headless viewer reads: a fixed rect (layout size = drawing size, DPR 1), or
 * a passed canvas read live, as {@link Viewer} would.
 */
class VirtualCanvas implements CanvasGeometry {
  rect: Required<CanvasRect> | null;

  constructor(
    rect: CanvasRect | undefined,
    private readonly element: CanvasGeometry | undefined,
  ) {
    this.rect = rect || !element ? normalizeRect(rect ?? DEFAULT_RECT) : null;
  }

  get clientWidth(): number {
    return this.rect ? this.rect.width : this.element!.clientWidth;
  }
  get clientHeight(): number {
    return this.rect ? this.rect.height : this.element!.clientHeight;
  }
  get width(): number {
    return this.rect ? this.rect.width : this.element!.width;
  }
  get height(): number {
    return this.rect ? this.rect.height : this.element!.height;
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    if (!this.rect) return this.element!.getBoundingClientRect();
    const { left, top, width, height } = this.rect;
    return { left, top, width, height };
  }
}

function normalizeRect(rect: CanvasRect): Required<CanvasRect> {
  return { left: rect.left ?? 0, top: rect.top ?? 0, width: rect.width, height: rect.height };
}

/**
 * A GPU-free {@link Viewer} for unit tests: the real {@link ViewerModel}, layer construction,
 * 3D framing and canvas ↔ world maths — shared with `Viewer` through {@link ViewerBase}, so it
 * cannot drift from the library the way a hand-written stub does — with no device, no renderer
 * and no pointer controls.
 *
 * `ready` is already resolved. `requestRender` does nothing. Readback is deterministic: a
 * transparent-black frame the size of the canvas, its histogram, and an empty PNG blob.
 *
 * Construct it with no arguments, with the options a `Viewer` would get (the canvas is then
 * read for its geometry), or with a `canvasRect` to put the canvas anywhere on the page.
 */
export class HeadlessViewer extends ViewerBase {
  readonly ready: Promise<void> = Promise.resolve();
  /** The options it was constructed with, so a test can assert what the code under test asked for. */
  readonly options: HeadlessViewerOptions;

  private readonly surface: VirtualCanvas;
  private controlsEnabled: boolean;
  private disposed = false;

  constructor(options: HeadlessViewerOptions = {}) {
    const surface = new VirtualCanvas(options.canvasRect, options.canvas);
    super(surface, options.fit3d ?? 'always');
    this.surface = surface;
    this.options = options;
    this.controlsEnabled = options.controls ?? true;
  }

  /** Move or resize the virtual canvas, as a layout change would. Replaces a passed `canvas`. */
  setCanvasRect(rect: CanvasRect): void {
    this.surface.rect = normalizeRect(rect);
  }

  /** Always undefined: there is no device. */
  get device(): GPUDevice | undefined {
    return undefined;
  }

  /** No-op: nothing is drawn. */
  requestRender(): void {}

  /** Recorded, so {@link controlsActive} reports it; there are no pointer handlers to attach. */
  setControlsEnabled(enabled: boolean): void {
    this.controlsEnabled = enabled;
  }

  get controlsActive(): boolean {
    return this.controlsEnabled;
  }

  /**
   * A transparent-black RGBA8 frame at the canvas's drawing size (at least 1×1). Rejects after
   * {@link dispose}, with the message `Viewer` uses when it has no renderer.
   */
  async readDisplayedPixels(): Promise<PixelData> {
    if (this.disposed) throw new Error('Viewer is not ready — await `viewer.ready` first.');
    const width = Math.max(1, this.canvas.width);
    const height = Math.max(1, this.canvas.height);
    return { width, height, channels: 4, data: new Uint8ClampedArray(width * height * 4) };
  }

  /** An empty `image/png` blob. */
  async screenshot(): Promise<Blob> {
    await this.readDisplayedPixels();
    return new Blob([], { type: 'image/png' });
  }

  /** Luminance histogram of the blank frame: every pixel in bin 0. */
  async histogram(bins = 256): Promise<Histogram> {
    const px = await this.readDisplayedPixels();
    return histogramRGBA(px.data, bins);
  }

  dispose(): void {
    this.disposed = true;
  }
}
