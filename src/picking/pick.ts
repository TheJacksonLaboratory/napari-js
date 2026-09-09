/**
 * Index of the point whose marker contains `(x, y)` (data coords), nearest center wins, or
 * -1 if none. `sizeAt(i)` returns marker diameter in data units. Pure and GPU-free — the CPU
 * hit-test for point picking (GPU id-buffer picking can come later if needed).
 */
export function nearestPointIndex(
  positions: Float32Array,
  sizeAt: (i: number) => number,
  x: number,
  y: number,
): number {
  let best = -1;
  let bestD2 = Infinity;
  const n = positions.length >> 1;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 2] - x;
    const dy = positions[i * 2 + 1] - y;
    const d2 = dx * dx + dy * dy;
    const r = sizeAt(i) / 2;
    if (d2 <= r * r && d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}

/**
 * The 3D counterpart: index of the point under `(x, y)` in SCREEN pixels, or -1.
 *
 * Takes already-projected positions from {@link projectPoints} rather than a camera, and
 * that is what makes it affordable — a cloud is projected once per camera change and then
 * hit-tested on every pointer move, so re-projecting millions of points per `pointermove`
 * is not something to build in.
 *
 * FRONT-MOST WINS when `depth` is given, which is the reason this is not simply
 * {@link nearestPointIndex} over projected coordinates. In a dense cloud the cursor covers
 * many points at once; nearest-to-centre returns whichever happens to be best aligned, even
 * when it sits well behind something drawn over it. The renderer depth-tests these
 * billboards, so a picker that ignores depth disagrees with what the viewer actually drew,
 * and a tooltip naming a hidden point reads as a wrong tooltip rather than as a nuance of
 * picking. Ties fall back to cursor distance, so coincident points do not resolve by input
 * order.
 *
 * Without `depth` it degrades to nearest-centre, so a caller holding only screen positions
 * still gets a sensible answer.
 *
 * `NaN` entries — behind the eye, or not currently drawn — never match, because every
 * comparison against NaN is false.
 */
export function nearestProjectedIndex(
  screen: Float32Array,
  x: number,
  y: number,
  radius: number,
  depth?: Float32Array | null,
): number {
  const n = screen.length >> 1;
  const r2 = radius * radius;
  let best = -1;
  let bestDepth = Infinity;
  let bestD2 = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = screen[i * 2] - x;
    const dy = screen[i * 2 + 1] - y;
    const d2 = dx * dx + dy * dy;
    if (!(d2 <= r2)) continue; // rejects NaN too
    if (!depth) {
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
      continue;
    }
    const z = depth[i];
    if (z < bestDepth) {
      bestDepth = z;
      bestD2 = d2;
      best = i;
    } else if (z === bestDepth && d2 < bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}
