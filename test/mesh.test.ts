import { describe, it, expect } from 'vitest';
import { surfaceNets, labelsToMeshes, smoothMesh, type Mesh } from '../src/geometry';

type Shape = [number, number, number];

const volume = (
  shape: Shape,
  on: (x: number, y: number, z: number) => number | boolean,
): Uint8Array => {
  const [nx, ny, nz] = shape;
  const data = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) data[x + nx * (y + ny * z)] = Number(on(x, y, z));
  return data;
};

const sphere = (n: number, r: number) => {
  const c = n / 2;
  return volume(
    [n, n, n],
    (x, y, z) => (x + 0.5 - c) ** 2 + (y + 0.5 - c) ** 2 + (z + 0.5 - c) ** 2 <= r * r,
  );
};

/** Every directed edge once and its reverse once: closed, and wound the same way throughout. */
const closedAndConsistent = (m: Mesh): boolean => {
  const directed = new Map<string, number>();
  const f = m.faces;
  for (let i = 0; i < f.length; i += 3) {
    for (const [a, b] of [
      [f[i], f[i + 1]],
      [f[i + 1], f[i + 2]],
      [f[i + 2], f[i]],
    ]) {
      const key = `${a},${b}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of directed) {
    const [a, b] = key.split(',');
    if (n !== 1 || directed.get(`${b},${a}`) !== 1) return false;
  }
  return true;
};

/** Signed volume (divergence theorem): positive for outward-facing triangles. */
const signedVolume = (m: Mesh): number => {
  const v = m.vertices;
  const f = m.faces;
  let s = 0;
  for (let i = 0; i < f.length; i += 3) {
    const a = 3 * f[i],
      b = 3 * f[i + 1],
      c = 3 * f[i + 2];
    s +=
      v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) -
      v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) +
      v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return s / 6;
};

const bounds = (m: Mesh): number[] => {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], m.vertices[i + k]);
      b[k + 3] = Math.max(b[k + 3], m.vertices[i + k]);
    }
  }
  return b;
};

/** Mean squared distance of each vertex from its neighbours' mean. */
const roughness = (m: Mesh): number => {
  const n = m.vertices.length / 3;
  const sum = new Float64Array(3 * n);
  const count = new Uint32Array(n);
  const f = m.faces;
  for (let i = 0; i < f.length; i += 3) {
    for (const [a, b] of [
      [f[i], f[i + 1]],
      [f[i + 1], f[i + 2]],
      [f[i + 2], f[i]],
    ]) {
      for (let k = 0; k < 3; k++) sum[3 * a + k] += m.vertices[3 * b + k];
      count[a]++;
    }
  }
  let r = 0;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) r += (m.vertices[3 * i + k] - sum[3 * i + k] / count[i]) ** 2;
  return r / n;
};

describe('surfaceNets', () => {
  it('meshes a sphere: closed, outward, about its volume', () => {
    const m = surfaceNets(sphere(32, 10), [32, 32, 32]);
    expect(m.faces.length % 3).toBe(0);
    expect(closedAndConsistent(m)).toBe(true);
    const vol = signedVolume(m);
    expect(vol).toBeGreaterThan(0);
    expect(vol / ((4 / 3) * Math.PI * 1000)).toBeCloseTo(1, 1);
    // Euler characteristic of a sphere: V − E + F = 2, with E = 3F/2 for a closed mesh.
    const V = m.vertices.length / 3,
      F = m.faces.length / 3;
    expect(V - (3 * F) / 2 + F).toBe(2);
  });

  it('places a box’s faces on its voxels’ outer edges', () => {
    // Voxels 2..5 on each axis, centred on 2..5, span [1.5, 5.5).
    const m = surfaceNets(
      volume([8, 8, 8], (x, y, z) => x >= 2 && x < 6 && y >= 2 && y < 6 && z >= 2 && z < 6),
      [8, 8, 8],
    );
    expect(closedAndConsistent(m)).toBe(true);
    expect(bounds(m)).toEqual([1.5, 1.5, 1.5, 5.5, 5.5, 5.5]);
    expect(signedVolume(m)).toBeGreaterThan(0);
    expect(signedVolume(m)).toBeLessThan(64); // corners and edges are bevelled
  });

  it('closes a mask that touches the volume’s edge', () => {
    const m = surfaceNets(new Uint8Array(4 * 3 * 2).fill(1), [4, 3, 2]);
    expect(closedAndConsistent(m)).toBe(true);
    expect(bounds(m)).toEqual([-0.5, -0.5, -0.5, 3.5, 2.5, 1.5]);
  });

  it('lines up with the volume: voxel i centred on i, as VolumeLayer planes and clipping use', () => {
    // One voxel at (3, 1, 2): its mesh is centred there; origin [0.5, 0.5, 0.5] gives [i, i + 1).
    const one = volume([6, 4, 4], (x, y, z) => x === 3 && y === 1 && z === 2);
    const b = bounds(surfaceNets(one, [6, 4, 4]));
    const centre = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    centre.forEach((v, i) => expect(v).toBeCloseTo([3, 1, 2][i], 6));
    const shifted = bounds(surfaceNets(one, [6, 4, 4], { origin: [0.5, 0.5, 0.5] }));
    shifted.forEach((v, i) => expect(v - b[i]).toBeCloseTo(0.5, 6));
  });

  it('gives an empty mesh for an empty mask, and refuses a mask smaller than its shape', () => {
    const m = surfaceNets(new Uint8Array(27), [3, 3, 3]);
    expect(m.vertices.length).toBe(0);
    expect(m.faces.length).toBe(0);
    expect(() => surfaceNets(new Uint8Array(8), [3, 3, 3])).toThrow();
  });

  it('maps voxels to world by voxelSize and origin, and thresholds at level', () => {
    const data = volume([4, 4, 4], (x, y, z) =>
      x === 1 && y === 1 && z === 1 ? 200 : x === 2 ? 50 : 0,
    );
    const m = surfaceNets(data, [4, 4, 4], {
      voxelSize: [2, 1, 0.5],
      origin: [10, 0, -1],
      level: 100,
    });
    // Only the voxel above 100, meshed in voxel units, then scaled and moved.
    const plain = surfaceNets(
      data.map((v) => (v > 100 ? 1 : 0)),
      [4, 4, 4],
    );
    expect(m.faces).toEqual(plain.faces);
    const want = Array.from(plain.vertices, (v, i) => [10, 0, -1][i % 3] + [2, 1, 0.5][i % 3] * v);
    Array.from(m.vertices).forEach((v, i) => expect(v).toBeCloseTo(want[i], 5));
  });

  it('logs how long a 256³ sphere takes', () => {
    const data = sphere(256, 100);
    const t0 = performance.now();
    const m = surfaceNets(data, [256, 256, 256]);
    const ms = performance.now() - t0;
    console.log(`surfaceNets 256³ sphere: ${ms.toFixed(0)} ms, ${m.vertices.length / 3} vertices`);
    expect(closedAndConsistent(m)).toBe(true);
  });
});

describe('labelsToMeshes', () => {
  it('meshes each label as surfaceNets of its own mask, over its bounding box', () => {
    const shape: Shape = [10, 8, 6];
    const labels = volume(shape, (x, y, z) =>
      x < 4 && y < 4 && z < 3 ? 3 : x > 5 && z > 1 ? 7 : 0,
    );
    const meshes = labelsToMeshes(labels, shape, { voxelSize: [1, 2, 3] });
    expect([...meshes.keys()]).toEqual([3, 7]);
    for (const [value, mesh] of meshes) {
      const own = surfaceNets(
        labels.map((v) => (v === value ? 1 : 0)),
        shape,
        { voxelSize: [1, 2, 3] },
      );
      expect(Array.from(mesh.vertices)).toEqual(Array.from(own.vertices));
      expect(Array.from(mesh.faces)).toEqual(Array.from(own.faces));
    }
    expect([...labelsToMeshes(labels, shape, { only: [7] }).keys()]).toEqual([7]);
  });
});

describe('smoothMesh', () => {
  const m = surfaceNets(sphere(32, 10), [32, 32, 32]);

  it('smooths the voxel steps (Laplacian), keeping the faces and leaving the input alone', () => {
    const before = m.vertices.slice();
    const s = smoothMesh(m, { iterations: 4 });
    expect(roughness(s)).toBeLessThan(roughness(m));
    expect(s.faces).toBe(m.faces);
    expect(Array.from(m.vertices)).toEqual(Array.from(before));
    expect(smoothMesh(m, { iterations: 0 }).vertices).toEqual(m.vertices);
  });

  it('keeps the volume with Taubin’s second step, where Laplacian alone shrinks it', () => {
    const v0 = signedVolume(m);
    const laplacian = signedVolume(smoothMesh(m, { iterations: 10, lambda: 0.5 }));
    const taubin = signedVolume(smoothMesh(m, { iterations: 10, lambda: 0.5, mu: -0.53 }));
    expect(laplacian / v0).toBeLessThan(0.95);
    expect(Math.abs(taubin / v0 - 1)).toBeLessThan(0.03);
  });
});
