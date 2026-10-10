import {
  canvasCssSize,
  docOf,
  ensurePositioned,
  observeResize,
  type OverlayViewer,
} from './common';

/** Default on-screen length the scale bar aims for, in CSS pixels. */
export const SCALE_BAR_TARGET_PX = 120;

/** Snap `x` to the nearest "nice" 1, 2 or 5 × 10ⁿ (1.4 → 1, 1.6 → 2, 8 → 10). */
export function niceLength(x: number): number {
  if (!(x > 0) || !isFinite(x)) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / base;
  const nice = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nice * base;
}

/** What a scale bar shows: its physical `length` (in the caller's unit) and its width on screen. */
export interface ScaleBarSpec {
  /** Bar length in the physical unit, a nice 1/2/5 × 10ⁿ. */
  length: number;
  /** Bar width in CSS pixels (unrounded). */
  widthPx: number;
}

/**
 * The scale bar for a view: given screen pixels per world unit (`pxPerWorld`, the 2D camera's
 * `zoom`, or `1 / Camera3D.worldPerPixel(h)` in 3D) and physical units per world unit
 * (`unitPerWorld`, e.g. µm per pixel), snap the length under `targetPx` screen pixels to the
 * nearest 1/2/5 × 10ⁿ and return it with its on-screen width. Null when either scale is not a
 * positive number — a bar over unknown units would read as a measurement. Pure.
 */
export function scaleBarFor(
  pxPerWorld: number,
  unitPerWorld: number,
  targetPx: number = SCALE_BAR_TARGET_PX,
): ScaleBarSpec | null {
  if (!(pxPerWorld > 0) || !(unitPerWorld > 0) || !isFinite(pxPerWorld)) return null;
  const unitPerPx = unitPerWorld / pxPerWorld;
  const length = niceLength(targetPx * unitPerPx);
  return { length, widthPx: length / unitPerPx };
}

const METRES_PER: Record<string, number> = {
  nm: 1e-9,
  µm: 1e-6,
  um: 1e-6,
  μm: 1e-6,
  mm: 1e-3,
  cm: 1e-2,
  m: 1,
};

const trim = (n: number): string => {
  const r = Math.round(n * 10) / 10;
  return r % 1 === 0 ? `${r}` : r.toFixed(1);
};

/**
 * Format a length given in `unit` (default `'µm'`). Metric units (`nm`, `µm`/`um`, `mm`, `cm`,
 * `m`) are re-expressed in the unit that suits the magnitude (1500 µm → "1.5 mm"); any other unit
 * (e.g. `'px'`) is printed as given. Whole numbers print without decimals, others with one.
 */
export function formatLength(value: number, unit: string = 'µm'): string {
  const perUnit = METRES_PER[unit];
  if (perUnit === undefined) return `${trim(value)} ${unit}`;
  const m = value * perUnit;
  const a = Math.abs(m);
  if (a >= 1) return `${trim(m)} m`;
  if (a >= 1e-2) return `${trim(m / 1e-2)} cm`;
  if (a >= 1e-3) return `${trim(m / 1e-3)} mm`;
  if (a >= 1e-6) return `${trim(m / 1e-6)} µm`;
  return `${trim(m / 1e-9)} nm`;
}

/** Options for {@link ScaleBarOverlay}. */
export interface ScaleBarOverlayOptions {
  /** Physical units per world unit (e.g. µm per image pixel). ≤ 0 or missing hides the bar. */
  unitPerWorld: number;
  /** The physical unit `unitPerWorld` is in. Default `'µm'`. */
  unit?: string;
  /** On-screen length to aim for, CSS px. Default {@link SCALE_BAR_TARGET_PX}. */
  targetPx?: number;
  /**
   * Which camera sets the scale: the 2D camera's zoom, the 3D camera at its target's depth,
   * or `'auto'` (default) — whichever `dims.ndisplay` selects.
   */
  mode?: '2d' | '3d' | 'auto';
  /** Extra class on the bar element, for host styling. */
  className?: string;
}

/**
 * A physical scale bar over the canvas (napari's `viewer.scale_bar`): a label and a line in the
 * host's bottom-left corner, re-sized on every camera, dims and host-size change. Hidden when
 * the scale is unknown. Call {@link dispose} to remove it.
 */
export class ScaleBarOverlay {
  /** The bar's root element (label + line). */
  readonly element: HTMLDivElement;
  private readonly line: HTMLDivElement;
  private readonly label: HTMLSpanElement;
  private readonly cleanups: Array<() => void> = [];
  private opts: ScaleBarOverlayOptions;
  private visible = true;

  constructor(
    host: HTMLElement,
    private readonly viewer: OverlayViewer,
    opts: ScaleBarOverlayOptions,
  ) {
    this.opts = { ...opts };
    ensurePositioned(host);
    const doc = docOf(host);
    this.element = doc.createElement('div');
    if (opts.className) this.element.className = opts.className;
    Object.assign(this.element.style, {
      position: 'absolute',
      left: '12px',
      bottom: '12px',
      zIndex: '30',
      pointerEvents: 'none',
      color: '#fff',
      font: '11px sans-serif',
      textShadow: '0 0 3px #000',
      textAlign: 'center',
      userSelect: 'none',
    });
    this.label = doc.createElement('span');
    this.line = doc.createElement('div');
    Object.assign(this.line.style, {
      height: '4px',
      marginTop: '2px',
      background: 'rgba(255,255,255,0.9)',
      borderLeft: '1px solid #fff',
      borderRight: '1px solid #fff',
      boxShadow: '0 0 3px #000',
    });
    this.element.append(this.label, this.line);
    host.appendChild(this.element);

    const update = (): void => this.update();
    this.cleanups.push(
      viewer.camera.changed.connect(update),
      viewer.camera3d.changed.connect(update),
      viewer.dims.changed.connect(update),
      observeResize(host, update),
    );
    this.update();
  }

  /** Change the physical scale / unit / target (e.g. a new image was loaded). */
  setOptions(opts: Partial<ScaleBarOverlayOptions>): void {
    this.opts = { ...this.opts, ...opts };
    if (opts.className !== undefined) this.element.className = opts.className;
    this.update();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.update();
  }

  /** Screen pixels per world unit under the active camera (0 when unknown). */
  pxPerWorld(): number {
    const { mode = 'auto' } = this.opts;
    const is3d = mode === '3d' || (mode === 'auto' && this.viewer.dims.ndisplay === 3);
    if (!is3d) return this.viewer.camera.zoom;
    const h = canvasCssSize(this.viewer).height;
    const wpp = h > 0 ? this.viewer.camera3d.worldPerPixel(h) : 0;
    return wpp > 0 ? 1 / wpp : 0;
  }

  /** Recompute the bar. Runs on every camera/dims/resize change; call it after anything else. */
  update(): void {
    const spec = this.visible
      ? scaleBarFor(this.pxPerWorld(), this.opts.unitPerWorld, this.opts.targetPx)
      : null;
    if (!spec) {
      this.element.style.display = 'none';
      return;
    }
    this.element.style.display = '';
    this.line.style.width = `${Math.round(spec.widthPx)}px`;
    this.label.textContent = formatLength(spec.length, this.opts.unit ?? 'µm');
  }

  dispose(): void {
    for (const off of this.cleanups.splice(0)) off();
    this.element.remove();
  }
}
