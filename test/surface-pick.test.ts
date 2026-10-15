import { describe, it, expect } from 'vitest';
import { invertMat4, multiply } from '../src/math/mat4';
import { screenRay, rayHitBox, rayHitTriangles, type Ray } from '../src/picking/ray';
import { projectPoint } from '../src/picking/project';
import { Camera3D } from '../src/camera/camera3d';
import { SurfaceLayer } from '../src/layers/surface-layer';
import { HeadlessViewer } from '../src/testing';

/** A cube of side 2 centred on `c`: 8 vertices, 12 triangles. */
function cube(c: [number, number, number] = [0, 0, 0]): {
  vertices: Float32Array;
  faces: Uint32Array;
} {
  const vertices = new Float32Array(24);
  for (let i = 0; i < 8; i++) {
    vertices[3 * i] = c[0] + (i & 1 ? 1 : -1);
    vertices[3 * i + 1] = c[1] + (i & 2 ? 1 : -1);
    vertices[3 * i + 2] = c[2] + (i & 4 ? 1 : -1);
  }
  // prettier-ignore
  const faces = new Uint32Array([
    0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, // z = -1, z = +1
    0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, // y = -1, y = +1
    0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3, // x = -1, x = +1
  ]);
  return { vertices, faces };
}

const along = (origin: [number, number, number], dir: [number, number, number]): Ray => {
  const l = Math.hypot(...dir);
  return { origin, dir: [dir[0] / l, dir[1] / l, dir[2] / l] };
};

describe('invertMat4', () => {
  it('inverts a view-projection, and refuses a singular matrix', () => {
    const cam = new Camera3D();
    cam.azimuth = 30;
    cam.elevation = 20;
    const m = cam.viewProjection(640, 480);
    const inv = invertMat4(m)!;
    const id = multiply(m, Float32Array.from(inv));
    for (let i = 0; i < 16; i++) expect(id[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 4);
    expect(invertMat4(new Float32Array(16))).toBeNull();
  });
});

describe('screenRay', () => {
  it('passes through the world point projected to that pixel, from several camera angles', () => {
    const cam = new Camera3D();
    for (const [az, el] of [
      [0, 0],
      [45, 30],
      [-120, -60],
      [200, 10],
    ]) {
      cam.azimuth = az;
      cam.elevation = el;
      const mvp = cam.viewProjection(800, 600);
      const p: [number, number, number] = [0.3, -0.2, 0.5];
      const s = projectPoint(mvp, p, 800, 600);
      const ray = screenRay(mvp, s.x, s.y, 800, 600)!;
      expect(Math.hypot(...ray.dir)).toBeCloseTo(1, 6);
      // Distance from p to the ray's line.
      const t =
        (p[0] - ray.origin[0]) * ray.dir[0] +
        (p[1] - ray.origin[1]) * ray.dir[1] +
        (p[2] - ray.origin[2]) * ray.dir[2];
      const q = [0, 1, 2].map((a) => ray.origin[a] + t * ray.dir[a]);
      expect(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])).toBeLessThan(1e-4);
      expect(t).toBeGreaterThan(0); // in front of the near plane
    }
    expect(screenRay(cam.viewProjection(800, 600), 1, 1, 0, 600)).toBeNull();
  });
});

describe('rayHitBox / rayHitTriangles', () => {
  it('enters a box, or misses it', () => {
    expect(rayHitBox(along([-5, 0, 0], [1, 0, 0]), [-1, -1, -1], [1, 1, 1])).toBeCloseTo(4);
    expect(rayHitBox(along([0, 0, 0], [1, 0, 0]), [-1, -1, -1], [1, 1, 1])).toBe(0); // inside
    expect(rayHitBox(along([-5, 3, 0], [1, 0, 0]), [-1, -1, -1], [1, 1, 1])).toBe(Infinity);
  });

  it('finds the nearest face of a cube from any side, its triangle and point', () => {
    const { vertices, faces } = cube();
    for (const [o, face] of [
      [[0.2, 0.1, -5], 'z-'],
      [[0.2, 0.1, 5], 'z+'],
      [[5, 0.1, 0.2], 'x+'],
      [[0.1, -5, 0.2], 'y-'],
    ] as Array<[[number, number, number], string]>) {
      const hit = rayHitTriangles(along(o, [-o[0], -o[1], -o[2]]), vertices, faces)!;
      expect(hit, face).not.toBeNull();
      const axis = face[0] === 'x' ? 0 : face[0] === 'y' ? 1 : 2;
      expect(hit.point[axis]).toBeCloseTo(face[1] === '+' ? 1 : -1, 6);
      const tri = Array.from(
        faces.slice(3 * hit.face, 3 * hit.face + 3),
        (v) => vertices[3 * v + axis],
      );
      expect(tri.every((c) => Math.abs(c - hit.point[axis]) < 1e-6)).toBe(true);
    }
    expect(rayHitTriangles(along([5, 5, 5], [1, 0, 0]), vertices, faces)).toBeNull();
  });

  it('skips what clipping planes cut away, finding the face behind', () => {
    const { vertices, faces } = cube();
    const ray = along([0.2, 0.1, -5], [0, 0, 1]);
    const planes = [{ position: [0, 0, 0] as const, normal: [0, 0, 1] as const }]; // keep z ≥ 0
    expect(rayHitTriangles(ray, vertices, faces, { clippingPlanes: planes })!.point[2]).toBeCloseTo(
      1,
    );
    expect(rayHitTriangles(ray, vertices, faces, { maxDistance: 3 })).toBeNull();
  });
});

describe('SurfaceLayer.pick', () => {
  it('picks with its clipping planes, and follows setData', () => {
    const { vertices, faces } = cube();
    const s = new SurfaceLayer(vertices, faces);
    const ray = along([0, 0, -5], [0, 0, 1]);
    expect(s.pick(ray)!.distance).toBeCloseTo(4);
    s.clippingPlanes = [{ position: [0, 0, 0], normal: [0, 0, 1] }];
    expect(s.pick(ray)!.distance).toBeCloseTo(6);
    s.clippingPlanes = [{ position: [0, 0, 5], normal: [0, 0, 1] }]; // everything cut away
    expect(s.pick(ray)).toBeNull();
    s.clippingPlanes = [];
    const moved = cube([10, 0, 0]);
    s.setData(moved.vertices, moved.faces);
    expect(s.pick(ray)).toBeNull(); // the cached bounds moved too
    expect(s.pick(along([10, 0, -5], [0, 0, 1]))!.distance).toBeCloseTo(4);
  });
});

describe('ViewerBase.pickSurface', () => {
  it('picks the nearest visible surface under a canvas point, as the camera sees it', () => {
    const v = new HeadlessViewer({ canvasRect: { width: 400, height: 300 } });
    const near = cube([0, 0, 0]);
    const a = v.addSurface(near.vertices, near.faces, undefined, { name: 'a' });
    const far = cube([0, 0, 0]);
    for (let i = 0; i < far.vertices.length; i++) far.vertices[i] *= 3; // encloses a: hit only from outside
    const b = v.addSurface(far.vertices, far.faces, undefined, { name: 'b', fit: 'never' });
    v.fitToLayers();
    // The centre of the canvas looks at the target: b's shell is nearer than a.
    expect(v.pickSurface(200, 150)!.layer).toBe(b);
    b.visible = false;
    expect(v.pickSurface(200, 150)!.layer).toBe(a);
    b.visible = true;
    expect(v.pickSurface(200, 150, { pickable: (l) => l !== b })!.layer).toBe(a);
    // A corner of the canvas misses both.
    expect(v.pickSurface(1, 1)).toBeNull();
    // The hit point projects back to the pointer.
    const hit = v.pickSurface(210, 140)!;
    const p = v.projectPoints(Float32Array.from(hit.point))!;
    expect(p.screen[0]).toBeCloseTo(210, 2);
    expect(p.screen[1]).toBeCloseTo(140, 2);
    v.dims.ndisplay = 2;
    expect(v.pickSurface(200, 150)).toBeNull();
  });

  it('picks only within the depth range the camera draws: nothing beyond the far plane', () => {
    const v = new HeadlessViewer({ canvasRect: { width: 400, height: 300 } });
    const anchor = cube([0, 0, 0]);
    v.addSurface(anchor.vertices, anchor.faces, undefined, { name: 'anchor', visible: false });
    v.camera3d.distance = 3;
    const ray = v.canvasRay(200, 150)!;
    // The ray runs from the near plane to the far plane: length = far − near along the centre.
    expect(ray.length).toBeGreaterThan(0);
    const at = (t: number): [number, number, number] => [
      ray.origin[0] + ray.dir[0] * t,
      ray.origin[1] + ray.dir[1] * t,
      ray.origin[2] + ray.dir[2] * t,
    ];
    const beyond = cube(at(ray.length! + 5));
    const layer = v.addSurface(beyond.vertices, beyond.faces, undefined, { fit: 'never' });
    // Beyond the far plane the GPU draws nothing, and nothing is picked: projectPoint agrees.
    expect(v.projectPoints(Float32Array.from(at(ray.length! + 5)))!.screen[0]).toBeNaN();
    expect(v.pickSurface(200, 150)).toBeNull();
    expect(layer.pick(ray)).toBeNull();
    // The same mesh as plain geometry: an unbounded ray finds it.
    expect(layer.pick({ origin: ray.origin, dir: ray.dir })).not.toBeNull();
    // Moved inside the far plane, it is picked.
    const inside = cube(at(ray.length! - 3));
    layer.setData(inside.vertices, inside.faces);
    expect(v.pickSurface(200, 150)!.layer).toBe(layer);
  });
});
