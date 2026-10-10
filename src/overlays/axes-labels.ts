import { docOf, ensurePositioned, observeResize, type OverlayViewer } from './common';

/** One axis label: a world-space anchor (e.g. the axis end), its text and CSS colour. */
export interface AxisLabelSpec {
  anchor: readonly [number, number, number];
  text: string;
  color: string;
}

/** Options for {@link AxesLabelsOverlay}. */
export interface AxesLabelsOverlayOptions {
  labels: readonly AxisLabelSpec[];
  /** Default true. */
  visible?: boolean;
}

/**
 * Crisp DOM text labels for the 3D axes (the text half of napari's axes overlay; the lines are
 * {@link AxesLayer}). Each label is projected through the viewer's live 3D camera, so it tracks
 * its anchor as the scene orbits, and hidden when its anchor is behind the eye or clipped.
 *
 * Shown only while the viewer is in 3D (`dims.ndisplay === 3`). Positions are the canvas's CSS
 * pixels, so the canvas should sit at the host's top-left corner.
 */
export class AxesLabelsOverlay {
  private els: HTMLSpanElement[] = [];
  private labels: AxisLabelSpec[] = [];
  private visible: boolean;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly host: HTMLElement,
    private readonly viewer: OverlayViewer,
    opts: AxesLabelsOverlayOptions,
  ) {
    this.visible = opts.visible ?? true;
    ensurePositioned(host);
    this.setLabels(opts.labels);
    const update = (): void => this.update();
    this.cleanups.push(
      viewer.camera3d.changed.connect(update),
      viewer.dims.changed.connect(update),
      observeResize(host, update),
    );
  }

  /** The label elements, in the order of the specs. */
  get elements(): readonly HTMLSpanElement[] {
    return this.els;
  }

  /**
   * Replace the labels and reproject. Elements are reused when the count is unchanged (so a
   * live geometry change — e.g. restretching a volume's z — does not flicker).
   */
  setLabels(labels: readonly AxisLabelSpec[]): void {
    if (labels.length !== this.els.length) {
      for (const el of this.els) el.remove();
      this.els = labels.map(() => this.createLabel());
    }
    this.labels = labels.map((l) => ({ ...l, anchor: [l.anchor[0], l.anchor[1], l.anchor[2]] }));
    this.labels.forEach((spec, i) => {
      const el = this.els[i];
      if (el.textContent !== spec.text) el.textContent = spec.text;
      el.style.color = spec.color;
    });
    this.update();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.update();
  }

  /** Reproject every label. Runs on camera/dims/resize changes. */
  update(): void {
    const show = this.visible && this.viewer.dims.ndisplay === 3 && this.labels.length > 0;
    const anchors = new Float32Array(this.labels.length * 3);
    this.labels.forEach((l, i) => anchors.set(l.anchor, i * 3));
    const proj = show ? this.viewer.projectPoints(anchors) : null;
    this.els.forEach((el, i) => {
      const x = proj ? proj.screen[i * 2] : NaN;
      const y = proj ? proj.screen[i * 2 + 1] : NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        el.style.display = 'none';
        return;
      }
      el.style.display = '';
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    });
  }

  dispose(): void {
    for (const off of this.cleanups.splice(0)) off();
    for (const el of this.els) el.remove();
    this.els = [];
  }

  private createLabel(): HTMLSpanElement {
    const el = docOf(this.host).createElement('span');
    Object.assign(el.style, {
      position: 'absolute',
      zIndex: '30',
      pointerEvents: 'none',
      font: '11px sans-serif',
      fontWeight: '600',
      textShadow: '0 0 3px #000, 0 0 3px #000',
      whiteSpace: 'nowrap',
      transform: 'translate(-50%, -50%)',
      userSelect: 'none',
    });
    this.host.appendChild(el);
    return el;
  }
}
