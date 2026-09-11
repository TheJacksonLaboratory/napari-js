import { describe, it, expect } from 'vitest';
import {
  Points3DLayer,
  POINTS3D_DATA_FLOATS,
  POINTS3D_STYLE_FLOATS,
} from '../src/layers/points3d-layer';

const POS = new Float32Array([0, 0, 0, 2, 0, 0, 2, 4, 6]);
const VALS = new Float32Array([10, 20, 30]);

describe('Points3DLayer', () => {
  it('validates position / value lengths', () => {
    expect(() => new Points3DLayer(new Float32Array(4))).toThrow(); // not ×3
    expect(() => new Points3DLayer(POS, new Float32Array(2))).toThrow(); // n≠3
    expect(() => new Points3DLayer(POS, VALS)).not.toThrow();
  });

  it('reports count / kind and defaults', () => {
    const p = new Points3DLayer(POS, VALS);
    expect(p.kind).toBe('points3d');
    expect(p.count).toBe(3);
    expect(p.size).toBe(6);
    expect(p.blending).toBe('translucent');
    // contrast defaults to the value range.
    expect(p.contrastLimits).toEqual([10, 30]);
  });

  it('defaults values to 0 (single LUT color) when omitted', () => {
    const p = new Points3DLayer(POS);
    expect(Array.from(p.values)).toEqual([0, 0, 0]);
  });

  it('honors option overrides', () => {
    const p = new Points3DLayer(POS, VALS, {
      size: 12,
      opacity: 0.5,
      contrastLimits: [0, 255],
      blending: 'additive',
    });
    expect(p.size).toBe(12);
    expect(p.opacity).toBe(0.5);
    expect(p.contrastLimits).toEqual([0, 255]);
    expect(p.blending).toBe('additive');
  });

  it('bumps colormapVersion and emits on colormap change', () => {
    const p = new Points3DLayer(POS, VALS);
    let n = 0;
    p.changed.connect(() => n++);
    const before = p.colormapVersion;
    p.colormap = 'magma';
    expect(p.colormapVersion).toBe(before + 1);
    expect(n).toBe(1);
  });

  it('computes bounds (min/max/center/radius)', () => {
    const p = new Points3DLayer(POS, VALS);
    const b = p.bounds();
    expect(b.min).toEqual([0, 0, 0]);
    expect(b.max).toEqual([2, 4, 6]);
    expect(b.center).toEqual([1, 2, 3]);
    expect(b.radius).toBeCloseTo(0.5 * Math.hypot(2, 4, 6), 5);
  });

  it('packs [x,y,z,value] into the static instance buffer', () => {
    const p = new Points3DLayer(POS, VALS);
    const data = p.buildInstanceData();
    expect(data.length).toBe(3 * POINTS3D_DATA_FLOATS);
    expect(Array.from(data.subarray(0, 4))).toEqual([0, 0, 0, 10]);
    expect(Array.from(data.subarray(8, 12))).toEqual([2, 4, 6, 30]);
  });

  it('packs [alpha,size] into a SEPARATE style buffer', () => {
    // Separate because they change on different clocks: a selection click touches only
    // these two floats, and interleaving would re-upload every position with them.
    const p = new Points3DLayer(POS, VALS);
    const style = p.buildStyleData();
    expect(style.length).toBe(3 * POINTS3D_STYLE_FLOATS);
    // Both default to 1, so an unstyled layer draws exactly as it did before they existed.
    expect(Array.from(style)).toEqual([1, 1, 1, 1, 1, 1]);
  });

  /**
   * Per-point alpha and size, which exist so a subset can be emphasised in ONE layer.
   *
   * The alternative a single layer-wide opacity forces — a second layer holding the
   * highlighted points — has to be kept in step through every colormap, window and size
   * change, and the two then depth-sort against each other as separate draws.
   */
  describe('per-point styling', () => {
    it('carries alphas and sizes into the style data', () => {
      const p = new Points3DLayer(POS, VALS, {
        alphas: new Float32Array([1, 0.25, 0.25]),
        // f32-exact values, so the assertion is about the packing and not about how 1.6
        // rounds on the way into a Float32Array.
        sizes: new Float32Array([1.5, 1, 1]),
      });
      expect(Array.from(p.buildStyleData())).toEqual([1, 1.5, 0.25, 1, 0.25, 1]);
      // ...and the static half is untouched by them.
      expect(Array.from(p.buildInstanceData().subarray(0, 4))).toEqual([0, 0, 0, 10]);
    });

    it('rejects a wrong-length array instead of padding it', () => {
      // A short alpha array would silently hide the tail of the cloud, which reads as
      // missing data rather than as a mistake in the caller.
      expect(() => new Points3DLayer(POS, VALS, { alphas: new Float32Array(2) })).toThrow(/alphas/);
      expect(() => new Points3DLayer(POS, VALS, { sizes: new Float32Array(4) })).toThrow(/sizes/);
      const p = new Points3DLayer(POS, VALS);
      expect(() => {
        p.alphas = new Float32Array(2);
      }).toThrow(/alphas/);
    });

    it('clears back to uniform styling with null', () => {
      const p = new Points3DLayer(POS, VALS, { alphas: new Float32Array([1, 0.2, 0.2]) });
      p.alphas = null;
      expect(p.alphas).toBeNull();
      expect(Array.from(p.buildStyleData())).toEqual([1, 1, 1, 1, 1, 1]);
    });
  });

  /**
   * `dataVersion`, so recolouring is a mutation rather than a new layer.
   *
   * Building a new layer to change what the points are coloured by also reframes the
   * camera, which turns a recolour into a camera jump the host then has to undo.
   */
  describe('dataVersion', () => {
    it('bumps and emits when the scalars are replaced', () => {
      const p = new Points3DLayer(POS, VALS);
      let emitted = 0;
      p.changed.connect(() => emitted++);
      const before = p.dataVersion;
      p.values = new Float32Array([1, 2, 3]);
      expect(p.dataVersion).toBe(before + 1);
      expect(emitted).toBe(1);
      expect(Array.from(p.buildInstanceData().subarray(3, 4))).toEqual([1]);
    });

    it('keeps a style change OFF the data counter, and vice versa', () => {
      // The whole point of two counters: a selection click must not make the visual
      // re-upload 59 MB of positions it did not touch.
      const p = new Points3DLayer(POS, VALS);
      const data = p.dataVersion;
      const style = p.styleVersion;

      p.alphas = new Float32Array([1, 1, 0.5]);
      p.sizes = new Float32Array([1, 1, 2]);
      expect(p.styleVersion).toBe(style + 2);
      expect(p.dataVersion).toBe(data);

      p.values = new Float32Array([1, 2, 3]);
      expect(p.dataVersion).toBe(data + 1);
      expect(p.styleVersion).toBe(style + 2);
    });

    it('does not bump for display-only changes, which need no re-upload', () => {
      // size/opacity/contrast/colormap live in the uniform block and the LUT, not the
      // instance buffer; bumping here would re-interleave millions of points per slider tick.
      const p = new Points3DLayer(POS, VALS);
      const before = p.dataVersion;
      p.size = 12;
      p.opacity = 0.5;
      p.contrastLimits = [0, 1];
      p.colormap = 'magma';
      expect(p.dataVersion).toBe(before);
      expect(p.styleVersion).toBe(0);
    });

    it('keeps the geometry, so the camera has nothing to reframe', () => {
      const p = new Points3DLayer(POS, VALS);
      const before = p.bounds();
      p.values = new Float32Array([100, 200, 300]);
      expect(p.bounds()).toEqual(before);
    });

    /**
     * A window that was DERIVED has to follow the values it came from.
     *
     * Otherwise replacing [10, 30] with [100, 300] keeps the old window and every point
     * clamps to the top of the LUT — a uniformly saturated cloud, which reads as a
     * colormap problem rather than a stale window.
     */
    describe('the contrast window when the values are replaced', () => {
      it('follows a window that was derived from the data', () => {
        const p = new Points3DLayer(POS, VALS);
        expect(p.contrastLimits).toEqual([10, 30]);
        p.values = new Float32Array([100, 200, 300]);
        expect(p.contrastLimits).toEqual([100, 300]);
      });

      it('leaves a window the caller pinned alone', () => {
        // Theirs to own: an explicit window is usually shared across layers or tied to a
        // legend, and silently retuning it would desynchronise both.
        const p = new Points3DLayer(POS, VALS, { contrastLimits: [0, 255] });
        p.values = new Float32Array([100, 200, 300]);
        expect(p.contrastLimits).toEqual([0, 255]);
      });

      it('stops following once the caller sets one', () => {
        const p = new Points3DLayer(POS, VALS);
        p.contrastLimits = [0, 50];
        p.values = new Float32Array([100, 200, 300]);
        expect(p.contrastLimits).toEqual([0, 50]);
      });

      it('matches ShapesLayer, which already worked this way', () => {
        // Two sibling layers disagreeing about the same rule is how a caller learns it the
        // hard way.
        const p = new Points3DLayer(POS, VALS);
        p.values = new Float32Array([5, 5, 5]);
        // Degenerate range still widens rather than dividing by zero.
        expect(p.contrastLimits[1]).toBeGreaterThan(p.contrastLimits[0]);
      });
    });

    it('rejects a wrong-length scalar array', () => {
      const p = new Points3DLayer(POS, VALS);
      expect(() => {
        p.values = new Float32Array(2);
      }).toThrow(/values/);
    });

    it('cannot be replaced without bumping the version', () => {
      // A plain writable field would let this assignment succeed while `dataVersion` stayed
      // put — the visual would never re-upload, and the GPU would keep the old colours
      // while `layer.values` reported the new ones. The accessor is what closes that.
      const p = new Points3DLayer(POS, VALS);
      const before = p.dataVersion;
      p.values = new Float32Array([7, 8, 9]);
      expect(p.dataVersion).toBe(before + 1);
      expect(p.buildInstanceData()[3]).toBe(7);
    });
  });
});
