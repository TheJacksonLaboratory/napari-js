import { Emitter } from '../scene/events';
import { perspective, lookAt, multiply, type Mat4, type Vec3 } from '../math/mat4';

const HALF_PI = Math.PI / 2;
const EPS = 1e-3;

/** How a pointer drag manipulates the 3D camera. */
export type CameraDragMode = 'rotate' | 'pan' | 'zoom';

/**
 * Orbit camera for 3D (volume) rendering: spins around `target` at `distance`, parameterized
 * by `azimuth`/`elevation`. Produces a perspective view-projection. A pointer drag does
 * {@link dragMode} (rotate / pan / dolly); the wheel always dollies. Emits {@link changed} on
 * mutation. Used when `dims.ndisplay === 3`.
 */
export class Camera3D {
  readonly changed = new Emitter<Camera3D>();

  azimuth = 0.7;
  elevation = 0.5;
  fov = (45 * Math.PI) / 180;
  /** What a pointer drag does. The host UI can switch this (rotate/pan/zoom). */
  dragMode: CameraDragMode = 'rotate';

  private _distance = 3;
  private _target: [number, number, number] = [0, 0, 0];

  get distance(): number {
    return this._distance;
  }
  set distance(value: number) {
    this._distance = Math.max(EPS, value);
    this.changed.emit(this);
  }

  get target(): [number, number, number] {
    return [...this._target];
  }
  set target(value: Vec3) {
    this._target = [value[0], value[1], value[2]];
    this.changed.emit(this);
  }

  /** Rotate the orbit by deltas (radians); elevation is clamped to avoid gimbal flip. */
  orbit(dAzimuth: number, dElevation: number): void {
    this.azimuth += dAzimuth;
    this.elevation = clamp(this.elevation + dElevation, -HALF_PI + EPS, HALF_PI - EPS);
    this.changed.emit(this);
  }

  zoomBy(factor: number): void {
    this.distance = this._distance * factor;
  }

  /**
   * World units spanned by one CSS pixel at the target's depth, for a viewport `viewportHeight`
   * CSS pixels tall: `2 · distance · tan(fov / 2) / viewportHeight`.
   *
   * The perspective analog of the 2D camera's `1 / zoom`, exact on the plane through the target
   * facing the camera (nearer things look bigger, farther smaller). It is what a 3D scale bar
   * needs, and what {@link pan} uses so a drag tracks the cursor. Heights below 1 are treated
   * as 1, so an unsized canvas gives a finite value.
   */
  worldPerPixel(viewportHeight: number): number {
    return (2 * this._distance * Math.tan(this.fov / 2)) / Math.max(viewportHeight, 1);
  }

  /**
   * Pan the target in the camera's view plane by screen-pixel deltas (drag). `viewportHeight`
   * sets the world-per-pixel scale at the target depth ({@link worldPerPixel}) so panning
   * tracks the cursor.
   */
  pan(dxScreen: number, dyScreen: number, viewportHeight: number): void {
    const worldPerPx = this.worldPerPixel(viewportHeight);
    const eye = this.eye();
    // Orthonormal camera basis (forward, right, up).
    const f = normalize([
      this._target[0] - eye[0],
      this._target[1] - eye[1],
      this._target[2] - eye[2],
    ]);
    const r = normalize(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    // Drag right → content right (target left); drag down → content down (target up).
    const sx = -dxScreen * worldPerPx;
    const sy = dyScreen * worldPerPx;
    this._target = [
      this._target[0] + r[0] * sx + u[0] * sy,
      this._target[1] + r[1] * sx + u[1] * sy,
      this._target[2] + r[2] * sx + u[2] * sy,
    ];
    this.changed.emit(this);
  }

  /** Eye position in world space. */
  eye(): [number, number, number] {
    const ce = Math.cos(this.elevation);
    return [
      this._target[0] + this._distance * ce * Math.sin(this.azimuth),
      this._target[1] + this._distance * Math.sin(this.elevation),
      this._target[2] + this._distance * ce * Math.cos(this.azimuth),
    ];
  }

  /** Perspective view-projection for a `vw`×`vh` viewport. */
  viewProjection(vw: number, vh: number): Mat4 {
    const aspect = vh > 0 ? vw / vh : 1;
    const near = Math.max(EPS, this._distance * 0.05);
    const far = this._distance * 4 + 1;
    const proj = perspective(this.fov, aspect, near, far);
    const view = lookAt(this.eye(), this._target, [0, 1, 0]);
    return multiply(proj, view);
  }

  /** Frame a `[w,h,d]` volume centered at the origin. */
  frame(w: number, h: number, d: number): void {
    this._target = [0, 0, 0];
    this.distance = Math.max(w, h, d) * 1.8;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

type V3 = [number, number, number];
function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(a: V3): V3 {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}
