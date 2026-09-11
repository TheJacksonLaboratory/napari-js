import { describe, it, expect } from 'vitest';
import { ScreenIndex, pickLinear, SCREEN_INDEX_MIN_POINTS } from '../src/picking/screen-index';
import { nearestProjectedIndex } from '../src/picking/pick';
import type { ProjectedPoints } from '../src/picking/project';

/**
 * The grid exists to make picking affordable at scale, so the thing to prove is that it
 * gives the SAME answer as the linear scan. A faster picker that disagrees with the slow
 * one is not an optimisation, it is a second implementation of the bug.
 */

function projected(screen: number[], depth?: number[]): ProjectedPoints {
  return {
    screen: Float32Array.from(screen),
    depth: Float32Array.from(depth ?? screen.filter((_, i) => i % 2 === 0).map(() => 1)),
  };
}

describe('ScreenIndex', () => {
  it('finds the point under the cursor', () => {
    const p = projected([100, 100, 300, 200]);
    const idx = new ScreenIndex(p, 800, 600);
    expect(idx.pick(100, 100, 6)).toBe(0);
    expect(idx.pick(300, 200, 6)).toBe(1);
    expect(idx.pick(500, 500, 6)).toBe(-1);
  });

  it('prefers the front-most, like the linear scan', () => {
    const p = projected([100, 100, 105, 100], [5, 1]);
    const idx = new ScreenIndex(p, 800, 600);
    expect(idx.pick(100, 100, 20)).toBe(1);
    expect(idx.pick(100, 100, 20)).toBe(pickLinear(p, 100, 100, 20));
  });

  it('does not index NaN points, or centres beyond the margin', () => {
    // Beyond the reach no marker can touch the cursor, so leaving them out shrinks the
    // grid. Centres just outside the canvas are a different case — see the edge tests.
    const p = projected([NaN, NaN, -50, 100, 900, 100, 100, 100], [1, 1, 1, 1]);
    const idx = new ScreenIndex(p, 800, 600);
    expect(idx.indexed).toBe(1);
    expect(idx.pick(100, 100, 6)).toBe(3);
  });

  it('honours a search radius that spans several cells', () => {
    // The cell edge is smaller than the radius here, so the query has to visit a
    // neighbourhood rather than one bucket.
    const p = projected([100, 100]);
    const idx = new ScreenIndex(p, 800, 600, { cell: 8 });
    expect(idx.pick(140, 100, 50)).toBe(0);
    expect(idx.pick(140, 100, 30)).toBe(-1);
  });

  it('carries the per-point radius and pickability through', () => {
    const p = projected([100, 100, 112, 100], [5, 1]);
    const idx = new ScreenIndex(p, 800, 600);
    expect(idx.pick(112, 100, 3)).toBe(1);
    expect(idx.pick(112, 100, 3, { pickable: (i) => i !== 1 })).toBe(-1);
    expect(idx.pick(100, 100, 30, { radiusAt: () => 30 })).toBe(1); // front-most in range
  });

  /**
   * The property that matters, on random data: same answer as the scan it replaces.
   */
  it('agrees with the linear scan over a randomised cloud', () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const n = 4000;
    const screen = new Float32Array(n * 2);
    const depth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // A tenth of them unprojected, to keep NaN in the comparison.
      if (rnd() < 0.1) {
        screen[i * 2] = NaN;
        screen[i * 2 + 1] = NaN;
        depth[i] = NaN;
        continue;
      }
      // Centres OVERHANG the canvas by 40px on every side. The earlier version of this
      // test drew them from inside the viewport only, which is precisely why it could not
      // see that the index dropped markers whose centres sat just outside it.
      screen[i * 2] = -40 + rnd() * (800 + 80);
      screen[i * 2 + 1] = -40 + rnd() * (600 + 80);
      depth[i] = rnd() * 100;
    }
    const p: ProjectedPoints = { screen, depth };
    const idx = new ScreenIndex(p, 800, 600);

    for (let t = 0; t < 600; t++) {
      // Cursors reach the very edges too, where the disagreement lived.
      const x = rnd() * 800;
      const y = rnd() * 600;
      const r = 4 + rnd() * 20;
      const fromGrid = idx.pick(x, y, r);
      const fromScan = nearestProjectedIndex(screen, x, y, r, depth);
      // Depths are random reals, so a tie is vanishingly unlikely and the two must agree
      // on the exact index, not merely on finding something.
      expect(fromGrid).toBe(fromScan);
    }
  });

  /**
   * Markers whose CENTRE is off the canvas but whose body is not.
   *
   * The regression this pins: the index kept only centres inside the viewport, so a marker
   * crossing an edge was drawn and pickable by the linear scan but invisible to the grid.
   * Which edges it affected depended on arithmetic — `ceil(600/32)` overhangs to 608 and
   * accidentally hid it on the bottom, `ceil(800/32)` is exact and exposed it on the right.
   */
  describe('markers crossing the canvas edge', () => {
    const RADIUS = 6;

    /** Both pickers' answers for a single marker at `(cx, cy)`, probed from `(x, y)`. */
    function both(cx: number, cy: number, x: number, y: number) {
      const screen = Float32Array.from([cx, cy]);
      const depth = Float32Array.from([1]);
      return {
        linear: nearestProjectedIndex(screen, x, y, RADIUS, depth),
        indexed: new ScreenIndex({ screen, depth }, 800, 600).pick(x, y, RADIUS),
      };
    }

    const edges: Array<[string, number, number, number, number]> = [
      ['left', -2, 100, 1, 100],
      ['right', 802, 100, 799, 100],
      ['top', 100, -2, 100, 1],
      ['bottom', 100, 602, 100, 599],
      ['exactly x = width', 800, 100, 797, 100],
      ['exactly y = height', 100, 600, 100, 597],
      ['corner', -2, -2, 1, 1],
    ];

    for (const [label, cx, cy, x, y] of edges) {
      it(`agrees with the linear picker at the ${label}`, () => {
        const { linear, indexed } = both(cx, cy, x, y);
        expect(linear).toBe(0); // the marker really is under the cursor
        expect(indexed).toBe(linear);
      });
    }

    it('still excludes a centre too far out to reach the cursor', () => {
      // The margin is a reach, not an invitation to index the whole plane.
      const { linear, indexed } = both(-5000, 100, 1, 100);
      expect(linear).toBe(-1);
      expect(indexed).toBe(-1);
    });

    it('indexes a centre within the margin rather than dropping it', () => {
      const screen = Float32Array.from([-20, 300]);
      const idx = new ScreenIndex({ screen, depth: Float32Array.from([1]) }, 800, 600);
      expect(idx.indexed).toBe(1);
      expect(idx.margin).toBeGreaterThan(0);
    });

    it('takes a larger reach for larger markers', () => {
      const screen = Float32Array.from([-60, 300]);
      const depth = Float32Array.from([1]);
      expect(new ScreenIndex({ screen, depth }, 800, 600).indexed).toBe(0); // beyond the default
      expect(new ScreenIndex({ screen, depth }, 800, 600, { maxReach: 80 }).indexed).toBe(1);
    });
  });

  it('handles an empty cloud and a degenerate viewport', () => {
    const empty = new ScreenIndex(projected([]), 800, 600);
    expect(empty.pick(0, 0, 10)).toBe(-1);
    const tiny = new ScreenIndex(projected([1, 1]), 0, 0);
    expect(tiny.cols).toBeGreaterThan(0);
    expect(tiny.rows).toBeGreaterThan(0);
  });

  it('names a threshold below which indexing is not worth it', () => {
    // The build is a full pass, so for a small cloud it costs more than every pick it
    // would serve. Callers branch on this rather than guessing.
    expect(SCREEN_INDEX_MIN_POINTS).toBeGreaterThan(0);
  });
});
