import { describe, it, expect } from 'vitest';
import { HeadlessViewer } from '../src/testing';
import { framingFor } from '../src/scene/fit';

const vol = (w = 4, h = 2, d = 8) => new Uint8Array(w * h * d);

describe('addVolume framing', () => {
  it('frames on the volume bounds through framingFor, like the other 3D adders', () => {
    const v = new HeadlessViewer({ canvasRect: { width: 800, height: 600 } });
    const layer = v.addVolume(vol(), 4, 2, 8, { voxelSize: [1, 2, 0.5] });
    const want = framingFor(layer.bounds(), { fov: v.camera3d.fov, aspect: 800 / 600 });
    expect(v.camera3d.target).toEqual(want.target);
    expect(v.camera3d.distance).toBeCloseTo(want.distance, 9);
    expect(v.dims.ndisplay).toBe(3);
  });

  it('agrees with fitToLayers on a volume-only scene', () => {
    const v = new HeadlessViewer({ canvasRect: { width: 360, height: 640 } });
    v.addVolume(vol(), 4, 2, 8);
    const { distance } = v.camera3d;
    const target = v.camera3d.target;
    v.camera3d.distance = 1;
    expect(v.fitToLayers()).toBe(true);
    expect(v.camera3d.distance).toBeCloseTo(distance, 9);
    expect(v.camera3d.target).toEqual(target);
  });

  it('accounts for a portrait canvas, which the old max × 1.8 framing clipped', () => {
    const wide = new HeadlessViewer({ canvasRect: { width: 800, height: 400 } });
    const tall = new HeadlessViewer({ canvasRect: { width: 400, height: 800 } });
    wide.addVolume(vol(64, 64, 64), 64, 64, 64);
    tall.addVolume(vol(64, 64, 64), 64, 64, 64);
    expect(tall.camera3d.distance).toBeGreaterThan(wide.camera3d.distance);
    // A cube's half-diagonal fits the vertical field of view on the wide canvas.
    const radius = (64 * Math.sqrt(3)) / 2;
    expect(wide.camera3d.distance).toBeCloseTo(radius / Math.sin(wide.camera3d.fov / 2), 6);
    expect(wide.camera3d.distance).toBeGreaterThan(64 * 1.8);
  });

  it('still honours the fit policy', () => {
    const v = new HeadlessViewer({ canvasRect: { width: 800, height: 600 } });
    v.camera3d.distance = 123;
    v.addVolume(vol(), 4, 2, 8, { fit: 'never' });
    expect(v.camera3d.distance).toBe(123);
  });
});
