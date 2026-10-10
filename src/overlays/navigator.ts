import { docOf, ensurePositioned, observeResize, type OverlayViewer } from './common';

/** Where the thumbnail sits inside the navigator box, in CSS px. */
export interface NavigatorLayout {
  /** Box size. */
  width: number;
  height: number;
  /** CSS px per world unit. */
  scale: number;
}

/** Default fraction of the host's width the navigator takes (OpenSeadragon's `navigatorSizeRatio`). */
export const NAVIGATOR_SIZE_RATIO = 0.16;
/** Bounds on the navigator's longest side, CSS px. */
export const NAVIGATOR_MIN_PX = 110;
export const NAVIGATOR_MAX_PX = 300;

/** Box size and scale for a `worldW × worldH` world in a host `hostW` wide. Null if degenerate. Pure. */
export function navigatorLayout(
  hostW: number,
  worldW: number,
  worldH: number,
  ratio = NAVIGATOR_SIZE_RATIO,
): NavigatorLayout | null {
  if (!(worldW > 0) || !(worldH > 0) || !(hostW > 0)) return null;
  const longest = Math.min(NAVIGATOR_MAX_PX, Math.max(NAVIGATOR_MIN_PX, hostW * ratio));
  const scale = longest / Math.max(worldW, worldH);
  return { width: worldW * scale, height: worldH * scale, scale };
}

/** A point in the navigator box → world coordinates, clamped to the world. Pure. */
export function navigatorToWorld(
  px: number,
  py: number,
  layout: NavigatorLayout,
  worldW: number,
  worldH: number,
): [number, number] {
  return [
    Math.min(worldW, Math.max(0, px / layout.scale)),
    Math.min(worldH, Math.max(0, py / layout.scale)),
  ];
}

/** Options for {@link NavigatorOverlay}. */
export interface NavigatorOverlayOptions {
  /** The world the thumbnail covers, `[0, worldWidth) × [0, worldHeight)` (e.g. image pixels). */
  worldWidth: number;
  worldHeight: number;
  /** The thumbnail: any image of the whole world, e.g. a coarse pyramid level. */
  image?: CanvasImageSource | null;
  /** Fraction of the host width. Default {@link NAVIGATOR_SIZE_RATIO}. */
  sizeRatio?: number;
  /** Called when the pointer enters the navigator — e.g. to hide a canvas hover tooltip. */
  onEnter?: () => void;
  /** Default true. */
  visible?: boolean;
}

/**
 * Overview navigator (minimap) for the 2D view, as OpenSeadragon's: a thumbnail of the whole
 * world in the host's bottom-right corner with the visible rect ({@link
 * OverlayViewer.visibleWorldRect}) drawn on it. Clicking re-centres the view there at the same
 * zoom; dragging pans continuously. Its pointer and wheel events do not reach the canvas.
 * Hidden in 3D.
 */
export class NavigatorOverlay {
  /** The navigator box. */
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly region: HTMLDivElement;
  private readonly listeners = new AbortController();
  private readonly cleanups: Array<() => void> = [];
  private layout: NavigatorLayout | null = null;
  private image: CanvasImageSource | null;
  private worldW: number;
  private worldH: number;
  private dragging = false;
  private visible: boolean;

  constructor(
    private readonly host: HTMLElement,
    private readonly viewer: OverlayViewer,
    private readonly opts: NavigatorOverlayOptions,
  ) {
    this.worldW = opts.worldWidth;
    this.worldH = opts.worldHeight;
    this.image = opts.image ?? null;
    this.visible = opts.visible ?? true;
    ensurePositioned(host);
    const doc = docOf(host);

    this.element = doc.createElement('div');
    this.element.className = 'napari-navigator';
    Object.assign(this.element.style, {
      position: 'absolute',
      right: '12px',
      bottom: '12px',
      background: 'rgba(0,0,0,0.5)',
      border: '1px solid rgba(255,255,255,0.35)',
      overflow: 'hidden',
      cursor: 'pointer',
      zIndex: '5',
      touchAction: 'none',
    });
    this.canvas = doc.createElement('canvas');
    Object.assign(this.canvas.style, { display: 'block', width: '100%', height: '100%' });
    this.region = doc.createElement('div');
    Object.assign(this.region.style, {
      position: 'absolute',
      border: '2px solid #900',
      boxSizing: 'border-box',
      pointerEvents: 'none',
    });
    this.element.append(this.canvas, this.region);
    host.appendChild(this.element);

    const signal = this.listeners.signal;
    const box = this.element;
    box.addEventListener('pointerdown', this.onDown, { signal });
    box.addEventListener('pointermove', this.onMove, { signal });
    box.addEventListener('pointerup', this.onUp, { signal });
    box.addEventListener('pointercancel', this.onUp, { signal });
    box.addEventListener('pointerenter', () => this.opts.onEnter?.(), { signal });
    for (const type of ['wheel', 'click', 'dblclick', 'contextmenu', 'mousedown'] as const) {
      box.addEventListener(type, stop, { passive: false, signal });
    }

    this.cleanups.push(
      viewer.camera.changed.connect(() => this.updateRegion()),
      viewer.dims.changed.connect(() => this.applyVisibility()),
      observeResize(host, () => this.relayout()),
    );
    this.relayout();
  }

  /** The current layout (null while the host or world has no size). */
  get currentLayout(): NavigatorLayout | null {
    return this.layout;
  }

  /** Set the thumbnail. */
  setImage(image: CanvasImageSource | null): void {
    this.image = image;
    this.drawImage();
  }

  /** The world's size changed (another image was loaded). */
  setWorld(width: number, height: number): void {
    this.worldW = width;
    this.worldH = height;
    this.relayout();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  /** Recompute the layout from the host's size (runs on host resize). */
  relayout(): void {
    this.layout = navigatorLayout(
      this.host.clientWidth,
      this.worldW,
      this.worldH,
      this.opts.sizeRatio,
    );
    this.applyVisibility();
    if (!this.layout) return;
    this.element.style.width = `${this.layout.width}px`;
    this.element.style.height = `${this.layout.height}px`;
    const dpr = this.host.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    this.canvas.width = Math.max(1, Math.round(this.layout.width * dpr));
    this.canvas.height = Math.max(1, Math.round(this.layout.height * dpr));
    this.drawImage();
    this.updateRegion();
  }

  dispose(): void {
    this.listeners.abort();
    for (const off of this.cleanups.splice(0)) off();
    this.element.remove();
  }

  private applyVisibility(): void {
    const show = this.visible && this.layout !== null && this.viewer.dims.ndisplay === 2;
    this.element.style.display = show ? 'block' : 'none';
  }

  private drawImage(): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.image) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.image, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /** Draw the visible rect, clipped to the box (as OpenSeadragon does when zoomed out). */
  private updateRegion(): void {
    const l = this.layout;
    if (!l) return;
    const r = this.viewer.visibleWorldRect();
    const left = Math.max(0, r.x * l.scale);
    const top = Math.max(0, r.y * l.scale);
    const right = Math.min(l.width, (r.x + r.width) * l.scale);
    const bottom = Math.min(l.height, (r.y + r.height) * l.scale);
    Object.assign(this.region.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(2, right - left)}px`,
      height: `${Math.max(2, bottom - top)}px`,
      display: right > left && bottom > top ? 'block' : 'none',
    });
  }

  /** Re-centre the view on the navigator point under the pointer, keeping the zoom. */
  private panTo(e: PointerEvent): void {
    const l = this.layout;
    if (!l) return;
    const rect = this.element.getBoundingClientRect();
    this.viewer.camera.center = navigatorToWorld(
      e.clientX - rect.left,
      e.clientY - rect.top,
      l,
      this.worldW,
      this.worldH,
    );
  }

  private readonly onDown = (e: PointerEvent): void => {
    stop(e);
    if (e.button !== 0) return;
    this.dragging = true;
    this.element.setPointerCapture?.(e.pointerId);
    this.panTo(e);
  };

  private readonly onMove = (e: PointerEvent): void => {
    stop(e); // a hover over the navigator is not a hover over the canvas
    if (this.dragging) this.panTo(e);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.dragging) return;
    stop(e);
    this.dragging = false;
    this.element.releasePointerCapture?.(e.pointerId);
  };
}

function stop(e: Event): void {
  e.stopPropagation();
  if (e.cancelable) e.preventDefault();
}
