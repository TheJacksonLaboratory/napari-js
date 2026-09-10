/**
 * World → screen projection under the 3D camera.
 *
 * The viewer owns the camera, the viewport and the clip convention, so it owns the
 * projection too. Without this a host that wants to put anything on top of a 3D scene — a
 * tooltip, a DOM label, a lasso, a hit test — has to reimplement the perspective divide and
 * the column-major indexing of {@link Camera3D.viewProjection}, and get the clip test and
 * the y-flip right by hand. Every host would write the same fifteen lines, and each copy
 * would be free to disagree with the renderer about what is on screen.
 *
 * Pure and GPU-free, like {@link nearestPointIndex}: it takes a matrix rather than a camera
 * so it is testable without a device, and so a caller can project against a pose it has
 * captured rather than only against the live one.
 */

/** Where a world point lands, and whether it is in front of the eye at all. */
export interface ProjectedPoint {
  /** CSS pixels from the canvas's left edge; `NaN` when `visible` is false. */
  x: number;
  /** CSS pixels from the canvas's TOP edge — screen convention, y down; `NaN` when hidden. */
  y: number;
  /**
   * Clip-space w, which under a standard perspective matrix is the distance along the view
   * axis. Larger is further away. Useful for choosing the front-most of several candidates.
   */
  depth: number;
  /** False when the point is at or behind the eye plane, where a divide by w is nonsense. */
  visible: boolean;
}

/** Screen positions and depths for a batch of points, in the input's order. */
export interface ProjectedPoints {
  /** `[x0, y0, x1, y1, …]` in CSS pixels; `NaN` for a point that is not visible. */
  screen: Float32Array;
  /** Clip-space w per point; `NaN` where `screen` is. */
  depth: Float32Array;
}

/**
 * Project one world point through a column-major 4×4 view-projection.
 *
 * `vw`/`vh` are the viewport in CSS pixels — the same units a pointer event reports, which
 * is the point: a caller comparing this against `event.offsetX` should not have to think
 * about device pixel ratio.
 */
export function projectPoint(
  mvp: ArrayLike<number>,
  p: readonly [number, number, number],
  vw: number,
  vh: number,
): ProjectedPoint {
  const [x, y, z] = p;
  // Column-major (gl-matrix layout): clip[r] = Σ_c M[c*4 + r] · v[c].
  const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
  const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
  const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
  // `> 0` rather than `!== 0`: at or behind the eye the divide flips the sign and puts the
  // point on the opposite side of the screen, which is worse than reporting nothing.
  //
  // NaN rather than (0, 0), matching the batch contract below. (0, 0) is the canvas corner
  // — a real position — so a caller that forgets to check `visible` would place an overlay
  // there instead of hiding it, which is exactly the sentinel-coordinate failure the batch
  // API uses NaN to avoid. Two functions in one module should not disagree about it.
  if (!(cw > 0)) return { x: NaN, y: NaN, depth: NaN, visible: false };
  return {
    x: ((cx / cw) * 0.5 + 0.5) * vw,
    // NDC y points up and the screen's points down, so this is a flip, not a scale.
    y: (1 - ((cy / cw) * 0.5 + 0.5)) * vh,
    depth: cw,
    visible: true,
  };
}

/**
 * Project N world points, `[x, y, z]` per point, x-fastest — the layout
 * {@link Points3DLayer.positions} already uses.
 *
 * Reuses `out.screen` / `out.depth` when given buffers of the right length, so a host
 * projecting a large cloud on every camera change is not allocating megabytes per frame.
 *
 * `NaN` marks a point that is not in front of the eye, rather than a sentinel coordinate or
 * a parallel boolean array: it propagates through arithmetic, it fails every comparison, and
 * so a consumer that forgets to check it gets no match rather than a wrong one.
 */
export function projectPoints(
  mvp: ArrayLike<number>,
  positions: Float32Array,
  vw: number,
  vh: number,
  out?: Partial<ProjectedPoints>,
): ProjectedPoints {
  const n = Math.floor(positions.length / 3);
  const screen = out?.screen && out.screen.length === n * 2 ? out.screen : new Float32Array(n * 2);
  const depth = out?.depth && out.depth.length === n ? out.depth : new Float32Array(n);
  screen.fill(NaN);
  depth.fill(NaN);

  const m0 = mvp[0];
  const m1 = mvp[1];
  const m3 = mvp[3];
  const m4 = mvp[4];
  const m5 = mvp[5];
  const m7 = mvp[7];
  const m8 = mvp[8];
  const m9 = mvp[9];
  const m11 = mvp[11];
  const m12 = mvp[12];
  const m13 = mvp[13];
  const m15 = mvp[15];

  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const cw = m3 * x + m7 * y + m11 * z + m15;
    if (!(cw > 0)) continue;
    const cx = m0 * x + m4 * y + m8 * z + m12;
    const cy = m1 * x + m5 * y + m9 * z + m13;
    screen[i * 2] = ((cx / cw) * 0.5 + 0.5) * vw;
    screen[i * 2 + 1] = (1 - ((cy / cw) * 0.5 + 0.5)) * vh;
    depth[i] = cw;
  }
  return { screen, depth };
}
