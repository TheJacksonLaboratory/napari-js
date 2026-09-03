import { describe, it, expect } from 'vitest';
import {
  ShapesLayer,
  ringsToOutline,
  ringsToFan,
  shapeVertexCount,
} from '../src/layers/shapes-layer';

// Two shapes, as flat rings: a 2×2 square then a triangle.
const SQUARE = [0, 0, 2, 0, 2, 2, 0, 2]; // vertices 0..3
const TRIANGLE = [10, 10, 14, 10, 12, 14]; // vertices 4..6
const COORDS = new Float32Array([...SQUARE, ...TRIANGLE]);
const OFFSETS = new Uint32Array([0, 4, 7]);

describe('ring expansion', () => {
  it('counts vertices without building the geometry', () => {
    // outline: 4 + 3 edges × 2; fill: 4 + 3 triangles × 3.
    expect(shapeVertexCount(OFFSETS, 'outline')).toBe(14);
    expect(shapeVertexCount(OFFSETS, 'fill')).toBe(21);
  });

  it('closes each ring, so the last edge returns to the first vertex', () => {
    const { positions, count } = ringsToOutline(COORDS, new Uint32Array([0, 4]));
    expect(count).toBe(8); // 4 edges × 2
    // Edge 3 is (0,2) → (0,0): the closing edge nobody stores explicitly.
    const last = Array.from(positions.slice(12, 16));
    expect(last).toEqual([0, 2, 0, 0]);
  });

  it('maps every emitted vertex back to its shape', () => {
    const { shapeIds } = ringsToOutline(COORDS, OFFSETS);
    expect(Array.from(shapeIds.slice(0, 8)).every((s) => s === 0)).toBe(true);
    expect(Array.from(shapeIds.slice(8)).every((s) => s === 1)).toBe(true);
  });

  it('fans each ring from its own centroid', () => {
    const { positions, count } = ringsToFan(COORDS, new Uint32Array([0, 4]));
    expect(count).toBe(12); // 4 triangles × 3
    // The square's centroid is (1, 1) and leads every triangle.
    for (let t = 0; t < 4; t++) {
      expect(Array.from(positions.slice(t * 6, t * 6 + 2))).toEqual([1, 1]);
    }
    // First triangle: centroid, v0, v1.
    expect(Array.from(positions.slice(0, 6))).toEqual([1, 1, 0, 0, 2, 0]);
  });

  it('skips rings too short to draw rather than emitting degenerate geometry', () => {
    // A 1-vertex "ring" has no edge; a 2-vertex one has no area.
    const coords = new Float32Array([0, 0, 5, 5, 1, 1]);
    expect(shapeVertexCount(new Uint32Array([0, 1]), 'outline')).toBe(0);
    expect(ringsToOutline(coords, new Uint32Array([0, 1])).count).toBe(0);
    expect(ringsToFan(coords, new Uint32Array([0, 2])).count).toBe(0);
    // …and a skipped ring must not shift the shape ids of the ones that follow.
    const mixed = ringsToOutline(coords, new Uint32Array([0, 1, 3]));
    expect(mixed.count).toBe(4);
    expect(Array.from(mixed.shapeIds)).toEqual([1, 1, 1, 1]);
  });

  it('expands an empty set to nothing', () => {
    const empty = ringsToOutline(new Float32Array(0), new Uint32Array([0]));
    expect(empty.count).toBe(0);
    expect(empty.positions.length).toBe(0);
  });
});

describe('ShapesLayer', () => {
  it('reports kind, shape count and the current vertex count', () => {
    const s = new ShapesLayer(COORDS, OFFSETS);
    expect(s.kind).toBe('shapes');
    expect(s.shapeCount).toBe(2);
    expect(s.draw).toBe('outline');
    expect(s.vertexCount()).toBe(14);
  });

  it('validates coords, offsets and the values length', () => {
    expect(() => new ShapesLayer(new Float32Array(3), OFFSETS)).toThrow(/multiple of 2/);
    expect(() => new ShapesLayer(COORDS, new Uint32Array([]))).toThrow(/at least one entry/);
    // Offsets that run past the coordinates would read uninitialised memory.
    expect(() => new ShapesLayer(COORDS, new Uint32Array([0, 99]))).toThrow(/coords hold only/);
    expect(() => new ShapesLayer(COORDS, OFFSETS, { values: new Float32Array(5) })).toThrow(
      /one per shape/,
    );
  });

  it('treats the draw mode as a geometry change', () => {
    const s = new ShapesLayer(COORDS, OFFSETS);
    let emitted = 0;
    s.changed.connect(() => emitted++);
    const before = s.dataVersion;

    s.draw = 'fill';
    expect(s.dataVersion).toBe(before + 1); // different topology and vertex count
    expect(s.vertexCount()).toBe(21);
    expect(emitted).toBe(1);

    s.draw = 'fill'; // unchanged — no rebuild, no event
    expect(s.dataVersion).toBe(before + 1);
    expect(emitted).toBe(1);
  });

  it('treats new values as a value change, not a geometry change', () => {
    const s = new ShapesLayer(COORDS, OFFSETS, { values: new Float32Array([1, 2]) });
    const data = s.dataVersion;
    const val = s.valueVersion;

    s.values = new Float32Array([7, 8]);
    // Recolouring must not re-expand 10^5–10^6 positions.
    expect(s.dataVersion).toBe(data);
    expect(s.valueVersion).toBe(val + 1);
    expect(() => {
      s.values = new Float32Array([1]);
    }).toThrow(/one per shape/);
  });

  it('defaults the contrast window to the values own range, widening a flat one', () => {
    expect(
      new ShapesLayer(COORDS, OFFSETS, { values: new Float32Array([3, 9]) }).contrastLimits,
    ).toEqual([3, 9]);
    // A single distinct value would otherwise divide by zero in the shader.
    expect(
      new ShapesLayer(COORDS, OFFSETS, { values: new Float32Array([4, 4]) }).contrastLimits,
    ).toEqual([4, 5]);
    // No values: the window is unused, but must still be finite.
    expect(new ShapesLayer(COORDS, OFFSETS).contrastLimits).toEqual([0, 1]);
  });

  it('gives every vertex its shape value, or the shape index without values', () => {
    const s = new ShapesLayer(COORDS, OFFSETS, { values: new Float32Array([5, 6]) });
    const { shapeIds } = s.buildGeometry();
    expect(Array.from(s.buildVertexValues(shapeIds).slice(0, 8)).every((v) => v === 5)).toBe(true);
    expect(Array.from(s.buildVertexValues(shapeIds).slice(8)).every((v) => v === 6)).toBe(true);

    const flat = new ShapesLayer(COORDS, OFFSETS);
    const ids = flat.buildGeometry().shapeIds;
    expect(Array.from(flat.buildVertexValues(ids).slice(8)).every((v) => v === 1)).toBe(true);
  });

  it('bumps colormapVersion and emits on a colormap change', () => {
    const s = new ShapesLayer(COORDS, OFFSETS, { values: new Float32Array([1, 2]) });
    let emitted = 0;
    s.changed.connect(() => emitted++);
    const before = s.colormapVersion;
    s.colormap = 'magma';
    expect(s.colormapVersion).toBe(before + 1);
    expect(s.colormap.name).toBe('magma');
    expect(emitted).toBe(1);
  });

  it('defaults to translucent white and honours the option overrides', () => {
    const s = new ShapesLayer(COORDS, OFFSETS);
    expect(s.color).toEqual([1, 1, 1, 1]);
    expect(s.opacity).toBe(1);
    const s2 = new ShapesLayer(COORDS, OFFSETS, {
      draw: 'fill',
      color: [1, 0, 0, 0.5],
      opacity: 0.25,
      blending: 'additive',
      visible: false,
      gamma: 2,
      scale: [2, 2],
      translate: [1, 1],
    });
    expect(s2.draw).toBe('fill');
    expect(s2.color).toEqual([1, 0, 0, 0.5]);
    expect(s2.opacity).toBe(0.25);
    expect(s2.blending).toBe('additive');
    expect(s2.visible).toBe(false);
    expect(s2.gamma).toBe(2);
    expect(s2.scale).toEqual([2, 2]);
    expect(s2.translate).toEqual([1, 1]);
  });

  it('computes data bounds, and none for an empty layer', () => {
    const b = new ShapesLayer(COORDS, OFFSETS).bounds();
    expect(b?.min).toEqual([0, 0]);
    expect(b?.max).toEqual([14, 14]);
    expect(new ShapesLayer(new Float32Array(0), new Uint32Array([0])).bounds()).toBeNull();
  });
});
