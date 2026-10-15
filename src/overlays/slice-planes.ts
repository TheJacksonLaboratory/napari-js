import { DEFAULT_AXES_COLORS } from '../layers/axes-layer';
import type { RGB } from '../color/colormap';
import type { RGBA } from '../layers/points-layer';
import type { SurfaceLayer, SurfaceLayerOptions } from '../layers/surface-layer';
import type { VolumeLayer } from '../layers/volume-layer';
import type { Ray } from '../picking/ray';
import type { Layer } from '../layers/layer';
import { Emitter } from '../scene/events';
import { docOf, ensurePositioned, observeResize, type OverlayViewer } from './common';

/** A slice plane's axis: the plane x = const, y = const or z = const. */
export type SliceAxis = 'x' | 'y' | 'z';

/** The box the planes span: a volume's shape in voxels and its voxel size (world units). */
export interface SlicePlanesBox {
  shape: readonly [number, number, number];
  /** Default `[1, 1, 1]`. */
  voxelSize?: readonly [number, number, number];
}

/** A plane moved: where it is now (data coordinates), and whether its grip is still held. */
export interface SlicePlaneChange {
  axis: SliceAxis;
  value: number;
  dragging: boolean;
}

/** What the widget needs of a viewer: `Viewer` and the headless viewer both satisfy it. */
export interface SlicePlanesViewer extends OverlayViewer {
  readonly layers: { remove(layer: Layer): boolean };
  addSurface(
    vertices: Float32Array,
    faces: Uint32Array,
    values?: Float32Array,
    opts?: SurfaceLayerOptions,
  ): SurfaceLayer;
  canvasRay(canvasX: number, canvasY: number): Ray | null;
  viewportSize(): [number, number];
}

/** Options for {@link SlicePlanesWidget}. */
export interface SlicePlanesWidgetOptions {
  /** The volume the planes cut (they follow its shape and voxel size), or a box. */
  volume: VolumeLayer | SlicePlanesBox;
  /** The planes shown. Default all three. */
  axes?: readonly SliceAxis[];
  /** Where each plane starts (data coordinates). Default the middle of the volume. */
  positions?: Partial<Record<SliceAxis, number>>;
  /** Each plane's colour (0..1 RGB). Default the axes gizmo's ({@link DEFAULT_AXES_COLORS}). */
  colors?: Partial<Record<SliceAxis, RGB>>;
  /** A plane's opacity (default 0.22), and while its grip is held (default 0.4). */
  opacity?: number;
  dragOpacity?: number;
  /** Whether each plane has a grip that drags it. Default true. */
  grips?: boolean;
  /** Round positions to whole voxels (a slice index). Default false. */
  snap?: boolean;
  /**
   * Keep the volume's `plane` (its `'plane'` depiction) on this plane: its position and normal
   * follow the plane, its thickness is kept. Only with a `VolumeLayer`; the depiction itself is
   * the caller's to set.
   */
  linkPlane?: SliceAxis;
}

const AXES: readonly SliceAxis[] = ['x', 'y', 'z'];
const INDEX: Readonly<Record<SliceAxis, 0 | 1 | 2>> = { x: 0, y: 1, z: 2 };
/** Two triangles over a plane's four corners. */
const QUAD = Uint32Array.of(0, 1, 2, 0, 2, 3);

/**
 * Data (voxel) coordinates → world, as the volume visual places a volume: voxel `i` centred on
 * `i`, the box centred on the origin and scaled by the voxel size (see {@link VolumeLayer.bounds}).
 */
export function volumeDataToWorld(
  box: SlicePlanesBox,
  p: readonly [number, number, number],
): [number, number, number] {
  const [sx, sy, sz] = box.voxelSize ?? [1, 1, 1];
  const [w, h, d] = box.shape;
  return [(p[0] + 0.5 - w / 2) * sx, (p[1] + 0.5 - h / 2) * sy, (p[2] + 0.5 - d / 2) * sz];
}

/** The world corners of the plane `axis = at` across the box (data coordinates `at`). */
export function slicePlaneCorners(box: SlicePlanesBox, axis: SliceAxis, at: number): Float32Array {
  const [w, h, d] = box.shape;
  // The box's faces in data coordinates: voxel i spans [i − 0.5, i + 0.5).
  const x0 = -0.5,
    x1 = w - 0.5,
    y0 = -0.5,
    y1 = h - 0.5,
    z0 = -0.5,
    z1 = d - 0.5;
  const corners: Array<[number, number, number]> =
    axis === 'z'
      ? [
          [x0, y0, at],
          [x1, y0, at],
          [x1, y1, at],
          [x0, y1, at],
        ]
      : axis === 'x'
        ? [
            [at, y0, z0],
            [at, y1, z0],
            [at, y1, z1],
            [at, y0, z1],
          ]
        : [
            [x0, at, z0],
            [x1, at, z0],
            [x1, at, z1],
            [x0, at, z1],
          ];
  return Float32Array.from(corners.flatMap((c) => volumeDataToWorld(box, c)));
}

/**
 * Where a plane's grip sits (world): the middle of one of its edges, a different edge per axis so
 * the three grips don't meet.
 */
export function slicePlaneGripPoint(
  box: SlicePlanesBox,
  axis: SliceAxis,
  at: number,
): [number, number, number] {
  const [w, h, d] = box.shape;
  const p: [number, number, number] =
    axis === 'z'
      ? [w - 0.5, (h - 1) / 2, at]
      : axis === 'x'
        ? [at, -0.5, (d - 1) / 2]
        : [-0.5, at, (d - 1) / 2];
  return volumeDataToWorld(box, p);
}

/**
 * Where `ray` passes nearest the line through `point` along `axis` (world): the line's parameter
 * there, world units from `point`. Null when the ray runs along the line.
 */
export function rayAxisParam(
  ray: Ray,
  point: readonly [number, number, number],
  axis: SliceAxis,
): number | null {
  const a = INDEX[axis];
  // Closest points of the line point + t·e_a and the ray origin + s·dir (|dir| = 1).
  const w0 = [point[0] - ray.origin[0], point[1] - ray.origin[1], point[2] - ray.origin[2]];
  const r = ray.dir;
  const b = r[a];
  const denom = 1 - b * b;
  if (denom < 1e-9) return null;
  const e = r[0] * w0[0] + r[1] * w0[1] + r[2] * w0[2];
  return (b * e - w0[a]) / denom;
}

/**
 * Three orthogonal slice planes through a volume (napari's plane widget in the 3D view): each a
 * translucent quad in its axis colour, with a grip — a DOM handle over the canvas, at one of its
 * edges — that drags it along its axis. The grips, not the planes, take the pointer: a plane
 * facing the camera covers the whole volume, which must still orbit.
 *
 * Positions are data (voxel) coordinates, as {@link VolumeLayer.plane} and the clipping planes
 * use them, clamped to the voxel centres `[0, n − 1]`. Moving a plane replaces its quad in place
 * ({@link SurfaceLayer.setData}); grips are projected with the viewer's own viewport, so they stay
 * on their planes. Shown only in 3D. Like the other overlays, the canvas should sit at the host's
 * top-left corner.
 */
export class SlicePlanesWidget {
  /** A plane moved: by its grip (`dragging` until released) or by {@link setPosition}. */
  readonly changed = new Emitter<SlicePlaneChange>();

  private readonly axes: readonly SliceAxis[];
  private readonly positions = new Map<SliceAxis, number>();
  private readonly layers = new Map<SliceAxis, SurfaceLayer>();
  private readonly grips = new Map<SliceAxis, HTMLElement>();
  private readonly hidden = new Set<SliceAxis>();
  private readonly colors: Record<SliceAxis, RGB>;
  private readonly opacity: number;
  private readonly dragOpacity: number;
  private readonly snap: boolean;
  private readonly linkPlane: SliceAxis | undefined;
  private readonly volumeLayer: VolumeLayer | null;
  private box: SlicePlanesBox;
  private geometryVersion: number;
  private drag: { axis: SliceAxis; start: number; t0: number; pointer: number } | null = null;
  private readonly cleanups: Array<() => void> = [];
  private disposed = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly viewer: SlicePlanesViewer,
    opts: SlicePlanesWidgetOptions,
  ) {
    this.volumeLayer = 'shape' in opts.volume ? null : opts.volume;
    this.box = boxOf(opts.volume);
    this.geometryVersion = this.volumeLayer?.geometryVersion ?? 0;
    this.axes = (opts.axes ?? AXES).filter((a, i, all) => AXES.includes(a) && all.indexOf(a) === i);
    this.colors = {
      x: opts.colors?.x ?? DEFAULT_AXES_COLORS.x,
      y: opts.colors?.y ?? DEFAULT_AXES_COLORS.y,
      z: opts.colors?.z ?? DEFAULT_AXES_COLORS.z,
    };
    this.opacity = opts.opacity ?? 0.22;
    this.dragOpacity = opts.dragOpacity ?? 0.4;
    this.snap = opts.snap ?? false;
    this.linkPlane = this.volumeLayer && opts.linkPlane ? opts.linkPlane : undefined;

    for (const axis of this.axes) {
      const n = this.box.shape[INDEX[axis]];
      this.positions.set(axis, this.clamp(axis, opts.positions?.[axis] ?? (n - 1) / 2));
      this.layers.set(
        axis,
        viewer.addSurface(slicePlaneCorners(this.box, axis, this.position(axis)), QUAD, undefined, {
          name: `${axis} slice plane`,
          color: this.rgba(axis),
          opacity: this.opacity,
          blending: 'translucent',
          fit: 'never',
        }),
      );
    }
    if (opts.grips ?? true) {
      ensurePositioned(host);
      for (const axis of this.axes) this.grips.set(axis, this.makeGrip(axis));
    }
    this.syncLinkedPlane();

    const place = (): void => this.placeGrips();
    this.cleanups.push(
      viewer.camera3d.changed.connect(place),
      viewer.dims.changed.connect(place),
      observeResize(host, place),
    );
    if (this.volumeLayer) {
      const volume = this.volumeLayer;
      this.cleanups.push(
        volume.changed.connect(() => {
          if (volume.geometryVersion === this.geometryVersion) return;
          this.geometryVersion = volume.geometryVersion;
          this.box = boxOf(volume);
          for (const axis of this.axes) this.redraw(axis);
          this.placeGrips();
        }),
      );
    }
    this.placeGrips();
  }

  /** Where the plane is (data coordinates); NaN for an axis the widget doesn't show. */
  position(axis: SliceAxis): number {
    return this.positions.get(axis) ?? NaN;
  }

  /** The plane's surface layer (a translucent quad), if the widget shows that axis. */
  layer(axis: SliceAxis): SurfaceLayer | undefined {
    return this.layers.get(axis);
  }

  /** The plane's grip element, if it has one. */
  grip(axis: SliceAxis): HTMLElement | undefined {
    return this.grips.get(axis);
  }

  /** Move a plane to `value` (data coordinates, clamped into the volume). Emits {@link changed}. */
  setPosition(axis: SliceAxis, value: number): void {
    if (!this.positions.has(axis)) return;
    this.move(axis, value, false);
  }

  /** Show or hide one plane, or all of them, with its grip. */
  setVisible(axis: SliceAxis | 'all', visible: boolean): void {
    for (const a of axis === 'all' ? this.axes : [axis]) {
      if (visible) this.hidden.delete(a);
      else this.hidden.add(a);
      const layer = this.layers.get(a);
      if (layer) layer.visible = visible;
    }
    this.placeGrips();
  }

  /** Remove the planes, grips and listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.cleanups.splice(0)) off();
    for (const layer of this.layers.values()) this.viewer.layers.remove(layer);
    this.layers.clear();
    for (const grip of this.grips.values()) grip.remove();
    this.grips.clear();
    this.changed.clear();
  }

  /** Reproject the grips. Runs on camera, dims and resize changes. */
  placeGrips(): void {
    if (!this.grips.size) return;
    const show = this.viewer.dims.ndisplay === 3;
    const axes = [...this.grips.keys()];
    const anchors = new Float32Array(axes.length * 3);
    axes.forEach((a, i) => anchors.set(slicePlaneGripPoint(this.box, a, this.position(a)), i * 3));
    const proj = show ? this.viewer.projectPoints(anchors) : null;
    axes.forEach((axis, i) => {
      const grip = this.grips.get(axis)!;
      const x = proj ? proj.screen[i * 2] : NaN;
      const y = proj ? proj.screen[i * 2 + 1] : NaN;
      if (this.hidden.has(axis) || !Number.isFinite(x) || !Number.isFinite(y)) {
        grip.style.display = 'none';
        return;
      }
      grip.style.display = '';
      grip.style.left = `${x}px`;
      grip.style.top = `${y}px`;
      grip.title = `Drag to move the ${axis.toUpperCase()} plane (${formatValue(this.position(axis))})`;
    });
  }

  private move(axis: SliceAxis, value: number, dragging: boolean): void {
    const v = this.clamp(axis, value);
    const changed = v !== this.position(axis);
    if (changed) {
      this.positions.set(axis, v);
      this.redraw(axis);
      if (axis === this.linkPlane) this.syncLinkedPlane();
      this.placeGrips();
    }
    if (changed || !dragging) this.changed.emit({ axis, value: v, dragging });
  }

  private redraw(axis: SliceAxis): void {
    this.layers.get(axis)?.setData(slicePlaneCorners(this.box, axis, this.position(axis)), QUAD);
  }

  private syncLinkedPlane(): void {
    const axis = this.linkPlane;
    const volume = this.volumeLayer;
    if (!axis || !volume || !this.positions.has(axis)) return;
    const position: [number, number, number] = [
      (this.box.shape[0] - 1) / 2,
      (this.box.shape[1] - 1) / 2,
      (this.box.shape[2] - 1) / 2,
    ];
    position[INDEX[axis]] = this.position(axis);
    const normal: [number, number, number] = [0, 0, 0];
    normal[INDEX[axis]] = 1;
    volume.plane = { position, normal, thickness: volume.plane.thickness };
  }

  private clamp(axis: SliceAxis, value: number): number {
    const max = this.box.shape[INDEX[axis]] - 1;
    const v = Math.min(max, Math.max(0, Number.isFinite(value) ? value : 0));
    return this.snap ? Math.round(v) : v;
  }

  private rgba(axis: SliceAxis): RGBA {
    const [r, g, b] = this.colors[axis];
    return [r, g, b, 1];
  }

  private makeGrip(axis: SliceAxis): HTMLElement {
    const el = docOf(this.host).createElement('div');
    el.className = 'napari-slice-plane-grip';
    el.textContent = axis.toUpperCase();
    el.tabIndex = 0;
    Object.assign(el.style, {
      position: 'absolute',
      zIndex: '31',
      width: '20px',
      height: '20px',
      marginLeft: '-10px',
      marginTop: '-10px',
      boxSizing: 'border-box',
      borderRadius: '50%',
      background: cssColor(this.colors[axis]),
      border: '1.5px solid #fff',
      boxShadow: '0 0 4px rgba(0,0,0,0.6)',
      color: '#fff',
      font: 'bold 11px/17px sans-serif',
      textAlign: 'center',
      cursor: 'grab',
      touchAction: 'none',
      userSelect: 'none',
    });
    el.addEventListener('pointerdown', (e) => this.onDown(axis, e as PointerEvent));
    el.addEventListener('pointermove', (e) => this.onMove(e as PointerEvent));
    el.addEventListener('pointerup', (e) => this.onUp(e as PointerEvent));
    el.addEventListener('pointercancel', (e) => this.onUp(e as PointerEvent));
    el.addEventListener('keydown', (e) => this.onKey(axis, e as KeyboardEvent));
    this.host.appendChild(el);
    return el;
  }

  private onDown(axis: SliceAxis, e: PointerEvent): void {
    if (e.button !== undefined && e.button !== 0) return;
    // Not an orbit: the grip holds the pointer until released.
    e.preventDefault();
    e.stopPropagation();
    const start = this.position(axis);
    const t0 = this.axisParam(axis, start, e);
    if (t0 === null) return;
    this.drag = { axis, start, t0, pointer: e.pointerId };
    const el = this.grips.get(axis);
    el?.setPointerCapture?.(e.pointerId);
    if (el) el.style.cursor = 'grabbing';
    const layer = this.layers.get(axis);
    if (layer) layer.opacity = this.dragOpacity;
  }

  private onMove(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointer) return;
    e.preventDefault();
    e.stopPropagation();
    const t = this.axisParam(drag.axis, drag.start, e);
    if (t === null) return;
    const perVoxel = (this.box.voxelSize ?? [1, 1, 1])[INDEX[drag.axis]];
    this.move(drag.axis, drag.start + (t - drag.t0) / perVoxel, true);
  }

  private onUp(e: PointerEvent): void {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointer) return;
    this.drag = null;
    const el = this.grips.get(drag.axis);
    el?.releasePointerCapture?.(e.pointerId);
    if (el) el.style.cursor = 'grab';
    const layer = this.layers.get(drag.axis);
    if (layer) layer.opacity = this.opacity;
    this.changed.emit({ axis: drag.axis, value: this.position(drag.axis), dragging: false });
  }

  /** Arrow keys step a focused grip's plane a voxel (ten with Shift). */
  private onKey(axis: SliceAxis, e: KeyboardEvent): void {
    const dir =
      e.key === 'ArrowUp' || e.key === 'ArrowRight'
        ? 1
        : e.key === 'ArrowDown' || e.key === 'ArrowLeft'
          ? -1
          : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    this.move(axis, this.position(axis) + dir * (e.shiftKey ? 10 : 1), false);
  }

  /** The pointer's place along the plane's axis (see {@link rayAxisParam}), through its grip. */
  private axisParam(axis: SliceAxis, at: number, e: PointerEvent): number | null {
    // Canvas-local CSS px: the canvas sits at the host's top-left.
    const rect = this.host.getBoundingClientRect();
    const ray = this.viewer.canvasRay(e.clientX - rect.left, e.clientY - rect.top);
    return ray ? rayAxisParam(ray, slicePlaneGripPoint(this.box, axis, at), axis) : null;
  }
}

function boxOf(volume: VolumeLayer | SlicePlanesBox): SlicePlanesBox {
  if ('shape' in volume) return { shape: [...volume.shape], voxelSize: volume.voxelSize };
  return { shape: [volume.width, volume.height, volume.depth], voxelSize: volume.voxelSize };
}

function cssColor([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

function formatValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
