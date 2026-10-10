/**
 * A closed polygon ring as flat coordinates `[x0, y0, x1, y1, …]` (the closing edge back to the
 * first vertex is implicit) — the layout {@link ShapesLayer} takes.
 */
export type Ring = ArrayLike<number>;

/**
 * Whether `(x, y)` is inside `ring` (even-odd ray cast). Points exactly on an edge may land
 * either way. Rings with fewer than three vertices contain nothing. Pure.
 */
export function pointInRing(x: number, y: number, ring: Ring): boolean {
  const n = ring.length >> 1;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside `outer` and outside every ring of `holes`. With no holes, {@link pointInRing}. Pure. */
export function pointInPolygonWithHoles(
  x: number,
  y: number,
  outer: Ring,
  holes?: readonly Ring[],
): boolean {
  if (!pointInRing(x, y, outer)) return false;
  if (holes) for (const h of holes) if (pointInRing(x, y, h)) return false;
  return true;
}

/**
 * Signed shoelace area of a ring. In y-down image coordinates it is positive for a ring that
 * runs clockwise on screen — the orientation {@link traceContours} gives outer rings (holes run
 * the other way). Pure.
 */
export function ringArea(ring: Ring): number {
  const n = ring.length >> 1;
  let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  }
  return a / 2;
}
