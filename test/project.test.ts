import { describe, it, expect } from 'vitest';
import { projectPoint, projectPoints } from '../src/picking/project';
import { nearestProjectedIndex, nearestPointIndex } from '../src/picking/pick';
import { Camera3D } from '../src/camera/camera3d';

/**
 * World → screen under the 3D camera, and picking on the result.
 *
 * These are pure and matrix-driven on purpose: the whole reason they belong in the renderer
 * is that the clip convention, the y-flip and the behind-the-eye case are the viewer's to
 * define, and a host reimplementing them is free to disagree with what was actually drawn.
 */

/** A column-major orthographic-ish matrix: identity clip, w = 1. Easy to reason about. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Column-major matrix with w = z, i.e. a crude perspective divide by depth. */
const PERSPECTIVE = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0]);

describe('projectPoint', () => {
  it('maps the clip origin to the centre of the viewport', () => {
    const p = projectPoint(IDENTITY, [0, 0, 0], 800, 600);
    expect(p.visible).toBe(true);
    expect(p.x).toBeCloseTo(400, 5);
    expect(p.y).toBeCloseTo(300, 5);
  });

  it('flips y, because NDC points up and the screen points down', () => {
    // The single most repeated mistake when a host rolls its own projection: a label that
    // tracks correctly in x and mirrors in y.
    const top = projectPoint(IDENTITY, [0, 1, 0], 800, 600);
    const bottom = projectPoint(IDENTITY, [0, -1, 0], 800, 600);
    expect(top.y).toBeCloseTo(0, 5);
    expect(bottom.y).toBeCloseTo(600, 5);
  });

  it('scales x to the viewport width', () => {
    expect(projectPoint(IDENTITY, [1, 0, 0], 800, 600).x).toBeCloseTo(800, 5);
    expect(projectPoint(IDENTITY, [-1, 0, 0], 800, 600).x).toBeCloseTo(0, 5);
  });

  it('reports the perspective divide, not the raw clip coordinate', () => {
    // At w = 2 the point is half as far from centre as its clip x suggests.
    const p = projectPoint(PERSPECTIVE, [1, 0, 2], 800, 600);
    expect(p.depth).toBe(2);
    expect(p.x).toBeCloseTo(0.5 * 0.5 * 800 + 400, 5);
  });

  it('refuses a point at or behind the eye rather than mirroring it', () => {
    // A divide by a non-positive w flips the sign and puts the point on the OPPOSITE side
    // of the screen, which is worse than reporting nothing: an overlay would show a label
    // for something behind the viewer.
    for (const z of [0, -1, -100]) {
      const p = projectPoint(PERSPECTIVE, [1, 1, z], 800, 600);
      expect(p.visible).toBe(false);
      expect(Number.isNaN(p.depth)).toBe(true);
    }
  });

  it('reports NaN coordinates when hidden, not the canvas corner', () => {
    // (0, 0) is a REAL screen position — the top-left corner — so a caller that forgets to
    // check `visible` would place an overlay there rather than hide it. That is the exact
    // sentinel-coordinate failure the batch API uses NaN to avoid, and the two functions
    // in this module must not disagree about it.
    const hidden = projectPoint(PERSPECTIVE, [1, 1, -1], 800, 600);
    expect(Number.isNaN(hidden.x)).toBe(true);
    expect(Number.isNaN(hidden.y)).toBe(true);
  });

  it('agrees with the batch form about a hidden point', () => {
    // The two used to disagree: one said (0, 0), the other NaN. `toEqual` compares NaN as
    // equal to NaN, so this is a real assertion on both sides rather than on neither.
    const one = projectPoint(PERSPECTIVE, [1, 1, -1], 800, 600);
    const many = projectPoints(PERSPECTIVE, new Float32Array([1, 1, -1]), 800, 600);
    expect([one.x, one.y]).toEqual([NaN, NaN]);
    expect([many.screen[0], many.screen[1]]).toEqual([NaN, NaN]);
    expect([one.x, one.y]).toEqual([many.screen[0], many.screen[1]]);
  });
});

describe('projectPoints', () => {
  it('projects a batch in input order, x-fastest', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const { screen, depth } = projectPoints(IDENTITY, positions, 800, 600);
    expect(Array.from(screen)).toEqual([400, 300, 800, 300, 400, 0]);
    expect(Array.from(depth)).toEqual([1, 1, 1]);
  });

  it('marks a point behind the eye with NaN, not a sentinel coordinate', () => {
    // NaN fails every comparison, so a consumer that forgets to check gets no match
    // instead of a wrong one. A sentinel like -1 is a real screen position.
    const positions = new Float32Array([0, 0, 1, 0, 0, -1]);
    const { screen, depth } = projectPoints(PERSPECTIVE, positions, 800, 600);
    expect(screen[0]).toBeCloseTo(400, 5);
    expect(Number.isNaN(screen[2])).toBe(true);
    expect(Number.isNaN(screen[3])).toBe(true);
    expect(Number.isNaN(depth[1])).toBe(true);
  });

  it('agrees with the single-point version', () => {
    const positions = new Float32Array([0.3, -0.7, 2, -0.2, 0.5, 5]);
    const { screen, depth } = projectPoints(PERSPECTIVE, positions, 1024, 768);
    for (let i = 0; i < 2; i++) {
      const one = projectPoint(
        PERSPECTIVE,
        [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]],
        1024,
        768,
      );
      expect(screen[i * 2]).toBeCloseTo(one.x, 4);
      expect(screen[i * 2 + 1]).toBeCloseTo(one.y, 4);
      expect(depth[i]).toBeCloseTo(one.depth, 4);
    }
  });

  it('reuses supplied buffers, so a big cloud is not reallocated per camera change', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const screen = new Float32Array(4);
    const depth = new Float32Array(2);
    const out = projectPoints(IDENTITY, positions, 800, 600, { screen, depth });
    expect(out.screen).toBe(screen);
    expect(out.depth).toBe(depth);
  });

  it('ignores a wrong-sized buffer instead of writing out of bounds', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0]);
    const out = projectPoints(IDENTITY, positions, 800, 600, { screen: new Float32Array(2) });
    expect(out.screen.length).toBe(4);
  });

  it('clears stale entries when a buffer is reused', () => {
    // Without the fill, a point that has moved behind the eye would keep the screen
    // position it had last frame — an overlay frozen where the point no longer is.
    const screen = new Float32Array([1, 2, 3, 4]);
    const depth = new Float32Array([9, 9]);
    const positions = new Float32Array([0, 0, -1, 0, 0, -1]);
    const out = projectPoints(PERSPECTIVE, positions, 800, 600, { screen, depth });
    expect(Array.from(out.screen).every(Number.isNaN)).toBe(true);
    expect(Array.from(out.depth).every(Number.isNaN)).toBe(true);
  });

  it('works against a real Camera3D view-projection', () => {
    // The contract that matters: the matrix the renderer draws with is the matrix a host
    // can project with, with no transposition or convention shim in between.
    const cam = new Camera3D();
    cam.target = [10, 20, 30];
    cam.distance = 100;
    const mvp = cam.viewProjection(800, 600);
    const { screen, depth } = projectPoints(mvp, new Float32Array([10, 20, 30]), 800, 600);
    // The camera looks at its target, so the target lands in the middle of the viewport.
    expect(screen[0]).toBeCloseTo(400, 2);
    expect(screen[1]).toBeCloseTo(300, 2);
    expect(depth[0]).toBeCloseTo(100, 2);
  });
});

describe('nearestProjectedIndex', () => {
  //         idx0 at (100,100) near, idx1 at (105,100) far, idx2 offscreen
  const screen = new Float32Array([100, 100, 105, 100, NaN, NaN]);
  const depth = new Float32Array([5, 1, NaN]);

  it('returns -1 when nothing is within the radius', () => {
    expect(nearestProjectedIndex(screen, 400, 400, 10, depth)).toBe(-1);
  });

  it('prefers the FRONT-most candidate, not the nearest to the cursor', () => {
    // The renderer depth-tests these billboards. A picker that ignored depth would answer
    // 0 here — a point drawn behind the one the cursor is actually over — and the tooltip
    // would name something the viewer has covered up.
    expect(nearestProjectedIndex(screen, 100, 100, 20, depth)).toBe(1);
  });

  it('falls back to nearest-centre without depths', () => {
    expect(nearestProjectedIndex(screen, 100, 100, 20)).toBe(0);
  });

  it('breaks a depth tie by cursor distance, not by input order', () => {
    const flat = new Float32Array([1, 1, 1]);
    expect(nearestProjectedIndex(screen, 104, 100, 20, flat)).toBe(1);
    expect(nearestProjectedIndex(screen, 101, 100, 20, flat)).toBe(0);
  });

  it('never matches a NaN entry', () => {
    // Points behind the eye, or belonging to a section that is not drawn.
    const hidden = new Float32Array([NaN, NaN]);
    expect(nearestProjectedIndex(hidden, 0, 0, 1e6, new Float32Array([1]))).toBe(-1);
  });

  it('respects the radius as a hard cutoff', () => {
    expect(nearestProjectedIndex(screen, 100, 100, 4, depth)).toBe(0); // idx1 is 5px away
    expect(nearestProjectedIndex(screen, 100, 100, 6, depth)).toBe(1);
  });

  it('leaves the 2D picker alone', () => {
    // The existing data-coordinate picker keeps its own semantics: per-point marker size,
    // nearest centre, no depth.
    const flat2d = new Float32Array([0, 0, 10, 0]);
    expect(nearestPointIndex(flat2d, () => 4, 0.5, 0)).toBe(0);
    expect(nearestPointIndex(flat2d, () => 4, 5, 0)).toBe(-1);
  });
});
