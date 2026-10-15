/**
 * Meshes from voxel masks: the boundary of a mask (or of each label of a labels volume) by surface
 * nets, and Laplacian/Taubin smoothing — what napari gets from `skimage.measure.marching_cubes`
 * before handing a surface to `add_surface`. Pure: no DOM, no GPU, usable from workers.
 */

/** A triangle mesh: `vertices` x, y, z triples, `faces` vertex index triples — `addSurface`'s input. */
export interface Mesh {
  vertices: Float32Array;
  faces: Uint32Array;
}

/** A volume's size in voxels, `[nx, ny, nz]` (x fastest in the data). */
export type VolumeShape = readonly [number, number, number];

/** Options for {@link surfaceNets} and {@link labelsToMeshes}. */
export interface SurfaceNetsOptions {
  /** World size of one voxel per axis (as `VolumeLayer.voxelSize`). Default `[1, 1, 1]`. */
  voxelSize?: readonly [number, number, number];
  /** World position of voxel coordinate 0 (the corner of voxel 0). Default `[0, 0, 0]`. */
  origin?: readonly [number, number, number];
  /** A voxel is inside when its value is above `level`. Default 0 (non-zero is inside). */
  level?: number;
}

/** Options for {@link smoothMesh}. */
export interface SmoothOptions {
  /** Passes (default 2). */
  iterations?: number;
  /** How far each vertex moves to its neighbours' mean per pass (default 0.5). */
  lambda?: number;
  /**
   * Taubin's second, negative step per pass (e.g. −0.53 with lambda 0.5): it undoes the shrinking
   * that Laplacian smoothing alone causes. Default: none (plain Laplacian).
   */
  mu?: number;
}

/**
 * The boundary of a voxel mask as a closed triangle mesh, by surface nets (Gibson's): one vertex
 * per cell the boundary crosses, at the mean of its crossing edges' midpoints, and a quad (two
 * triangles) per pair of neighbouring voxels the boundary separates. Smoother than marching cubes'
 * staircase at the same resolution, and closed even where the mask touches the volume's edge.
 *
 * Coordinates: voxel `i` spans `[i, i + 1)` on its axis (its centre is `i + 0.5`), mapped to world
 * by `origin + voxelSize · v`. Faces wind counter-clockwise seen from outside (outward normals: a
 * positive signed volume). An empty or full-free mask gives an empty mesh.
 */
export function surfaceNets(
  mask: ArrayLike<number>,
  shape: VolumeShape,
  opts: SurfaceNetsOptions = {},
): Mesh {
  const [nx, ny, nz] = shape;
  if (mask.length < nx * ny * nz)
    throw new Error(`Mask (${mask.length}) smaller than ${nx}×${ny}×${nz}.`);
  const level = opts.level ?? 0;
  const padded = pad(nx, ny, nz, (i) => mask[i] > level, [0, 0, 0], [nx, ny, nz]);
  return nets(padded, nx, ny, nz, [0, 0, 0], opts);
}

/**
 * One mesh per label of a labels volume (as {@link surfaceNets} of `labels === value`), keyed by
 * label value; 0 is background. Each label is meshed over its own bounding box only, so a volume
 * of many small labels costs about one pass over the data. `only` limits it to those labels.
 */
export function labelsToMeshes(
  labels: ArrayLike<number>,
  shape: VolumeShape,
  opts: Omit<SurfaceNetsOptions, 'level'> & { only?: readonly number[] } = {},
): Map<number, Mesh> {
  const [nx, ny, nz] = shape;
  if (labels.length < nx * ny * nz)
    throw new Error(`Labels (${labels.length}) smaller than ${nx}×${ny}×${nz}.`);
  const wanted = opts.only ? new Set(opts.only) : null;
  // Each label's bounding box: [x0, y0, z0, x1, y1, z1), one pass.
  const boxes = new Map<number, number[]>();
  for (let z = 0, i = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        const v = labels[i];
        if (!v || (wanted && !wanted.has(v))) continue;
        const b = boxes.get(v);
        if (!b) {
          boxes.set(v, [x, y, z, x + 1, y + 1, z + 1]);
          continue;
        }
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (z < b[2]) b[2] = z;
        if (x >= b[3]) b[3] = x + 1;
        if (y >= b[4]) b[4] = y + 1;
        if (z >= b[5]) b[5] = z + 1;
      }
    }
  }
  const out = new Map<number, Mesh>();
  for (const [value, b] of [...boxes].sort((p, q) => p[0] - q[0])) {
    const sx = b[3] - b[0],
      sy = b[4] - b[1],
      sz = b[5] - b[2];
    const padded = pad(sx, sy, sz, (i) => labels[i] === value, [b[0], b[1], b[2]], [nx, ny, nz]);
    out.set(value, nets(padded, sx, sy, sz, [b[0], b[1], b[2]], opts));
  }
  return out;
}

/**
 * Smooth a mesh: `iterations` passes moving each vertex `lambda` of the way to its neighbours'
 * mean (neighbours weighted by the faces they share), and with `mu` a second, negative step per
 * pass (Taubin), which keeps the volume. Returns a new mesh with the same faces.
 */
export function smoothMesh(mesh: Mesh, opts: SmoothOptions = {}): Mesh {
  const iterations = opts.iterations ?? 2;
  const lambda = opts.lambda ?? 0.5;
  const n = mesh.vertices.length / 3;
  if (!n || iterations <= 0) return { vertices: mesh.vertices.slice(), faces: mesh.faces };
  // Neighbours in CSR form: each face lists its other two corners for each corner.
  const f = mesh.faces;
  const count = new Uint32Array(n + 1);
  for (let i = 0; i < f.length; i++) count[f[i] + 1] += 2;
  for (let i = 0; i < n; i++) count[i + 1] += count[i];
  const nb = new Uint32Array(count[n]);
  const fill = count.slice(0, n);
  for (let i = 0; i + 2 < f.length; i += 3) {
    const a = f[i],
      b = f[i + 1],
      c = f[i + 2];
    nb[fill[a]++] = b;
    nb[fill[a]++] = c;
    nb[fill[b]++] = a;
    nb[fill[b]++] = c;
    nb[fill[c]++] = a;
    nb[fill[c]++] = b;
  }
  const step = (v: Float32Array, k: number): Float32Array => {
    const next = new Float32Array(v.length);
    for (let i = 0; i < n; i++) {
      const from = count[i],
        to = count[i + 1];
      const x = v[3 * i],
        y = v[3 * i + 1],
        z = v[3 * i + 2];
      if (from === to) {
        next[3 * i] = x;
        next[3 * i + 1] = y;
        next[3 * i + 2] = z;
        continue;
      }
      let mx = 0,
        my = 0,
        mz = 0;
      for (let j = from; j < to; j++) {
        const q = 3 * nb[j];
        mx += v[q];
        my += v[q + 1];
        mz += v[q + 2];
      }
      const m = to - from;
      next[3 * i] = x + k * (mx / m - x);
      next[3 * i + 1] = y + k * (my / m - y);
      next[3 * i + 2] = z + k * (mz / m - z);
    }
    return next;
  };
  let v = mesh.vertices;
  for (let it = 0; it < iterations; it++) {
    v = step(v, lambda);
    if (opts.mu !== undefined) v = step(v, opts.mu);
  }
  return { vertices: v, faces: mesh.faces };
}

/**
 * The `sx·sy·sz` box at `at` of a volume of `size`, as 0/1 with an empty voxel of padding on every
 * side, so every cell's corners can be read without bounds checks.
 */
function pad(
  sx: number,
  sy: number,
  sz: number,
  inside: (i: number) => boolean,
  at: readonly [number, number, number],
  size: readonly [number, number, number],
): Uint8Array {
  const px = sx + 2,
    pxy = px * (sy + 2);
  const out = new Uint8Array(pxy * (sz + 2));
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      const src = at[0] + size[0] * (at[1] + y + size[1] * (at[2] + z));
      const dst = 1 + px * (y + 1) + pxy * (z + 1);
      for (let x = 0; x < sx; x++) if (inside(src + x)) out[dst + x] = 1;
    }
  }
  return out;
}

/**
 * Per corner configuration (bit c set: corner c inside; corner bits x = 1, y = 2, z = 4), the mean
 * of its crossing edges' midpoints relative to corner 0, as x, y, z triples.
 */
const CELL_OFFSETS = ((): Float64Array => {
  const edges = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ];
  const out = new Float64Array(256 * 3);
  for (let k = 1; k < 255; k++) {
    let sx = 0,
      sy = 0,
      sz = 0,
      n = 0;
    for (const [a, b] of edges) {
      if (((k >> a) & 1) === ((k >> b) & 1)) continue;
      sx += ((a & 1) + (b & 1)) / 2;
      sy += (((a >> 1) & 1) + ((b >> 1) & 1)) / 2;
      sz += (((a >> 2) & 1) + ((b >> 2) & 1)) / 2;
      n++;
    }
    out[3 * k] = sx / n;
    out[3 * k + 1] = sy / n;
    out[3 * k + 2] = sz / n;
  }
  return out;
})();

/**
 * Surface nets over a padded 0/1 box of `nx·ny·nz` voxels whose voxel 0 is at voxel coordinate
 * `at` of the volume. Cells sit between voxel centres: cell (x, y, z), for x in −1..nx−1 and so on,
 * has corners at voxels x..x+1, y..y+1, z..z+1. One pass: a quad needs only cells already visited.
 */
function nets(
  p: Uint8Array,
  nx: number,
  ny: number,
  nz: number,
  at: readonly [number, number, number],
  opts: SurfaceNetsOptions,
): Mesh {
  const [vx, vy, vz] = opts.voxelSize ?? [1, 1, 1];
  const [ox, oy, oz] = opts.origin ?? [0, 0, 0];
  const px = nx + 2,
    pxy = px * (ny + 2);
  const cx = nx + 1,
    cxy = cx * (ny + 1);
  const vertexOf = new Int32Array(cxy * (nz + 1)).fill(-1);
  let verts = new Float32Array(1024);
  let nv = 0;
  let faces = new Uint32Array(1024);
  let nf = 0;
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (nf + 6 > faces.length) {
      const grown = new Uint32Array(faces.length * 2);
      grown.set(faces);
      faces = grown;
    }
    if (flip) {
      faces[nf++] = a;
      faces[nf++] = c;
      faces[nf++] = b;
      faces[nf++] = a;
      faces[nf++] = d;
      faces[nf++] = c;
    } else {
      faces[nf++] = a;
      faces[nf++] = b;
      faces[nf++] = c;
      faces[nf++] = a;
      faces[nf++] = c;
      faces[nf++] = d;
    }
  };
  for (let z = -1; z < nz; z++) {
    for (let y = -1; y < ny; y++) {
      // Padded index of voxel (x, y, z), and the index of cell (x, y, z), at x = −1.
      let q = px * (y + 1) + pxy * (z + 1);
      let ci = cx * (y + 1) + cxy * (z + 1);
      for (let x = -1; x < nx; x++, q++, ci++) {
        const k =
          p[q] |
          (p[q + 1] << 1) |
          (p[q + px] << 2) |
          (p[q + px + 1] << 3) |
          (p[q + pxy] << 4) |
          (p[q + pxy + 1] << 5) |
          (p[q + pxy + px] << 6) |
          (p[q + pxy + px + 1] << 7);
        if (k === 0 || k === 255) continue;
        if (nv + 3 > verts.length) {
          const grown = new Float32Array(verts.length * 2);
          grown.set(verts);
          verts = grown;
        }
        vertexOf[ci] = nv / 3;
        // Corner 0 of cell x is voxel x, whose centre is at x + 0.5.
        verts[nv++] = ox + vx * (at[0] + x + 0.5 + CELL_OFFSETS[3 * k]);
        verts[nv++] = oy + vy * (at[1] + y + 0.5 + CELL_OFFSETS[3 * k + 1]);
        verts[nv++] = oz + vz * (at[2] + z + 0.5 + CELL_OFFSETS[3 * k + 2]);

        // A quad per voxel edge from (x, y, z) whose ends differ, between the four cells around
        // that edge, wound so the faces point out of the mask.
        const here = p[q];
        if (here !== p[q + 1] && y >= 0 && z >= 0) {
          quad(vertexOf[ci - cx - cxy], vertexOf[ci - cxy], vertexOf[ci], vertexOf[ci - cx], !here);
        }
        if (here !== p[q + px] && x >= 0 && z >= 0) {
          quad(vertexOf[ci - 1 - cxy], vertexOf[ci - 1], vertexOf[ci], vertexOf[ci - cxy], !here);
        }
        if (here !== p[q + pxy] && x >= 0 && y >= 0) {
          quad(vertexOf[ci - 1 - cx], vertexOf[ci - cx], vertexOf[ci], vertexOf[ci - 1], !here);
        }
      }
    }
  }
  return { vertices: verts.slice(0, nv), faces: faces.slice(0, nf) };
}
