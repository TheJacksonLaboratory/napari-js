import { describe, expect, it, vi } from 'vitest';

import { SurfaceLayer } from '../src/layers/surface-layer';
import { packSurfaceUniforms, SURFACE_UNIFORM_FLOATS } from '../src/visuals/surface-visual';
import { SURFACE_SHADER } from '../src/visuals/surface-shader';
import { Camera3D } from '../src/camera/camera3d';

/** One triangle in the z = 1 plane, spanning x 0..2, y 0..2. */
function triangle(opts = {}) {
  return new SurfaceLayer(
    Float32Array.of(0, 0, 1, 2, 0, 1, 0, 2, 1),
    Uint32Array.of(0, 1, 2),
    undefined,
    opts,
  );
}

describe('SurfaceLayer scale3d', () => {
  it('is the identity by default, takes an option, and rejects a factor that is not finite and positive', () => {
    expect(triangle().scale3d).toEqual([1, 1, 1]);
    expect(triangle({ scale3d: [1, 1, 3] }).scale3d).toEqual([1, 1, 3]);
    expect(() => triangle({ scale3d: [1, 0, 1] })).toThrow(/Surface scale3d/);
    expect(() => (triangle().scale3d = [1, 1, NaN])).toThrow(/Surface scale3d/);
  });

  it('changes the drawn geometry without touching the vertices: a uniform, not an upload', () => {
    const s = triangle();
    const vertices = s.vertices;
    const data = s.dataVersion;
    let emits = 0;
    s.changed.connect(() => emits++);
    s.scale3d = [1, 1, 4];
    expect(emits).toBe(1);
    expect(s.dataVersion).toBe(data);
    expect(s.transformVersion).toBe(1);
    expect(s.vertices).toBe(vertices);
    // Setting the same scale again is no change.
    s.scale3d = [1, 1, 4];
    expect(s.transformVersion).toBe(1);
  });

  it('bounds the surface as drawn, and re-bounds it when the scale changes', () => {
    const s = triangle();
    expect(s.bounds().max[2]).toBe(1);
    s.scale3d = [2, 1, 5];
    const b = s.bounds();
    expect(b.min).toEqual([0, 0, 5]);
    expect(b.max).toEqual([4, 2, 5]);
  });

  it('is picked where it is drawn: the hit point scaled, the distance along the ray kept', () => {
    const s = triangle({ scale3d: [1, 1, 5] });
    // Down the z axis from z = 10 through (0.5, 0.5): the drawn plane is at z = 5, not 1.
    const hit = s.pick({ origin: [0.5, 0.5, 10], dir: [0, 0, -1] });
    expect(hit).not.toBeNull();
    expect(hit!.distance).toBeCloseTo(5, 6);
    expect(hit!.point[2]).toBeCloseTo(5, 6);
    // Where only the unscaled triangle would be, there is nothing.
    expect(s.pick({ origin: [0.5, 0.5, 10], dir: [0, 0, -1], length: 4 })).toBeNull();
  });

  it('packs the scale for the shader, which scales each vertex and clips in its own frame', () => {
    const s = triangle({ scale3d: [1, 2, 3] });
    const out = new Float32Array(SURFACE_UNIFORM_FLOATS);
    packSurfaceUniforms(out, s, new Camera3D(), 100, 100);
    expect(Array.from(out.subarray(32, 36))).toEqual([1, 2, 3, 0]);
    expect(SURFACE_SHADER).toContain('let world = pos * u.scale.xyz;');
    expect(SURFACE_SHADER).toContain('clippedAway(in.vertexPos)');
  });
});

describe('SurfaceLayer scale3d picking and bounds', () => {
  it('picks a scaled mesh as the same mesh with the scale baked in, small source coordinates included', () => {
    // 0.0001 units wide, scaled by 1e6: about 100 world units wide at z = 100.
    const tiny = Float32Array.of(0, 0, 0.0001, 0.0001, 0, 0.0001, 0, 0.0001, 0.0001);
    const scaled = new SurfaceLayer(tiny, Uint32Array.of(0, 1, 2), undefined, {
      scale3d: [1e6, 1e6, 1e6],
    });
    const baked = new SurfaceLayer(
      tiny.map((v) => v * 1e6),
      Uint32Array.of(0, 1, 2),
    );
    const ray = {
      origin: [25, 25, 200] as [number, number, number],
      dir: [0, 0, -1] as [number, number, number],
    };
    const want = baked.pick(ray)!;
    const got = scaled.pick(ray)!;
    expect(want).not.toBeNull();
    expect(got).not.toBeNull();
    expect(got.distance).toBeCloseTo(want.distance, 3);
    got.point.forEach((v, a) => expect(v).toBeCloseTo(want.point[a], 3));
    // A finite ray stops at its own length in world units, as for the baked mesh.
    expect(scaled.pick({ ...ray, length: 99 })).toBeNull();
    expect(scaled.pick({ ...ray, length: 101 })).not.toBeNull();
  });

  it('picks along an oblique ray under a non-uniform scale at the world distance', () => {
    const s = new SurfaceLayer(
      Float32Array.of(-1, -1, 1, 1, -1, 1, 0, 1, 1),
      Uint32Array.of(0, 1, 2),
      undefined,
      { scale3d: [3, 1, 10] },
    );
    const d = Math.SQRT1_2;
    // From (0, 0, 20) down and along x at 45°: the drawn plane z = 10 is met 10·√2 along the ray.
    const hit = s.pick({ origin: [-10, 0, 20], dir: [d, 0, -d] })!;
    expect(hit.distance).toBeCloseTo(10 * Math.SQRT2, 5);
    expect(hit.point[0]).toBeCloseTo(0, 5);
    expect(hit.point[2]).toBeCloseTo(10, 5);
  });

  it('re-bounds a scale change from the cached extent, walking the mesh only when it changes', () => {
    const s = new SurfaceLayer(Float32Array.of(0, 0, 1, 2, 0, 1, 0, 2, 3), Uint32Array.of(0, 1, 2));
    const walk = vi.spyOn(s as unknown as { computeExtent(): unknown }, 'computeExtent');
    for (let k = 1; k <= 20; k++) {
      s.scale3d = [1, 1, k];
      expect(s.bounds().max[2]).toBeCloseTo(3 * k, 9);
    }
    expect(walk).toHaveBeenCalledTimes(1);
    const b = s.bounds();
    expect(b.center).toEqual([1, 1, 2 * 20]);
    expect(b.radius).toBeCloseTo(0.5 * Math.hypot(2, 2, 2 * 20), 9);
    s.setData(Float32Array.of(0, 0, 0, 4, 0, 0, 0, 4, 0), Uint32Array.of(0, 1, 2));
    expect(s.bounds().max[0]).toBe(4);
    expect(walk).toHaveBeenCalledTimes(2);
  });
});
