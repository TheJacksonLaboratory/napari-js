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

  /**
   * The near and far planes, which `w > 0` alone does not cover.
   *
   * Reachable by dollying, not by a contrived pose: `Camera3D` derives `near` from the
   * camera distance (`distance * 0.05`) and `far` from it too (`distance * 4 + 1`), so
   * moving the camera moves both planes through a stationary cloud.
   */
  describe('the near and far planes', () => {
    /** A camera looking down -z at the origin from `distance`. */
    function cameraAt(distance: number) {
      const cam = new Camera3D();
      cam.target = [0, 0, 0];
      cam.distance = distance;
      return cam;
    }

    it('rejects a point in front of the near plane', () => {
      // Sitting essentially at the eye: measured clip z of about -1.5e7, and the renderer
      // draws nothing — but a w-only test called it visible and pickable.
      const cam = cameraAt(100);
      const eye = cam.eye();
      const mvp = cam.viewProjection(800, 600);
      const atEye: [number, number, number] = [eye[0] * 0.999, eye[1] * 0.999, eye[2] * 0.999];
      expect(projectPoint(mvp, atEye, 800, 600).visible).toBe(false);
      const { screen } = projectPoints(mvp, Float32Array.from(atEye), 800, 600);
      expect(Number.isNaN(screen[0])).toBe(true);
    });

    it('rejects a point beyond the far plane', () => {
      const cam = cameraAt(20);
      const mvp = cam.viewProjection(800, 600);
      // far = 20*4 + 1 = 81 from the eye, and the eye is 20 out, so 200 along the view
      // axis is comfortably past it.
      const eye = cam.eye();
      const beyond = Float32Array.from([-eye[0] * 9, -eye[1] * 9, -eye[2] * 9]);
      expect(projectPoint(mvp, [beyond[0], beyond[1], beyond[2]], 800, 600).visible).toBe(false);
      expect(Number.isNaN(projectPoints(mvp, beyond, 800, 600).screen[0])).toBe(true);
    });

    it('still accepts what the camera is actually framed on', () => {
      // The guard must not reject the scene it was added to protect: a cloud framed at
      // 2.5 radii sits well inside both planes.
      const radius = 100;
      const cam = cameraAt(radius * 2.5);
      const mvp = cam.viewProjection(800, 600);
      const cloud = new Float32Array([0, 0, 0, radius, 0, 0, 0, radius, 0, 0, 0, radius]);
      const { screen } = projectPoints(mvp, cloud, 800, 600);
      expect(Array.from(screen).some(Number.isNaN)).toBe(false);
    });

    it('agrees between the single and batch paths at both planes', () => {
      const cam = cameraAt(20);
      const mvp = cam.viewProjection(800, 600);
      const eye = cam.eye();
      const pts = [
        [eye[0] * 0.999, eye[1] * 0.999, eye[2] * 0.999] as [number, number, number],
        [-eye[0] * 9, -eye[1] * 9, -eye[2] * 9] as [number, number, number],
        [0, 0, 0] as [number, number, number],
      ];
      const flat = Float32Array.from(pts.flat());
      const batch = projectPoints(mvp, flat, 800, 600);
      pts.forEach((p, i) => {
        const one = projectPoint(mvp, p, 800, 600);
        expect(one.visible).toBe(!Number.isNaN(batch.screen[i * 2]));
      });
    });
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
  // Larger depth is FURTHER: idx0 at (100,100) is the far one (depth 5), idx1 at
  // (105,100) is nearer the eye (depth 1), idx2 is off screen.
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

  /**
   * Picking has to describe the same picture the layer draws.
   *
   * `Points3DLayer` can scale a marker per point and mute one to transparency — and the
   * shader DISCARDS a fully muted point. A picker that ignores either returns something
   * the renderer did not draw, or misses a marker the cursor is plainly over.
   */
  describe('per-point styling', () => {
    it('skips a point the shader would discard', () => {
      // idx0 is under the cursor but muted to alpha 0; idx1 is drawn.
      const alphas = new Float32Array([0, 1]);
      const pickable = (i: number) => alphas[i] > 0;
      expect(nearestProjectedIndex(screen, 100, 100, 20, depth)).toBe(1);
      expect(nearestProjectedIndex(screen, 100, 100, 3, depth)).toBe(0);
      expect(nearestProjectedIndex(screen, 100, 100, 3, depth, { pickable })).toBe(-1);
    });

    it('finds an enlarged marker a flat radius would miss', () => {
      // Cursor at x=112: 12px from idx0 and 7px from idx1. At the flat radius of 3 neither
      // is found. idx1 is drawn at 4x — a 12px marker — so it does cover the cursor, and
      // only a per-point radius can tell.
      const sizes = new Float32Array([1, 4]);
      const radiusAt = (i: number) => 3 * sizes[i];
      expect(nearestProjectedIndex(screen, 112, 100, 3, depth)).toBe(-1);
      expect(nearestProjectedIndex(screen, 112, 100, 3, depth, { radiusAt })).toBe(1);
    });

    it('still prefers the front-most among what is pickable', () => {
      const radiusAt = () => 20;
      expect(nearestProjectedIndex(screen, 100, 100, 1, depth, { radiusAt })).toBe(1);
    });

    it('behaves as before when neither option is given', () => {
      expect(nearestProjectedIndex(screen, 100, 100, 20, depth, {})).toBe(
        nearestProjectedIndex(screen, 100, 100, 20, depth),
      );
    });
  });

  it('leaves the 2D picker alone', () => {
    // The existing data-coordinate picker keeps its own semantics: per-point marker size,
    // nearest centre, no depth.
    const flat2d = new Float32Array([0, 0, 10, 0]);
    expect(nearestPointIndex(flat2d, () => 4, 0.5, 0)).toBe(0);
    expect(nearestPointIndex(flat2d, () => 4, 5, 0)).toBe(-1);
  });
});
