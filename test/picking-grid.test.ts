import { describe, it, expect, vi } from 'vitest';
import { GridIndex } from '../src/picking/grid-index';
import { PointsLayer } from '../src/layers/points-layer';
import { PointPicker } from '../src/picking/point-picker';
import { nearestProjectedIndex } from '../src/picking/pick';
import { HeadlessViewer } from '../src/testing';
import { Points3DLayer } from '../src/layers/points3d-layer';

/** Deterministic pseudo-random coordinates, so the "same as linear" checks are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

describe('GridIndex', () => {
  const XY = new Float32Array([0, 0, 10, 0, 10, 10, NaN, 5, 3, 3]);

  it('indexes the finite points over their bounding box by default', () => {
    const g = new GridIndex(XY, { cell: 4 });
    expect(g.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(g.indexed).toBe(4); // the NaN point is left out
    // floor(10 / 4) + 1: the inclusive upper bound has a cell.
    expect([g.cols, g.rows]).toEqual([3, 3]);
  });

  it('visits every point within the radius (a superset), each once', () => {
    const g = new GridIndex(XY, { cell: 4 });
    const seen: number[] = [];
    g.forEachCandidate(9, 9, 1.5, (i) => seen.push(i));
    expect(seen).toContain(2);
    expect(new Set(seen).size).toBe(seen.length);
    const all: number[] = [];
    g.forEachCandidate(5, 5, 100, (i) => all.push(i));
    expect(all.sort()).toEqual([0, 1, 2, 4]);
  });

  it('drops points outside explicit bounds, and visits nothing for a NaN query', () => {
    const g = new GridIndex(XY, { cell: 4, bounds: { minX: 0, minY: 0, maxX: 5, maxY: 5 } });
    expect(g.indexed).toBe(2); // (0,0) and (3,3)
    const fn = vi.fn();
    g.forEachCandidate(NaN, 1, 5, fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it('sizes cells from the density and caps the cell count', () => {
    const rand = lcg(1);
    const xy = new Float32Array(2000).map(() => rand() * 1000);
    const g = new GridIndex(xy);
    expect(g.cols * g.rows).toBeLessThanOrEqual(Math.max(4096, 4 * 1000));
    // A degenerate (collinear) set still gets a bounded grid.
    const line = new Float32Array(2000).map((_, i) => (i % 2 ? 5 : i));
    const gl = new GridIndex(line);
    expect(gl.rows).toBe(1);
    expect(gl.cols).toBeLessThanOrEqual(4096);
    expect(gl.indexed).toBe(1000);
    // Empty is fine.
    expect(new GridIndex(new Float32Array(0)).indexed).toBe(0);
  });
});

describe('PointsLayer.pick', () => {
  // Three markers of diameter 10 (radius 5); 1 and 2 overlap.
  const pts = new Float32Array([0, 0, 20, 0, 24, 0]);

  it('hits a marker within its drawn radius and misses outside', () => {
    const p = new PointsLayer(pts, { size: 10 });
    expect(p.pick(1, 1)).toBe(0);
    expect(p.pick(0, 5)).toBe(0); // on the edge
    expect(p.pick(0, 5.1)).toBe(-1);
    expect(p.pick(100, 100)).toBe(-1);
  });

  it("tieBreak 'topmost' (default) takes the last drawn, 'nearest' the closest centre", () => {
    const p = new PointsLayer(pts, { size: 10 });
    // (21, 0) is inside both 1 (d = 1) and 2 (d = 3).
    expect(p.pick(21, 0)).toBe(2);
    expect(p.pick(21, 0, { tieBreak: 'topmost' })).toBe(2);
    expect(p.pick(21, 0, { tieBreak: 'nearest' })).toBe(1);
    // Equidistant: 'nearest' falls back to topmost.
    expect(p.pick(22, 0, { tieBreak: 'nearest' })).toBe(2);
    // Coincident points: the later one is on top under both rules.
    const same = new PointsLayer(new Float32Array([5, 5, 5, 5]), { size: 4 });
    expect(same.pick(5, 5, { tieBreak: 'nearest' })).toBe(1);
    expect(same.pick(5, 5)).toBe(1);
  });

  it('tolerance floors every radius; radiusAt and pickable override per point', () => {
    const p = new PointsLayer(pts, { size: 2 }); // radius 1
    expect(p.pick(0, 3)).toBe(-1);
    expect(p.pick(0, 3, { tolerance: 3 })).toBe(0);
    expect(p.pick(0, 3, { radiusAt: (i) => (i === 0 ? 4 : 1), maxRadius: 4 })).toBe(0);
    expect(p.pick(21, 0, { tolerance: 5, pickable: (i) => i !== 2 })).toBe(1);
  });

  it('takes world coordinates through scale/translate; radii scale with the layer', () => {
    const p = new PointsLayer(pts, { size: 10, scale: [2, 2], translate: [100, 50] });
    // Point 0 is at world (100, 50) with a world radius of 10.
    expect(p.pick(109, 50)).toBe(0);
    expect(p.pick(111, 50)).toBe(-1);
    expect(p.pick(111, 50, { tolerance: 11 })).toBe(0);
  });

  it('agrees with a linear scan of the same rules over a random cloud', () => {
    const rand = lcg(7);
    const n = 3000;
    const xy = new Float32Array(n * 2).map(() => rand() * 500);
    const sizes = Array.from({ length: n }, () => 1 + rand() * 9);
    const layer = new PointsLayer(xy, { size: sizes });
    const linear = (x: number, y: number, tieBreak: 'topmost' | 'nearest', tol: number): number => {
      let best = -1;
      let bestD2 = Infinity;
      for (let i = 0; i < n; i++) {
        const d2 = (xy[i * 2] - x) ** 2 + (xy[i * 2 + 1] - y) ** 2;
        const r = Math.max(sizes[i] / 2, tol);
        if (d2 > r * r) continue;
        if (tieBreak === 'topmost' ? i > best : d2 < bestD2 || (d2 === bestD2 && i > best)) {
          best = i;
          bestD2 = d2;
        }
      }
      return best;
    };
    for (let q = 0; q < 300; q++) {
      const x = rand() * 500;
      const y = rand() * 500;
      for (const tb of ['topmost', 'nearest'] as const) {
        expect(layer.pick(x, y, { tieBreak: tb, tolerance: 3 })).toBe(linear(x, y, tb, 3));
      }
    }
  });

  it('builds the index lazily and rebuilds it only when the data moves', () => {
    const spy = vi.spyOn(GridIndex, 'suggestCell');
    const p = new PointsLayer(pts, { size: 10 });
    expect(spy).not.toHaveBeenCalled();
    p.pick(0, 0);
    p.pick(1, 1);
    expect(spy).toHaveBeenCalledTimes(1);
    p.symbol = 'star'; // a uniform: no rebuild
    p.pick(0, 0);
    expect(spy).toHaveBeenCalledTimes(1);
    p.size = 50; // data clock: rebuild, and the larger markers are found
    expect(p.pick(0, 20)).toBe(0);
    expect(spy).toHaveBeenCalledTimes(2);
    p.positions = new Float32Array([100, 100, 200, 200, 300, 300]); // replaced array
    expect(p.pick(100, 100)).toBe(0);
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});

describe('PointPicker', () => {
  const CLOUD = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, -10, -10, 5]);

  function setup(opts = {}) {
    const viewer = new HeadlessViewer({ canvasRect: { width: 400, height: 300 } });
    const layer = viewer.addPoints3D(CLOUD);
    const picker = new PointPicker(viewer, layer, opts);
    return { viewer, layer, picker };
  }

  it('picks what nearestProjectedIndex picks on a fresh projection', () => {
    const { viewer, layer, picker } = setup();
    const ref = viewer.projectPoints(layer.positions)!;
    for (let i = 0; i < layer.count; i++) {
      const x = ref.screen[i * 2];
      const y = ref.screen[i * 2 + 1];
      expect(picker.pick(x, y, 4)).toBe(i);
      expect(picker.pick(x + 1, y, 4)).toBe(
        nearestProjectedIndex(ref.screen, x + 1, y, 4, ref.depth),
      );
    }
    expect(picker.pick(-500, -500, 4)).toBe(-1);
  });

  it('projects lazily, reuses its buffers, and re-projects after the camera moves', () => {
    const { viewer, layer, picker } = setup();
    const spy = vi.spyOn(viewer, 'projectPoints');
    viewer.camera3d.distance *= 1.1; // no projection on the event itself
    expect(spy).not.toHaveBeenCalled();
    picker.pick(0, 0, 4);
    picker.pick(1, 1, 4);
    expect(spy).toHaveBeenCalledTimes(1);
    const first = picker.projected()!;
    const firstScreen = first.screen;
    const before = Array.from(firstScreen);
    viewer.camera3d.distance *= 2;
    picker.pick(0, 0, 4);
    expect(spy).toHaveBeenCalledTimes(2);
    // Same buffers, new contents.
    expect(picker.projected()!.screen).toBe(firstScreen);
    expect(Array.from(picker.projected()!.screen)).not.toEqual(before);
    layer.values = new Float32Array(4); // data clock
    picker.pick(0, 0, 4);
    expect(spy).toHaveBeenCalledTimes(3);
    viewer.setCanvasRect({ width: 500, height: 300 }); // resize
    picker.pick(0, 0, 4);
    expect(spy).toHaveBeenCalledTimes(4);
    layer.alphas = new Float32Array([1, 1, 1, 1]); // style: no re-projection
    picker.pick(0, 0, 4);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("follows the layer's per-point style: muted points are not picked, sizes scale radii", () => {
    const { viewer, layer, picker } = setup();
    const ref = viewer.projectPoints(layer.positions)!;
    const [x1, y1] = [ref.screen[2], ref.screen[3]];
    expect(picker.pick(x1, y1, 4)).toBe(1);
    layer.alphas = new Float32Array([1, 0, 1, 1]);
    expect(picker.pick(x1, y1, 4)).toBe(-1);
    // An explicit `pickable` wins over the layer's alphas.
    expect(picker.pick(x1, y1, 4, { pickable: () => true })).toBe(1);
    layer.alphas = null;
    layer.sizes = new Float32Array([1, 3, 1, 1]);
    expect(picker.pick(x1 + 10, y1, 4)).toBe(1); // 10 px out, within 4 × 3
    expect(picker.pick(x1 + 10, y1, 4, { radiusAt: () => 4 })).toBe(-1);
  });

  it('uses a ScreenIndex above the threshold with the same answers', () => {
    const indexed = setup({ indexThreshold: 0, maxReach: 16 });
    const linear = setup();
    const ref = indexed.viewer.projectPoints(indexed.layer.positions)!;
    for (let i = 0; i < 4; i++) {
      const x = ref.screen[i * 2] + 2;
      const y = ref.screen[i * 2 + 1] - 1;
      expect(indexed.picker.pick(x, y, 6)).toBe(linear.picker.pick(x, y, 6));
    }
  });

  it('stops listening on dispose', () => {
    const { viewer, picker } = setup();
    picker.dispose();
    expect(() => picker.pick(0, 0, 4)).toThrow(/after dispose/);
    expect(() => {
      viewer.camera3d.distance *= 2;
    }).not.toThrow();
    picker.dispose(); // idempotent
  });

  it('returns -1 before the canvas has a size', () => {
    const viewer = new HeadlessViewer({ canvasRect: { width: 0, height: 0 } });
    const layer = new Points3DLayer(CLOUD);
    expect(new PointPicker(viewer, layer).pick(0, 0, 4)).toBe(-1);
  });
});
