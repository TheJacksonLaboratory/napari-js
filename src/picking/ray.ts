import type { ClippingPlane } from '../layers/clipping';
import { insideClippingPlanes } from '../layers/clipping';
import { invertMat4 } from '../math/mat4';

/** A ray in world coordinates: the points `origin + t · dir`, `t ≥ 0`, with `dir` of unit length. */
export interface Ray {
  origin: [number, number, number];
  dir: [number, number, number];
  /**
   * Where the ray stops counting (world units along it), if anywhere: for a {@link screenRay}, the
   * far plane — the GPU draws nothing beyond it, so a pick there would find what is not on screen.
   * Absent: the ray is unbounded.
   */
  length?: number;
}

/** Where a ray meets a mesh: `distance` along the ray (world units), the triangle, the point. */
export interface TriangleHit {
  distance: number;
  /** The triangle's index: its vertices are `faces[3·face … 3·face + 2]`. */
  face: number;
  point: [number, number, number];
}

/**
 * The ray under canvas point (`x`, `y`) of a `vw`×`vh` canvas (CSS pixels, the units of a
 * pointer event's `offsetX`/`offsetY` and of {@link projectPoint}), through the column-major
 * view-projection `mvp`: from the near plane, away from the eye, its {@link Ray.length} the
 * distance to the far plane (the depth range the camera draws). Null for a singular matrix or an
 * empty viewport. The inverse of {@link projectPoint}: a point projected to (x, y) lies on it.
 */
export function screenRay(
  mvp: ArrayLike<number>,
  x: number,
  y: number,
  vw: number,
  vh: number,
): Ray | null {
  if (!(vw > 0) || !(vh > 0)) return null;
  const inv = invertMat4(mvp);
  if (!inv) return null;
  // NDC y points up and the canvas's down; WebGPU's clip depth runs 0 (near) to 1 (far).
  const nx = (x / vw) * 2 - 1;
  const ny = 1 - (y / vh) * 2;
  const near = unproject(inv, nx, ny, 0);
  const far = unproject(inv, nx, ny, 1);
  if (!near || !far) return null;
  const dx = far[0] - near[0];
  const dy = far[1] - near[1];
  const dz = far[2] - near[2];
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 0)) return null;
  return { origin: near, dir: [dx / len, dy / len, dz / len], length: len };
}

/**
 * The distance `t ≥ 0` at which `ray` enters the box `[min, max]` (0 from inside), or `Infinity`
 * when it misses (the slab test).
 */
export function rayHitBox(
  ray: Ray,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): number {
  let t0 = 0;
  let t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const o = ray.origin[a];
    const d = ray.dir[a];
    if (d === 0) {
      if (o < min[a] || o > max[a]) return Infinity;
      continue;
    }
    let ta = (min[a] - o) / d;
    let tb = (max[a] - o) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

export interface RayHitTrianglesOptions {
  /** Hits these planes cut away do not count (see {@link ClippingPlane}). */
  clippingPlanes?: readonly ClippingPlane[];
  /** Only hits nearer than this count (default `Infinity`). */
  maxDistance?: number;
}

/**
 * The nearest triangle `ray` hits, either side (Möller–Trumbore), or null. `vertices` are N×3
 * and `faces` M×3, the layout of {@link SurfaceLayer}. Pure: the CPU counterpart of what the
 * surface draws, for picking.
 */
export function rayHitTriangles(
  ray: Ray,
  vertices: ArrayLike<number>,
  faces: ArrayLike<number>,
  opts: RayHitTrianglesOptions = {},
): TriangleHit | null {
  const planes = opts.clippingPlanes?.length ? opts.clippingPlanes : null;
  const [ox, oy, oz] = ray.origin;
  const [dx, dy, dz] = ray.dir;
  let best = opts.maxDistance ?? Infinity;
  let hit: TriangleHit | null = null;
  for (let f = 0; f + 2 < faces.length; f += 3) {
    const a = 3 * faces[f];
    const b = 3 * faces[f + 1];
    const c = 3 * faces[f + 2];
    const ax = vertices[a];
    const ay = vertices[a + 1];
    const az = vertices[a + 2];
    const e1x = vertices[b] - ax;
    const e1y = vertices[b + 1] - ay;
    const e1z = vertices[b + 2] - az;
    const e2x = vertices[c] - ax;
    const e2y = vertices[c + 1] - ay;
    const e2z = vertices[c + 2] - az;
    // p = dir × e2; det = e1 · p (zero: the ray runs along the triangle's plane).
    const px = dy * e2z - dz * e2y;
    const py = dz * e2x - dx * e2z;
    const pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const sx = ox - ax;
    const sy = oy - ay;
    const sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (!(t >= 0 && t < best)) continue;
    const point: [number, number, number] = [ox + t * dx, oy + t * dy, oz + t * dz];
    if (planes && !insideClippingPlanes(point, planes)) continue;
    best = t;
    hit = { distance: t, face: f / 3, point };
  }
  return hit;
}

function unproject(
  inv: Float64Array,
  x: number,
  y: number,
  z: number,
): [number, number, number] | null {
  const w = inv[3] * x + inv[7] * y + inv[11] * z + inv[15];
  if (!w) return null;
  return [
    (inv[0] * x + inv[4] * y + inv[8] * z + inv[12]) / w,
    (inv[1] * x + inv[5] * y + inv[9] * z + inv[13]) / w,
    (inv[2] * x + inv[6] * y + inv[10] * z + inv[14]) / w,
  ];
}
