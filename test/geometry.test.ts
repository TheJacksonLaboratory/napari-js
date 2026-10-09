import { describe, it, expect } from 'vitest';
import {
  pointInRing,
  pointInPolygonWithHoles,
  ringArea,
  rasterizePolygon,
  floodFill,
  labelComponents,
  traceContours,
  autoContrastLimits,
  type Grid,
  type Contour,
} from '../src/geometry';
import { histogramScalar } from '../src/color/histogram';

const square = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1];

const grid = (
  w: number,
  h: number,
  on: (x: number, y: number) => number | boolean,
): Grid<Uint8Array> => {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Number(on(x, y));
  return { data, width: w, height: h };
};

/** Rasterize contours back into a w×h frame (union of outer-minus-holes). */
const reRaster = (contours: Contour[], w: number, h: number): Uint8Array => {
  const out = new Uint8Array(w * h);
  for (const c of contours) {
    const m = rasterizePolygon(c.outer, c.holes)!;
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++)
        if (m.data[y * m.width + x]) out[(m.y + y) * w + (m.x + x)] = c.value;
  }
  return out;
};

const bbox = (r: number[]) => {
  const xs = r.filter((_, i) => i % 2 === 0);
  const ys = r.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

describe('rings', () => {
  // Golden: SIV wand.service.spec "point-in-polygon detects inside vs outside for a simple square".
  it('pointInRing detects inside vs outside for a square', () => {
    const r = square(10, 10, 30, 30);
    expect(pointInRing(20, 20, r)).toBe(true);
    expect(pointInRing(5, 5, r)).toBe(false);
    expect(pointInRing(40, 20, r)).toBe(false);
    expect(pointInRing(0, 0, [0, 0, 1, 1])).toBe(false);
  });

  // Golden: "pointInPolygonWithHoles is false inside a hole, true in the solid ring".
  it('pointInPolygonWithHoles honours holes', () => {
    const outer = square(0, 0, 19, 19);
    const holes = [square(7, 7, 12, 12)];
    expect(pointInPolygonWithHoles(10, 10, outer, holes)).toBe(false);
    expect(pointInPolygonWithHoles(2, 2, outer, holes)).toBe(true);
    expect(pointInPolygonWithHoles(50, 50, outer, holes)).toBe(false);
    expect(pointInPolygonWithHoles(10, 10, outer)).toBe(true);
  });

  it('ringArea is signed by orientation', () => {
    expect(ringArea(square(0, 0, 2, 3))).toBe(6);
    expect(ringArea([0, 0, 0, 3, 2, 3, 2, 0])).toBe(-6);
  });
});

describe('rasterizePolygon', () => {
  // Golden: "rasterizePolygon fills a square exactly".
  it('fills a square by pixel centres', () => {
    const m = rasterizePolygon(square(10, 10, 20, 20))!;
    expect([m.x, m.y, m.width, m.height]).toEqual([10, 10, 10, 10]);
    expect(m.data.every((v) => v === 1)).toBe(true);
  });

  it('samples centres on fractional polygons', () => {
    // [0.4, 2.6] covers the centres 0.5, 1.5 and 2.5.
    const m = rasterizePolygon(square(0.4, 0.4, 2.6, 1.6))!;
    expect([m.x, m.width, m.height]).toEqual([0, 3, 2]);
    expect(Array.from(m.data)).toEqual([1, 1, 1, 1, 1, 1]);
    const thin = rasterizePolygon(square(0.6, 0, 1.4, 1))!; // contains no centre column 0.5/1.5
    expect(Array.from(thin.data)).toEqual([0, 0]);
  });

  // Golden: "keeps a polygon partly outside the window (no viewport clip)".
  it('keeps the full extent, including negative coordinates', () => {
    const m = rasterizePolygon(square(-5, -5, 5, 5), undefined, {
      bounds: { x: 0, y: 0, width: 50, height: 50 },
    })!;
    expect([m.x, m.y]).toEqual([-5, -5]);
  });

  // Golden: "falls back to the window for a polygon that is huge at this zoom".
  it('falls back to the bounds for a huge polygon, or throws without them', () => {
    const huge = square(-1, -1, 9000, 9000);
    const m = rasterizePolygon(huge, undefined, { bounds: { x: 0, y: 0, width: 50, height: 50 } })!;
    expect([m.x, m.y, m.width, m.height]).toEqual([0, 0, 50, 50]);
    expect(() => rasterizePolygon(huge)).toThrow(RangeError);
  });

  it('clips to bounds on request', () => {
    const m = rasterizePolygon(square(-5, -5, 5, 5), undefined, {
      bounds: { x: 0, y: 0, width: 3, height: 50 },
      clip: true,
    })!;
    expect([m.x, m.y, m.width, m.height]).toEqual([0, 0, 3, 5]);
  });

  // Golden: "rasterizePolygon punches holes back out".
  it('punches holes back out', () => {
    const m = rasterizePolygon(square(0, 0, 19, 19), [square(7, 7, 12, 12)])!;
    const at = (x: number, y: number) => m.data[(y - m.y) * m.width + (x - m.x)];
    expect(at(10, 10)).toBe(0);
    expect(at(2, 2)).toBe(1);
  });

  it('is null for a degenerate ring', () => {
    expect(rasterizePolygon([0, 0, 1, 1])).toBeNull();
    expect(rasterizePolygon([0, 0, 5, 0, 10, 0])).toBeNull(); // zero height
  });
});

describe('labelComponents', () => {
  const g = grid(5, 3, (x, y) => (x === 0 && y === 0) || (x === 1 && y === 1) || x === 4);

  it('separates corner-touching pixels with 4-connectivity, joins them with 8', () => {
    const c4 = labelComponents(g, 4);
    expect(c4.count).toBe(3);
    expect(Array.from(c4.sizes.slice(1))).toEqual([1, 3, 1]); // raster order of first pixel
    expect(Array.from(c4.bboxes.slice(8, 12))).toEqual([4, 0, 5, 3]);
    expect(labelComponents(g, 8).count).toBe(2);
  });

  it('splits a label image by value', () => {
    const lab = { data: new Uint16Array([1, 1, 2, 2, 0, 0, 0, 7]), width: 4, height: 2 };
    const c = labelComponents(lab);
    expect(c.count).toBe(3);
    expect(Array.from(c.values.slice(1))).toEqual([1, 2, 7]);
  });
});

describe('traceContours', () => {
  // Golden: "a 1-pixel mask traces to a 4-vertex unit square".
  it('traces a single pixel as its unit square, offset by origin', () => {
    const g = grid(21, 21, (x, y) => x === 10 && y === 10);
    const [c] = traceContours(g, { origin: [10, 10] });
    expect(c.outer).toEqual([20, 20, 21, 20, 21, 21, 20, 21]);
    expect(c.size).toBe(1);
    expect(ringArea(c.outer)).toBe(1);
  });

  it('traces an exact rectangle with merged collinear runs', () => {
    const g = grid(10, 8, (x, y) => x >= 2 && x < 7 && y >= 1 && y < 5);
    const [c] = traceContours(g);
    expect(c.outer).toEqual(square(2, 1, 7, 5));
    expect(c.holes).toEqual([]);
  });

  // Golden: "maskToPolygons traces an enclosed hole as an interior ring".
  it('traces an enclosed hole as an interior ring', () => {
    const donut = grid(20, 20, (x, y) => !(x >= 7 && x < 13 && y >= 7 && y < 13));
    const cs = traceContours(donut, { minSize: 4, minHoleSize: 4 });
    expect(cs).toHaveLength(1);
    expect(cs[0].holes).toHaveLength(1);
    expect(cs[0].holes[0]).toHaveLength(8);
    expect(ringArea(cs[0].holes[0])).toBe(-36);
    expect(bbox(cs[0].holes[0])).toEqual({ x0: 7, x1: 13, y0: 7, y1: 13 });
  });

  // Golden: "maskToPolygons drops a hole smaller than minHoleSize".
  it('drops holes smaller than minHoleSize', () => {
    const donut = grid(20, 20, (x, y) => !(x >= 9 && x < 11 && y >= 9 && y < 11));
    expect(traceContours(donut, { minHoleSize: 50 })[0].holes).toEqual([]);
    expect(traceContours(donut, { minHoleSize: 4 })[0].holes).toHaveLength(1);
  });

  // Golden: "a background indentation open to the border is NOT a hole".
  it('does not treat a notch open to the border as a hole', () => {
    const notched = grid(20, 20, (x, y) => !(y >= 8 && y < 12 && x >= 15));
    expect(traceContours(notched)[0].holes).toEqual([]);
  });

  it('keeps coordinates unclamped with a negative origin (RT-4)', () => {
    const donut = grid(6, 6, (x, y) => !(x >= 2 && x < 4 && y >= 2 && y < 4));
    const [c] = traceContours(donut, { origin: [-10, -20] });
    expect(bbox(c.holes[0])).toEqual({ x0: -8, x1: -6, y0: -18, y1: -16 });
    expect(bbox(c.outer)).toEqual({ x0: -10, x1: -4, y0: -20, y1: -14 });
  });

  it('returns every component largest first, honouring minSize', () => {
    const g = grid(
      12,
      4,
      (x, y) => (x < 2 && y < 2) || (x >= 5 && x < 10 && y < 3) || (x === 11 && y === 3),
    );
    const cs = traceContours(g, { minSize: 2 });
    expect(cs.map((c) => c.size)).toEqual([15, 4]);
  });

  it('splits corner-touching pixels with 4-connectivity, pinches them with 8', () => {
    const g = grid(2, 2, (x, y) => x === y);
    const four = traceContours(g);
    expect(four).toHaveLength(2);
    expect(four.every((c) => c.outer.length === 8)).toBe(true);
    const eight = traceContours(g, { connectivity: 8 });
    expect(eight).toHaveLength(1);
    expect(eight[0].outer).toHaveLength(16); // two squares joined at the pinch corner
    expect(ringArea(eight[0].outer)).toBe(2);
  });

  it('round-trips through rasterizePolygon exactly (random masks, both connectivities)', () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 40; t++) {
      const w = 6 + Math.floor(rnd() * 20);
      const h = 6 + Math.floor(rnd() * 20);
      const density = 0.3 + rnd() * 0.5;
      const g = grid(w, h, () => rnd() < density);
      for (const connectivity of [4, 8] as const) {
        const back = reRaster(traceContours(g, { connectivity }), w, h);
        expect(back, `trial ${t}, ${connectivity}-connected`).toEqual(g.data);
      }
    }
  });

  it('traces a label image per instance, reporting each value', () => {
    const lab = { data: new Uint32Array([3, 3, 0, 5, 5, 5, 0, 0, 0]), width: 3, height: 3 };
    const cs = traceContours(lab);
    expect(cs.map((c) => [c.value, c.size])).toEqual([
      [5, 3],
      [3, 2],
    ]);
    expect(reRaster(cs, 3, 3)).toEqual(new Uint8Array([3, 3, 0, 5, 5, 5, 0, 0, 0]));
  });
});

describe('floodFill', () => {
  // After SIV's wand goldens: a flat bright square in a dark field fills to exactly the square.
  const img = grid(200, 200, (x, y) => (x >= 70 && x < 130 && y >= 70 && y < 130 ? 200 : 20));

  it('fills the connected region equal to the seed', () => {
    const m = floodFill(img, 100, 100);
    let n = 0;
    for (const v of m) n += v;
    expect(n).toBe(60 * 60);
    expect(m[70 * 200 + 70]).toBe(1);
    expect(m[69 * 200 + 70]).toBe(0);
    expect(traceContours({ data: m, width: 200, height: 200 })[0].outer).toEqual(
      square(70, 70, 130, 130),
    );
  });

  it('accepts within tolerance of the SEED, not of the neighbour', () => {
    const ramp = { data: Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]), width: 8, height: 1 };
    expect(Array.from(floodFill(ramp, 0, 0, { tolerance: 2 }))).toEqual([1, 1, 1, 0, 0, 0, 0, 0]);
  });

  it('works per channel and with 8-connectivity', () => {
    const rgb = {
      data: Uint8Array.from([255, 0, 0, 0, 0, 0, 0, 0, 0, 250, 0, 0]),
      width: 2,
      height: 2,
    };
    expect(Array.from(floodFill(rgb, 0, 0, { channels: 3, tolerance: 10 }))).toEqual([1, 0, 0, 0]);
    expect(
      Array.from(floodFill(rgb, 0, 0, { channels: 3, tolerance: [10, 0, 0], connectivity: 8 })),
    ).toEqual([1, 0, 0, 1]);
  });

  it('is empty for a seed outside the grid', () => {
    expect(floodFill(img, -1, 5).some((v) => v)).toBe(false);
  });
});

describe('autoContrastLimits', () => {
  it('clips the saturation fraction at each end, keeping whole bins', () => {
    const data = new Float32Array(100).map((_, i) => i); // one value per bin over [0, 100)
    const h = histogramScalar(data, 100, 0, 100);
    expect(autoContrastLimits(h, 0.05, { dropDominantEnds: false })).toEqual([5, 95]);
    expect(autoContrastLimits(h, 0, { dropDominantEnds: false })).toEqual([0, 100]);
  });

  it('ignores a dominant first/last bin (padding)', () => {
    const counts = new Uint32Array(10).fill(10);
    counts[0] = 1000;
    const h = { counts, bins: 10, min: 0, max: 10 };
    expect(autoContrastLimits(h, 0)).toEqual([1, 10]);
    expect(autoContrastLimits(h, 0, { dropDominantEnds: false })).toEqual([0, 10]);
  });

  it('falls back to the histogram range when empty', () => {
    const h = { counts: new Uint32Array(4), bins: 4, min: 0, max: 255 };
    expect(autoContrastLimits(h, 0.01)).toEqual([0, 255]);
  });
});
