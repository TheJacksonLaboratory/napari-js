import { describe, it, expect } from 'vitest';
import { unionBounds, resolveFit, framingFor } from '../src/scene/fit';
import { Points3DLayer } from '../src/layers/points3d-layer';
import { VolumeLayer } from '../src/layers/volume-layer';
import { ImageLayer } from '../src/layers/image-layer';

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
  it('targets the centre and backs off by the radius', () => {
    const f = framingFor({ min: [0, 0, 0], max: [2, 2, 2], center: [1, 1, 1], radius: 4 });
    expect(f.target).toEqual([1, 1, 1]);
    expect(f.distance).toBe(10);
  });

  it('never returns a zero distance', () => {
    const f = framingFor({ min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], radius: 0 });
    expect(f.distance).toBeGreaterThan(0);
  });
});
