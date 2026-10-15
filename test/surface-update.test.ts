import { describe, it, expect, beforeAll } from 'vitest';
import { SurfaceLayer } from '../src/layers/surface-layer';
import { SurfaceVisual } from '../src/visuals/surface-visual';

const TRI = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const ONE = new Uint32Array([0, 1, 2]);
const QUAD = new Float32Array([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0]);
const TWO = new Uint32Array([0, 1, 2, 0, 2, 3]);

/** A device that records buffers and writes: enough for the visual's upload bookkeeping. */
function recordingDevice() {
  const buffers: Array<{ size: number; destroyed: boolean; destroy(): void }> = [];
  const writes: Array<{ buffer: unknown; bytes: number }> = [];
  const device = {
    createShaderModule: () => ({}),
    createBuffer: ({ size }: { size: number }) => {
      const b = {
        size,
        destroyed: false,
        destroy() {
          b.destroyed = true;
        },
      };
      buffers.push(b);
      return b;
    },
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    queue: {
      writeBuffer: (buffer: unknown, _offset: number, data: ArrayBufferView) =>
        writes.push({ buffer, bytes: data.byteLength }),
      writeTexture: () => {},
    },
  };
  return { device, buffers, writes };
}

beforeAll(() => {
  // WebGPU's flag namespaces, absent under node.
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8 };
  g.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
});

describe('SurfaceLayer.setData', () => {
  it('replaces the mesh in place, bumping dataVersion and emitting once', () => {
    const s = new SurfaceLayer(TRI, ONE, undefined, { contrastLimits: [0, 9] });
    const id = s.id;
    let emits = 0;
    s.changed.connect(() => emits++);
    s.setData(QUAD, TWO, new Float32Array([1, 2, 3, 4]));
    expect(s.id).toBe(id);
    expect(s.vertexCount).toBe(4);
    expect(s.indexCount).toBe(6);
    expect(Array.from(s.values)).toEqual([1, 2, 3, 4]);
    expect(s.dataVersion).toBe(1);
    expect(emits).toBe(1);
    expect(s.contrastLimits).toEqual([0, 9]); // kept
    expect(s.bounds().max).toEqual([2, 2, 0]);
  });

  it('changes nothing on invalid data', () => {
    const s = new SurfaceLayer(TRI, ONE);
    expect(() => s.setData(QUAD, TWO, new Float32Array(3))).toThrow();
    expect(() => s.setData(new Float32Array(4), ONE)).toThrow();
    expect(s.vertexCount).toBe(3);
    expect(s.dataVersion).toBe(0);
  });

  it('re-uploads on the next sync, growing a buffer only when the data outgrows it', () => {
    const { device, buffers, writes } = recordingDevice();
    const s = new SurfaceLayer(QUAD, TWO);
    const visual = new SurfaceVisual(device as never, 'bgra8unorm', s);
    const created = buffers.length;
    writes.length = 0;
    visual.sync();
    expect(writes).toHaveLength(0); // nothing changed

    s.setData(TRI, ONE); // smaller: written into the same buffers
    visual.sync();
    expect(buffers.length).toBe(created);
    expect(writes.map((w) => w.bytes)).toEqual([3 * 16, 3 * 4, 6 * 4]);

    const big = new Float32Array(3 * 100);
    const faces = new Uint32Array(3 * 50).map((_, i) => i % 100);
    s.setData(big, faces); // larger: new buffers, the old ones destroyed
    visual.sync();
    expect(buffers.length).toBe(created + 3);
    expect(buffers.filter((b) => b.destroyed)).toHaveLength(3);
    visual.dispose();
    expect(buffers.filter((b) => b.destroyed).length).toBeGreaterThanOrEqual(6);
  });
});
