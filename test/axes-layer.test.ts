import { describe, it, expect } from 'vitest';
import { AxesLayer, axesLineVertices } from '../src/layers/axes-layer';

const FLOATS_PER_VERTEX = 6; // x,y,z, r,g,b
const VERTS_PER_SEGMENT = 2;
const segmentCount = (verts: Float32Array): number =>
  verts.length / FLOATS_PER_VERTEX / VERTS_PER_SEGMENT;

describe('AxesLayer', () => {
  it('defaults: bounding box + 5 ticks + RGB axes', () => {
    const layer = new AxesLayer(10, 20, 30);
    expect(layer.kind).toBe('axes');
    expect(layer.boundingBox).toBe(true);
    expect(layer.tickCount).toBe(5);
    expect(layer.colors.x).toEqual([0.93, 0.27, 0.27]);
    // 12 box edges + 3 axes + 3×5 ticks = 30 segments.
    expect(segmentCount(axesLineVertices(layer))).toBe(30);
  });

  it('omits the box and ticks when disabled', () => {
    const layer = new AxesLayer(4, 4, 4, { boundingBox: false, tickCount: 0 });
    // Just the 3 coloured axes.
    expect(segmentCount(axesLineVertices(layer))).toBe(3);
  });

  it('places axes from the centred box min corner with per-axis colour', () => {
    const layer = new AxesLayer(2, 2, 2, { boundingBox: false, tickCount: 0 });
    const v = axesLineVertices(layer);
    // First segment = X axis: (-1,-1,-1) → (1,-1,-1), colour red.
    expect([v[0], v[1], v[2]]).toEqual([-1, -1, -1]);
    expect(v[3]).toBeCloseTo(0.93, 5); // red (float32 stored)
    expect(v[4]).toBeCloseTo(0.27, 5);
    expect([v[6], v[7], v[8]]).toEqual([1, -1, -1]);
  });

  it('exposes physical extent from voxel size', () => {
    const layer = new AxesLayer(10, 20, 5, { voxelSize: [0.5, 0.5, 2] });
    expect(layer.physicalExtent).toEqual([5, 10, 10]);
  });

  it('bumps geometryVersion + emits on geometry-affecting changes', () => {
    const layer = new AxesLayer(8, 8, 8);
    let emits = 0;
    layer.changed.connect(() => emits++);
    const v0 = layer.geometryVersion;
    layer.tickCount = 3;
    layer.boundingBox = false;
    layer.voxelSize = [2, 2, 2];
    expect(layer.geometryVersion).toBe(v0 + 3);
    expect(emits).toBe(3);
    expect(layer.tickCount).toBe(3);
    expect(segmentCount(axesLineVertices(layer))).toBe(3 + 3 * 3); // axes + ticks, no box
  });

  it('restretches the box live when a dimension changes (Z-height gizmo)', () => {
    const layer = new AxesLayer(8, 8, 8, {
      boundingBox: false,
      tickCount: 0,
      voxelSize: [1, 1, 1],
    });
    let emits = 0;
    layer.changed.connect(() => emits++);
    const v0 = layer.geometryVersion;
    layer.depth = 24; // stretch Z ×3
    expect(layer.depth).toBe(24);
    expect(layer.geometryVersion).toBe(v0 + 1);
    expect(emits).toBe(1);
    // The Z axis segment now spans the taller box: from -d/2 to +d/2 = 24.
    expect(layer.physicalExtent).toEqual([8, 8, 24]);
  });
});
