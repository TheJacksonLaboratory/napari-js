/**
 * A clipping plane (napari's `ClippingPlane`), in the layer's data coordinates (a volume's voxel
 * units, a surface's vertex units). What lies on the side the normal points away from is cut away:
 * a point `p` is kept when `dot(p − position, normal) ≥ 0`, as vispy's planes clipper does.
 */
export interface ClippingPlane {
  /** A point on the plane, `[x, y, z]`. */
  position: readonly [number, number, number];
  /** The plane's normal, toward the side kept, `[x, y, z]` (need not be unit length). */
  normal: readonly [number, number, number];
  /** Off planes clip nothing. Default true. */
  enabled?: boolean;
}

/** At most this many planes clip one layer (the shader's uniform array size). */
export const MAX_CLIPPING_PLANES = 6;

/**
 * The enabled planes, copied, with unit normals; a zero normal is dropped. Throws for more than
 * {@link MAX_CLIPPING_PLANES} enabled planes.
 */
export function normalizeClippingPlanes(planes: readonly ClippingPlane[]): ClippingPlane[] {
  const out: ClippingPlane[] = [];
  for (const p of planes) {
    if (p.enabled === false) continue;
    const [nx, ny, nz] = p.normal;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue;
    out.push({
      position: [p.position[0], p.position[1], p.position[2]],
      normal: [nx / len, ny / len, nz / len],
    });
  }
  if (out.length > MAX_CLIPPING_PLANES) {
    throw new Error(
      `At most ${MAX_CLIPPING_PLANES} clipping planes per layer (got ${out.length}).`,
    );
  }
  return out;
}

/** Whether `point` (data coordinates) survives every plane: the CPU reference for the shaders. */
export function insideClippingPlanes(
  point: readonly [number, number, number],
  planes: readonly ClippingPlane[],
): boolean {
  for (const p of planes) {
    if (p.enabled === false) continue;
    const d =
      (point[0] - p.position[0]) * p.normal[0] +
      (point[1] - p.position[1]) * p.normal[1] +
      (point[2] - p.position[2]) * p.normal[2];
    if (d < 0) return false;
  }
  return true;
}
