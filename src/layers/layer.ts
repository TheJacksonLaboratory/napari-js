import { Emitter } from '../scene/events';

export type BlendMode = 'opaque' | 'translucent' | 'additive' | 'minimum';

let nextLayerId = 0;

/**
 * Base layer: identity + the display properties shared by every layer kind (opacity,
 * blending, visibility, and a data→world affine via `scale`/`translate`). Mutating any
 * property emits {@link changed} so the renderer can schedule a redraw — the napari
 * evented-layer model, GPU-side.
 */
export abstract class Layer {
  readonly id: string = `layer-${nextLayerId++}`;
  readonly changed = new Emitter<Layer>();

  abstract readonly kind: string;

  name: string;

  /** Data→world scale (e.g. physical pixel size). */
  scale: [number, number];
  /** Data→world translation. */
  translate: [number, number];

  protected _opacity = 1;
  protected _visible = true;
  protected _blending: BlendMode = 'translucent';

  protected constructor(
    opts: {
      name?: string;
      scale?: [number, number];
      translate?: [number, number];
    } = {},
  ) {
    this.name = opts.name ?? this.id;
    this.scale = opts.scale ?? [1, 1];
    this.translate = opts.translate ?? [0, 0];
  }

  get opacity(): number {
    return this._opacity;
  }
  set opacity(value: number) {
    this._opacity = clamp01(value);
    this.changed.emit(this);
  }

  get visible(): boolean {
    return this._visible;
  }
  set visible(value: boolean) {
    this._visible = value;
    this.changed.emit(this);
  }

  get blending(): BlendMode {
    return this._blending;
  }
  set blending(value: BlendMode) {
    this._blending = value;
    this.changed.emit(this);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * When adding a 3D layer should move the orbit camera.
 *
 * The camera belongs to whoever is driving it — a toolbar, a drag on the canvas — and a
 * scene is rarely built from a single add. Reframing on every add means a host that layers
 * a reference volume under a point cloud, or rebuilds one layer to recolour it, watches the
 * view jump. The only defence available without a policy is to save the five camera fields
 * around each add and put them back, which is a workaround for a missing option.
 *
 *  - `always` — frame on every add. The 0.13 behaviour, and still the default, so existing
 *    callers see no change.
 *  - `once`   — frame the first add only, then leave the pose alone. Reset the "first" with
 *    {@link Viewer.resetFit3D}, typically when the scene's subject changes.
 *  - `never`  — never move the camera; the host frames deliberately with
 *    {@link Viewer.fitToLayers}.
 */
export type Fit3D = 'always' | 'once' | 'never';
