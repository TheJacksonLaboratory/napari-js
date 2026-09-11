import { describe, it, expect } from 'vitest';
import { unionBounds, resolveFit, framingFor, Fit3DState } from '../src/scene/fit';
import { Points3DLayer } from '../src/layers/points3d-layer';
import { VolumeLayer } from '../src/layers/volume-layer';
import { ImageLayer } from '../src/layers/image-layer';
import { ShapesLayer } from '../src/layers/shapes-layer';
import { Camera3D } from '../src/camera/camera3d';
import { projectPoint } from '../src/picking/project';
import type { SurfaceBounds } from '../src/layers/surface-layer';

/**
 * When adding a 3D layer moves the camera.
 *
 * The behaviour this replaces: every 3D add reframed, unconditionally. A host building a
 * scene from more than one layer — or rebuilding one layer to recolour it — then had to
 * save the camera's five fields around each add and put them back, because there was no way
 * to say "leave the camera alone". That workaround is what these options remove.
 */

const CLOUD = new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 30]);

/** A 2D layer, i.e. one with no 3D extent to contribute. */
const flat2d = () =>
  new ImageLayer({
    kind: 'typed',
    width: 2,
    height: 2,
    channels: 1,
    dtype: 'uint8',
    data: new Uint8Array(4),
  });

describe('resolveFit', () => {
  it('always frames under the default policy', () => {
    expect(resolveFit('always', undefined, false)).toBe(true);
    expect(resolveFit('always', undefined, true)).toBe(true);
  });

  it('frames the first add only under `once`', () => {
    expect(resolveFit('once', undefined, false)).toBe(true);
    expect(resolveFit('once', undefined, true)).toBe(false);
  });

  it('never frames under `never`, fitted or not', () => {
    expect(resolveFit('never', undefined, false)).toBe(false);
    expect(resolveFit('never', undefined, true)).toBe(false);
  });

  it('lets a per-add override beat the viewer default, in both directions', () => {
    expect(resolveFit('never', 'always', true)).toBe(true);
    expect(resolveFit('always', 'never', false)).toBe(false);
    expect(resolveFit('always', 'once', true)).toBe(false);
  });
});

describe('unionBounds', () => {
  it('returns null for a scene with nothing bounded in it', () => {
    // Safe to call while a scene is still loading, rather than framing on nothing.
    expect(unionBounds([])).toBeNull();
    expect(unionBounds([flat2d()])).toBeNull();
  });

  it('matches a single layer exactly', () => {
    const points = new Points3DLayer(CLOUD);
    expect(unionBounds([points])).toEqual(points.bounds());
  });

  it('covers every layer, not just the last one added', () => {
    // The case this exists for: a cloud sitting inside a reference volume is ONE scene, and
    // framing on whichever was added last shows a part of it.
    const points = new Points3DLayer(CLOUD);
    const volume = new VolumeLayer(new Uint8Array(8), 2, 2, 2);
    const u = unionBounds([points, volume])!;
    expect(u.min).toEqual([-1, -1, -1]); // the volume box is centred on the origin
    expect(u.max).toEqual([10, 20, 30]); // the cloud's far corner
    expect(unionBounds([volume, points])).toEqual(u); // order cannot matter
  });

  it('skips layers that have no extent, without dropping the ones that do', () => {
    const points = new Points3DLayer(CLOUD);
    expect(unionBounds([flat2d(), points, flat2d()])).toEqual(points.bounds());
  });

  /**
   * `bounds()` is not one contract across the layer tree.
   *
   * ShapesLayer has one too and it is 2D — and nullable. A guard that only checked for the
   * METHOD accepted it: an empty ShapesLayer threw on `b.min[0]`, and a non-empty one
   * contributed an `undefined` z that reached the camera as a NaN target.
   */
  describe('a layer whose bounds() is 2D', () => {
    const triangle = () =>
      new ShapesLayer(new Float32Array([0, 0, 1, 0, 1, 1]), new Uint32Array([0, 3]));

    it('does not get a say in how a 3D scene is framed', () => {
      const points = new Points3DLayer(CLOUD);
      expect(unionBounds([triangle(), points])).toEqual(points.bounds());
      expect(unionBounds([points, triangle()])).toEqual(points.bounds());
    });

    it('does not NaN the camera target when it comes first', () => {
      // Order mattered: leading, it SEEDED the union, so `min[2]`/`max[2]` were undefined
      // and the centre came out NaN. Trailing, its undefined z lost every comparison and
      // the bug hid.
      const u = unionBounds([triangle(), new Points3DLayer(CLOUD)])!;
      expect(u.center.every(Number.isFinite)).toBe(true);
      expect(u.min.every(Number.isFinite)).toBe(true);
    });

    it('does not throw when it is empty and returns null', () => {
      const empty = new ShapesLayer(new Float32Array([]), new Uint32Array([0]));
      expect(empty.bounds()).toBeNull();
      expect(() => unionBounds([empty])).not.toThrow();
      expect(unionBounds([empty])).toBeNull();
    });
  });

  it('gives a degenerate scene a usable radius', () => {
    // One point, or a perfectly flat sheet: a zero radius puts the camera at distance zero
    // and renders nothing.
    const single = new Points3DLayer(new Float32Array([5, 5, 5]));
    const u = unionBounds([single])!;
    expect(u.radius).toBeGreaterThan(0);
    expect(u.center).toEqual([5, 5, 5]);
  });
});

describe('framingFor', () => {
  it('targets the centre and backs off far enough for the vertical angle', () => {
    // r / sin(fov/2) at the 45 degree default, not a fixed multiple of the radius.
    const f = framingFor({ min: [0, 0, 0], max: [2, 2, 2], center: [1, 1, 1], radius: 4 });
    expect(f.target).toEqual([1, 1, 1]);
    expect(f.distance).toBeCloseTo(4 / Math.sin(Math.PI / 8), 6);
  });

  it('never returns a zero distance', () => {
    const f = framingFor({ min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 0 });
    expect(f.distance).toBeGreaterThan(0);
  });

  it('backs off further for a narrower viewport, not the same amount', () => {
    const b: SurfaceBounds = { min: [0, 0, 0], max: [2, 2, 2], center: [1, 1, 1], radius: 4 };
    const landscape = framingFor(b, { aspect: 800 / 600 }).distance;
    const portrait = framingFor(b, { aspect: 400 / 800 }).distance;
    const sliver = framingFor(b, { aspect: 200 / 1000 }).distance;
    expect(portrait).toBeGreaterThan(landscape);
    expect(sliver).toBeGreaterThan(portrait);
  });

  it('backs off further for a wider field of view', () => {
    const b: SurfaceBounds = { min: [0, 0, 0], max: [2, 2, 2], center: [1, 1, 1], radius: 4 };
    const narrow = framingFor(b, { fov: (30 * Math.PI) / 180 }).distance;
    const wide = framingFor(b, { fov: (90 * Math.PI) / 180 }).distance;
    expect(narrow).toBeGreaterThan(wide);
  });

  it('ignores a nonsensical fov or aspect rather than producing NaN', () => {
    const b: SurfaceBounds = { min: [0, 0, 0], max: [2, 2, 2], center: [1, 1, 1], radius: 4 };
    for (const view of [{ fov: 0 }, { fov: -1 }, { aspect: 0 }, { aspect: -2 }, {}]) {
      expect(Number.isFinite(framingFor(b, view).distance)).toBe(true);
    }
  });

  /**
   * The property that actually matters: every corner of the box lands on screen.
   *
   * A fixed `radius * 2.5` passed at 800x600 and failed in portrait — the corners of a
   * 1000x100x100 scene projected to |NDC| 2.0 at 400x800 and 5.1 at 200x1000.
   */
  describe('keeps the whole box on screen', () => {
    /** Worst |NDC| over all eight corners under a camera framed by `framingFor`. */
    function worstCorner(b: SurfaceBounds, vw: number, vh: number): number {
      const { target, distance } = framingFor(b, { aspect: vw / vh });
      const cam = new Camera3D();
      cam.target = target;
      cam.distance = distance;
      const mvp = cam.viewProjection(vw, vh);
      let worst = 0;
      for (const x of [b.min[0], b.max[0]]) {
        for (const y of [b.min[1], b.max[1]]) {
          for (const z of [b.min[2], b.max[2]]) {
            const p = projectPoint(mvp, [x, y, z], vw, vh);
            if (!p.visible) return Infinity;
            worst = Math.max(worst, Math.abs(p.x / vw - 0.5) * 2, Math.abs(p.y / vh - 0.5) * 2);
          }
        }
      }
      return worst;
    }

    const elongated = new Points3DLayer(new Float32Array([-500, -50, -50, 500, 50, 50])).bounds();
    const cube = new Points3DLayer(new Float32Array([-50, -50, -50, 50, 50, 50])).bounds();

    for (const [vw, vh] of [
      [800, 600],
      [400, 800],
      [200, 1000],
      [1600, 400],
      [1000, 1000],
    ] as const) {
      it(`${vw}x${vh}`, () => {
        expect(worstCorner(elongated, vw, vh)).toBeLessThanOrEqual(1);
        expect(worstCorner(cube, vw, vh)).toBeLessThanOrEqual(1);
      });
    }
  });
});

/**
 * The framing state machine, which is where the glue bug lived.
 *
 * `resolveFit` was already right; what was wrong was that an explicit `fitToLayers()`
 * moved the camera without recording that the scene had been framed.
 */
describe('Fit3DState', () => {
  it('frames the first add and no later one, under `once`', () => {
    const state = new Fit3DState('once');
    expect(state.claim()).toBe(true);
    expect(state.claim()).toBe(false);
    expect(state.claim()).toBe(false);
  });

  it('frames every add under `always`', () => {
    const state = new Fit3DState('always');
    expect(state.claim()).toBe(true);
    expect(state.claim()).toBe(true);
  });

  it('lets the next add frame again after a reset', () => {
    const state = new Fit3DState('once');
    state.claim();
    state.reset();
    expect(state.claim()).toBe(true);
  });

  it('counts an explicit fit, so the next add does not undo it', () => {
    // The bug: fit the union, add one more layer, and that layer reframed on ITSELF —
    // silently discarding the union the host had just asked for.
    const state = new Fit3DState('once');
    state.markFitted();
    expect(state.claim()).toBe(false);
  });

  it('still lets an add frame when nothing has been fitted yet', () => {
    const state = new Fit3DState('once');
    expect(state.claim()).toBe(true);
  });

  it('does not let a `never` add consume the one framing `once` owes', () => {
    // A host that mounts a hidden layer first would otherwise find its scene never framed.
    const state = new Fit3DState('once');
    expect(state.claim('never')).toBe(false);
    expect(state.claim()).toBe(true);
  });
});
