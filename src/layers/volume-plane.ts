import type { ClippingPlane } from './clipping';

/** How a volume is drawn (napari's `depiction`): the whole volume, or only a plane through it. */
export type VolumeDepiction = 'volume' | 'plane';

/**
 * The plane a `'plane'` depiction shows (napari's `plane`), in data (voxel) coordinates: voxel
 * `(i, j, k)` is centred on `[i, j, k]`. `thickness` is the slab's width along the normal, in
 * voxels (default 1).
 */
export interface VolumePlane {
  position: readonly [number, number, number];
  normal: readonly [number, number, number];
  thickness?: number;
}

/** A plane with a unit normal and a thickness: what the layer keeps. */
export interface NormalizedVolumePlane {
  position: [number, number, number];
  normal: [number, number, number];
  thickness: number;
}

/** The volume's default plane: normal +z through the middle of the volume, one voxel thick. */
export function defaultVolumePlane(
  width: number,
  height: number,
  depth: number,
): NormalizedVolumePlane {
  return {
    position: [(width - 1) / 2, (height - 1) / 2, (depth - 1) / 2],
    normal: [0, 0, 1],
    thickness: 1,
  };
}

/** Copy `plane` with a unit normal and its thickness (default 1). Throws for a zero normal or a
 *  thickness that is not positive. */
export function normalizeVolumePlane(plane: VolumePlane): NormalizedVolumePlane {
  const [nx, ny, nz] = plane.normal;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0)) throw new Error('A volume plane needs a non-zero normal.');
  const thickness = plane.thickness ?? 1;
  if (!(thickness > 0))
    throw new Error(`A volume plane's thickness must be positive (got ${thickness}).`);
  return {
    position: [plane.position[0], plane.position[1], plane.position[2]],
    normal: [nx / len, ny / len, nz / len],
    thickness,
  };
}

/**
 * Whether `point` (data coordinates) lies in the plane's slab, `|dot(point − position, n̂)| ≤
 * thickness / 2`: the CPU reference for what a thick `'plane'` depiction marches through.
 */
export function planeSlabContains(
  point: readonly [number, number, number],
  plane: VolumePlane,
): boolean {
  const p = normalizeVolumePlane(plane);
  const d =
    (point[0] - p.position[0]) * p.normal[0] +
    (point[1] - p.position[1]) * p.normal[1] +
    (point[2] - p.position[2]) * p.normal[2];
  return Math.abs(d) <= p.thickness / 2;
}

/**
 * A plane (or a clipping plane) as the half-space `dot(n̂, p) + w ≥ 0`: `[n̂x, n̂y, n̂z, w]` with
 * `w = −dot(n̂, position) + offset`. The shader's form; `offset` widens it (a slab's half thickness).
 */
export function halfSpace(
  plane: { position: readonly [number, number, number]; normal: readonly [number, number, number] },
  offset = 0,
): [number, number, number, number] {
  const [nx, ny, nz] = plane.normal;
  const len = Math.hypot(nx, ny, nz) || 1;
  const n: [number, number, number] = [nx / len, ny / len, nz / len];
  return [
    n[0],
    n[1],
    n[2],
    -(n[0] * plane.position[0] + n[1] * plane.position[1] + n[2] * plane.position[2]) + offset,
  ];
}

/**
 * Narrow the ray parameter range `[t0, t1]` to where the half-space `h` (see {@link halfSpace})
 * holds along the ray `p(t) = origin + dir · t` (data coordinates). An empty result has `t0 > t1`.
 * The CPU reference for the volume shader's `keepHalfSpace`.
 */
export function clipRayRange(
  range: readonly [number, number],
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  h: readonly [number, number, number, number],
): [number, number] {
  const a = h[0] * origin[0] + h[1] * origin[1] + h[2] * origin[2] + h[3];
  const b = h[0] * dir[0] + h[1] * dir[1] + h[2] * dir[2];
  if (Math.abs(b) < 1e-9) return a < 0 ? [1, 0] : [range[0], range[1]];
  const t = -a / b;
  return b > 0 ? [Math.max(range[0], t), range[1]] : [range[0], Math.min(range[1], t)];
}

/** The ray range left by every clipping plane (see {@link clipRayRange}). */
export function clipRayRangeByPlanes(
  range: readonly [number, number],
  origin: readonly [number, number, number],
  dir: readonly [number, number, number],
  planes: readonly ClippingPlane[],
): [number, number] {
  let r: [number, number] = [range[0], range[1]];
  for (const p of planes) {
    if (p.enabled === false) continue;
    r = clipRayRange(r, origin, dir, halfSpace(p));
  }
  return r;
}

/** A 2D image of voxel values, row by row. */
export interface VolumeSlice {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * What an axis-aligned plane one voxel thick shows: the slice of `data` (x-fastest) at the voxel
 * nearest the plane's position along its normal, or null for an oblique plane or one outside the
 * volume. The shader samples that slice at its voxel centres, so this is its CPU reference. In-plane
 * axes keep x, y, z order: a z plane is x across and y down; a y plane x across and z down; an x
 * plane y across and z down.
 */
export function volumePlaneSlice(
  volume: { data: ArrayLike<number>; width: number; height: number; depth: number },
  plane: VolumePlane,
): VolumeSlice | null {
  const p = normalizeVolumePlane(plane);
  const axis = p.normal.findIndex((c) => Math.abs(Math.abs(c) - 1) < 1e-9);
  if (axis < 0) return null;
  const { width: W, height: H, depth: D, data } = volume;
  const k = Math.round(p.position[axis]);
  if (k < 0 || k >= [W, H, D][axis]) return null;
  const [w, h] = axis === 2 ? [W, H] : axis === 1 ? [W, D] : [H, D];
  const out = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const [x, y, z] = axis === 2 ? [col, row, k] : axis === 1 ? [col, k, row] : [k, col, row];
      out[row * w + col] = data[x + W * (y + H * z)];
    }
  }
  return { width: w, height: h, data: out };
}
