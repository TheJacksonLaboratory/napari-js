import { describe, it, expect, beforeAll } from 'vitest';
import { SurfaceLayer } from '../src/layers/surface-layer';
import {
  SurfaceVisual,
  packSurfaceUniforms,
  SURFACE_UNIFORM_FLOATS,
} from '../src/visuals/surface-visual';
import { SURFACE_SHADER } from '../src/visuals/surface-shader';
import { Camera3D } from '../src/camera/camera3d';
import { mapScalar } from '../src/color/display-pipeline';
import { resolveColormap } from '../src/color/colormap';
import { uniformStructFloats } from './wgsl-struct';

const VERTS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
const FACES = new Uint32Array([0, 1, 2]);
const VALUES = new Float32Array([0, 5, 10]);

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.GPUBufferUsage ??= { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8 };
  g.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
});

describe('SurfaceLayer colour', () => {
  it('colours by values and the colormap by default, as mapScalar does', () => {
    const s = new SurfaceLayer(VERTS, FACES, VALUES, {
      colormap: 'magma',
      gamma: 0.5,
      invert: true,
    });
    expect(s.colorMode).toBe('colormap');
    expect(s.color).toBeNull();
    const [r, g, b] = mapScalar(5, {
      climLo: 0,
      climHi: 10,
      gamma: 0.5,
      invert: true,
      colormap: resolveColormap('magma'),
    });
    expect(s.colorAt(1)).toEqual([r, g, b, 1]);
  });

  it('takes one colour (CSS or RGBA), which recolours live and can be cleared', () => {
    const s = new SurfaceLayer(VERTS, FACES, undefined, { color: '#ff000080' });
    expect(s.colorMode).toBe('color');
    expect(s.color?.[0]).toBe(1);
    expect(s.color?.[3]).toBeCloseTo(128 / 255, 6);
    let emits = 0;
    s.changed.connect(() => emits++);
    const version = s.colorVersion;
    s.color = [0, 1, 0, 1];
    expect(s.colorAt(2)).toEqual([0, 1, 0, 1]);
    expect(s.colorVersion).toBe(version); // a uniform: nothing to re-upload
    s.color = null;
    expect(s.colorMode).toBe('colormap');
    expect(emits).toBe(2);
    expect(() => (s.color = 'not-a-colour')).toThrow();
  });

  it('takes a colour per vertex, which wins over the colour; setData drops colours that no longer fit', () => {
    const vc = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5]);
    const s = new SurfaceLayer(VERTS, FACES, undefined, { color: 'white', vertexColors: vc });
    expect(s.colorMode).toBe('vertex');
    expect(s.colorAt(2)).toEqual([0, 0, 1, 0.5]);
    expect(() => (s.vertexColors = new Float32Array(8))).toThrow();
    s.setData(VERTS, FACES); // same vertex count: kept
    expect(s.vertexColors).toBe(vc);
    s.setData(new Float32Array(12), new Uint32Array([0, 1, 2, 0, 2, 3]));
    expect(s.vertexColors).toBeNull();
    expect(s.colorMode).toBe('color');
  });

  it('packs the colour mode and colour into the uniforms the shader declares', () => {
    expect(uniformStructFloats(SURFACE_SHADER)).toBe(SURFACE_UNIFORM_FLOATS);
    const out = new Float32Array(SURFACE_UNIFORM_FLOATS);
    const cam = new Camera3D();
    const s = new SurfaceLayer(VERTS, FACES, undefined, { color: [0.2, 0.4, 0.6, 0.8] });
    packSurfaceUniforms(out, s, cam, 100, 100);
    expect(out[26]).toBe(1);
    expect(Array.from(out.subarray(28, 32))).toEqual([0.2, 0.4, 0.6, 0.8].map(Math.fround));
    s.vertexColors = new Float32Array(12);
    packSurfaceUniforms(out, s, cam, 100, 100);
    expect(out[26]).toBe(2);
    s.vertexColors = null;
    s.color = null;
    packSurfaceUniforms(out, s, cam, 100, 100);
    expect(out[26]).toBe(0);
  });

  it('reads per-vertex colours with a stride, or one dummy colour with stride 0', () => {
    const strides: number[] = [];
    let colorWrites = 0;
    const device = {
      createShaderModule: () => ({}),
      createBuffer: ({ size }: { size: number }) => ({ size, destroy() {} }),
      createTexture: () => ({ createView: () => ({}), destroy() {} }),
      createSampler: () => ({}),
      createRenderPipeline: (d: { vertex: { buffers: Array<{ arrayStride: number }> } }) => {
        strides.push(d.vertex.buffers[1].arrayStride);
        return { getBindGroupLayout: () => ({}) };
      },
      createBindGroup: () => ({}),
      queue: {
        writeBuffer: (_b: unknown, _o: number, data: ArrayBufferView) => {
          if (data.byteLength === 16 || data.byteLength === 48) colorWrites++;
        },
        writeTexture: () => {},
      },
    };
    const s = new SurfaceLayer(VERTS, FACES, undefined, { color: 'red' });
    const visual = new SurfaceVisual(device as never, 'bgra8unorm', s);
    expect(strides).toEqual([0]);
    s.vertexColors = new Float32Array(12).fill(1);
    colorWrites = 0;
    visual.sync();
    expect(strides).toEqual([0, 16]);
    expect(colorWrites).toBe(1);
    s.color = 'blue'; // a uniform: no pipeline, no upload
    colorWrites = 0;
    visual.sync();
    expect(strides).toEqual([0, 16]);
    expect(colorWrites).toBe(0);
  });
});
