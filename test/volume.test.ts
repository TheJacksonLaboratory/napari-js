import { describe, it, expect } from 'vitest';
import { Camera3D } from '../src/camera/camera3d';
import { VolumeLayer } from '../src/layers/volume-layer';

describe('Camera3D', () => {
  it('places the eye along +z at azimuth/elevation 0', () => {
    const c = new Camera3D();
    c.azimuth = 0;
    c.elevation = 0;
    c.distance = 10;
    const [x, y, z] = c.eye();
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(10, 5);
  });

  it('clamps elevation away from the poles', () => {
    const c = new Camera3D();
    c.elevation = 0;
    c.orbit(0, 100); // huge upward tilt
    expect(c.elevation).toBeLessThan(Math.PI / 2);
    expect(c.elevation).toBeGreaterThan(0);
  });

  it('emits changed on orbit/zoom and frames a volume', () => {
    const c = new Camera3D();
    let n = 0;
    c.changed.connect(() => n++);
    c.orbit(0.1, 0.1);
    c.zoomBy(1.2);
    expect(n).toBe(2);
    c.frame(2, 4, 8);
    expect(c.distance).toBeCloseTo(8 * 1.8, 5);
    expect(c.target).toEqual([0, 0, 0]);
  });

  it('keeps distance strictly positive', () => {
    const c = new Camera3D();
    c.distance = -2;
    expect(c.distance).toBeGreaterThan(0);
  });

  it('defaults dragMode to rotate and lets it be switched', () => {
    const c = new Camera3D();
    expect(c.dragMode).toBe('rotate');
    c.dragMode = 'pan';
    expect(c.dragMode).toBe('pan');
  });

  it('pan moves the target in the view plane and emits changed', () => {
    const c = new Camera3D();
    c.azimuth = 0;
    c.elevation = 0;
    c.distance = 10; // eye on +z, looking -z
    let n = 0;
    c.changed.connect(() => n++);
    const before = c.target;
    c.pan(100, 0, 600); // horizontal drag → target shifts along x
    const after = c.target;
    expect(after[0]).not.toBeCloseTo(before[0], 3);
    expect(n).toBe(1);
  });
});

describe('VolumeLayer', () => {
  it('validates data size', () => {
    expect(() => new VolumeLayer(new Uint8Array(7), 2, 2, 2)).toThrow();
    expect(() => new VolumeLayer(new Uint8Array(8), 2, 2, 2)).not.toThrow();
  });

  it('maps rendering modes to codes', () => {
    const v = new VolumeLayer(new Uint8Array(8), 2, 2, 2, { rendering: 'mip' });
    expect(v.renderingCode()).toBe(0);
    v.rendering = 'translucent';
    expect(v.renderingCode()).toBe(1);
    v.rendering = 'iso';
    expect(v.renderingCode()).toBe(2);
  });

  it('bumps colormapVersion and emits on colormap change', () => {
    const v = new VolumeLayer(new Uint8Array(8), 2, 2, 2);
    let n = 0;
    v.changed.connect(() => n++);
    const before = v.colormapVersion;
    v.colormap = 'gray';
    expect(v.colormapVersion).toBe(before + 1);
    expect(n).toBe(1);
  });

  it('defaults voxelSize to [1,1,1] and copies a provided value', () => {
    expect(new VolumeLayer(new Uint8Array(8), 2, 2, 2).voxelSize).toEqual([1, 1, 1]);
    const v = new VolumeLayer(new Uint8Array(8), 2, 2, 2, { voxelSize: [0.25, 0.25, 4] });
    expect(v.voxelSize).toEqual([0.25, 0.25, 4]);
    // Anisotropic voxelSize scales the box: a downsampled-XY / full-Z stack keeps its proportions
    // regardless of the sampled voxel counts (16*0.25 : 8*0.25 : 4*4 = 4 : 2 : 16).
    const w = new VolumeLayer(new Uint8Array(16 * 8 * 4), 16, 8, 4, { voxelSize: [0.25, 0.25, 4] });
    const box = [w.width * w.voxelSize[0], w.height * w.voxelSize[1], w.depth * w.voxelSize[2]];
    expect(box).toEqual([4, 2, 16]);
  });
});
