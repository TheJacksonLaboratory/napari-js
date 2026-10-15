import { describe, it, expect } from 'vitest';
import { SurfaceLayer } from '../src/layers/surface-layer';
import { VolumeLayer } from '../src/layers/volume-layer';
import { drawOrder3D } from '../src/engine/renderer';

/** A unit quad in the plane z = `z`, blending translucently unless `opts` says otherwise. */
function quad(z: number, opts: ConstructorParameters<typeof SurfaceLayer>[3] = {}): SurfaceLayer {
  const vertices = new Float32Array([-1, -1, z, 1, -1, z, 1, 1, z, -1, 1, z]);
  return new SurfaceLayer(vertices, new Uint32Array([0, 1, 2, 0, 2, 3]), undefined, {
    blending: 'translucent',
    ...opts,
  });
}

describe('SurfaceLayer.translucent', () => {
  it('is set by opacity, colour alpha or a per-vertex alpha below 1, unless blending is opaque', () => {
    expect(quad(0).translucent).toBe(false);
    expect(quad(0, { opacity: 0.22 }).translucent).toBe(true);
    // A surface's default blending is opaque: nothing shows through it whatever its opacity.
    expect(
      new SurfaceLayer(new Float32Array(9), new Uint32Array(3), undefined, { opacity: 0.2 })
        .translucent,
    ).toBe(false);
    expect(quad(0, { opacity: 0.22, blending: 'opaque' }).translucent).toBe(false);
    expect(quad(0, { color: [1, 0, 0, 0.5] }).translucent).toBe(true);
    expect(quad(0, { color: '#ff0000' }).translucent).toBe(false);
    const q = quad(0, { vertexColors: new Float32Array(16).fill(1) });
    expect(q.translucent).toBe(false);
    const colors = new Float32Array(16).fill(1);
    colors[7] = 0.4; // vertex 1's alpha
    q.vertexColors = colors;
    expect(q.translucent).toBe(true);
    q.opacity = 1;
    q.vertexColors = null;
    expect(q.translucent).toBe(false);
  });
});

describe('drawOrder3D', () => {
  it('draws translucent surfaces last, farthest first, after everything else in list order', () => {
    const vol = new VolumeLayer(new Uint8Array(8), 2, 2, 2);
    const nearPlane = quad(5, { opacity: 0.3, name: 'near' });
    const opaque = quad(-10, { name: 'opaque' });
    const farPlane = quad(-5, { opacity: 0.3, name: 'far' });
    const eye: [number, number, number] = [0, 0, 20];
    // A surface added after the translucent planes is drawn before them, so it shows through.
    const order = drawOrder3D([nearPlane, vol, farPlane, opaque], eye);
    expect(order.map((l) => l.name)).toEqual([vol.name, 'opaque', 'far', 'near']);
    // From the other side, the order of the translucent ones flips.
    const back = drawOrder3D([nearPlane, vol, farPlane, opaque], [0, 0, -20]);
    expect(back.map((l) => l.name)).toEqual([vol.name, 'opaque', 'near', 'far']);
  });
});
