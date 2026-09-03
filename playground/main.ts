import {
  Viewer,
  VERSION,
  nearestPointIndex,
  levelDims,
  levelScale,
  heightField,
  type TypedImageSource,
  type TiledSource,
  type TileKey,
  type PixelChunk,
  type VolumeRendering,
} from '../src/index';

// Multi-demo playground: number keys 1–5 switch demos so every render path can be
// visually verified in a WebGPU browser. Each demo rebuilds the Viewer on the same canvas.

const canvas = document.getElementById('c') as HTMLCanvasElement;
const msg = document.getElementById('msg') as HTMLDivElement;

let viewer: Viewer | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;
let cleanup: (() => void) | null = null;

const DEMOS =
  '1 image · 2 multi-channel · 3 tiled+z · 4 points+labels · 5 volume · 6 surface · 7 scatter3d' +
  ' · 8 shapes';

function status(line: string): void {
  msg.textContent = `napari-js ${VERSION} — [${DEMOS}]  ·  ${line}`;
}

// ── data generators ──────────────────────────────────────────────────────
function gradient(w: number, h: number): TypedImageSource {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      data[y * w + x] = Math.round(255 * (0.5 + 0.5 * Math.sin(x / 40) * Math.cos(y / 40)));
  return { kind: 'typed', width: w, height: h, channels: 1, dtype: 'uint8', data };
}

function blob(w: number, h: number, cx: number, cy: number, sigma: number): TypedImageSource {
  const data = new Uint8Array(w * h);
  const s2 = 2 * sigma * sigma;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      data[y * w + x] = Math.round(255 * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / s2));
  return { kind: 'typed', width: w, height: h, channels: 1, dtype: 'uint8', data };
}

// ── demos ────────────────────────────────────────────────────────────────
async function start(bg: GPUColor): Promise<Viewer | null> {
  cleanup?.();
  cleanup = null;
  onKey = null;
  viewer?.dispose();
  const v = new Viewer({ canvas, background: bg });
  try {
    await v.ready;
  } catch (err) {
    msg.textContent = `WebGPU unavailable: ${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
  viewer = v;
  return v;
}

async function demoImage(): Promise<void> {
  const v = await start({ r: 0.07, g: 0.07, b: 0.09, a: 1 });
  if (!v) return;
  const layer = v.addImage(gradient(512, 512), { colormap: 'viridis', contrastLimits: [0, 255] });
  const cmaps = ['viridis', 'magma', 'gray', 'red'];
  let ci = 0;
  onKey = (e) => {
    if (e.key === 'c') {
      ci = (ci + 1) % cmaps.length;
      layer.colormap = cmaps[ci];
      status(`image · colormap ${cmaps[ci]} · drag/wheel, c = colormap`);
    }
  };
  status('image · drag/wheel, c = colormap');
}

async function demoMultiChannel(): Promise<void> {
  const v = await start({ r: 0, g: 0, b: 0, a: 1 });
  if (!v) return;
  v.addImage(blob(512, 512, 205, 230, 90), { colormap: 'red', blending: 'additive' });
  v.addImage(blob(512, 512, 307, 230, 90), { colormap: 'green', blending: 'additive' });
  v.addImage(blob(512, 512, 256, 320, 90), { colormap: 'blue', blending: 'additive' });
  status('multi-channel additive (R/G/B blobs) · drag/wheel');
}

async function demoTiled(): Promise<void> {
  const v = await start({ r: 0.07, g: 0.07, b: 0.09, a: 1 });
  if (!v) return;
  const FULL = 16384;
  const TILE = 256;
  const fetchTile = ({ level, col, row, z }: TileKey): Promise<PixelChunk> => {
    const dims = levelDims(FULL, FULL, level);
    const w = Math.min(TILE, dims.width - col * TILE);
    const h = Math.min(TILE, dims.height - row * TILE);
    const s = levelScale(level);
    const data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const gx = (col * TILE + x) * s;
        const gy = (row * TILE + y) * s;
        const checker = (((gx >> 9) + (gy >> 9)) & 1) === 0 ? 90 : 30;
        data[y * w + x] = Math.min(
          255,
          checker + 60 * (0.5 + 0.5 * Math.sin((gx + gy) / (400 + z * 120))),
        );
      }
    return new Promise((res) => setTimeout(() => res({ width: w, height: h, data }), 8));
  };
  const source: TiledSource = {
    kind: 'tiled',
    width: FULL,
    height: FULL,
    tileSize: TILE,
    levels: 7,
    depth: 8,
    channels: 1,
    dtype: 'uint8',
    fetchTile,
  };
  v.addImage(source, { colormap: 'viridis' });
  onKey = (e) => {
    if (e.key === 'ArrowUp') v.dims.z += 1;
    else if (e.key === 'ArrowDown') v.dims.z -= 1;
    else return;
    status(`tiled 16384² · z ${v.dims.z}/7 · drag/wheel (LOD), ↑/↓ z`);
  };
  status('tiled 16384² · z 0/7 · drag/wheel (LOD), ↑/↓ z');
}

async function demoPointsLabels(): Promise<void> {
  const v = await start({ r: 0.07, g: 0.07, b: 0.09, a: 1 });
  if (!v) return;
  v.addImage(gradient(512, 512), { colormap: 'gray' });
  const lbl = new Uint8Array(512 * 512);
  const blocks: [number, number, number, number, number][] = [
    [40, 40, 160, 160, 1],
    [300, 60, 460, 200, 2],
    [120, 300, 380, 460, 3],
  ];
  for (const [x0, y0, x1, y1, id] of blocks)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) lbl[y * 512 + x] = id;
  const labels = v.addLabels(lbl, 512, 512, { opacity: 0.5 });
  const positions: number[][] = [];
  for (let i = 0; i < 36; i++) positions.push([60 + (i % 6) * 80, 60 + Math.floor(i / 6) * 80]);
  const points = v.addPoints(positions, {
    size: positions.map((_, i) => 14 + (i % 5) * 6),
    faceColor: positions.map((_, i): [number, number, number, number] =>
      i % 2 ? [1, 0.85, 0.2, 1] : [0.2, 0.8, 1, 1],
    ),
    borderColor: [0, 0, 0, 1],
    borderWidth: 2,
  });
  const onClick = (e: MouseEvent): void => {
    const [x, y] = v.canvasToWorld(e.clientX, e.clientY);
    const pi = nearestPointIndex(points.positions, (i) => points.sizeAt(i), x, y);
    const id = labels.labelAt(x, y);
    labels.selectedLabel = id;
    labels.showSelectedOnly = id !== 0;
    status(
      `points+labels · pick (${x.toFixed(0)},${y.toFixed(0)}) → point ${pi}, label ${id} · click to pick`,
    );
  };
  canvas.addEventListener('click', onClick);
  cleanup = () => canvas.removeEventListener('click', onClick);
  status('points + labels over image · click to pick');
}

async function demoVolume(): Promise<void> {
  const v = await start({ r: 0, g: 0, b: 0, a: 1 });
  if (!v) return;
  const N = 96;
  const data = new Uint8Array(N * N * N);
  const blobs: [number, number, number, number][] = [
    [0.35, 0.4, 0.5, 0.14],
    [0.65, 0.55, 0.45, 0.12],
    [0.5, 0.65, 0.6, 0.1],
  ];
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        let s = 0;
        for (const [bx, by, bz, sig] of blobs)
          s += Math.exp(
            -((x / N - bx) ** 2 + (y / N - by) ** 2 + (z / N - bz) ** 2) / (2 * sig * sig),
          );
        data[(z * N + y) * N + x] = Math.min(255, Math.round(s * 255));
      }
  const vol = v.addVolume(data, N, N, N, {
    colormap: 'magma',
    rendering: 'mip',
    isoThreshold: 0.35,
  });
  onKey = (e) => {
    const mode: VolumeRendering | null =
      e.key === 'm' ? 'mip' : e.key === 't' ? 'translucent' : e.key === 'i' ? 'iso' : null;
    if (!mode) return;
    vol.rendering = mode;
    status(`volume (${mode}) · drag = orbit, wheel = zoom, m/t/i = mode`);
  };
  status('volume (mip) · drag = orbit, wheel = zoom, m/t/i = mode');
}

async function demoSurface(): Promise<void> {
  const v = await start({ r: 0.03, g: 0.03, b: 0.05, a: 1 });
  if (!v) return;
  // A 2D scalar field (rippled gaussians) → height-field surface mesh (z = intensity).
  const W = 160;
  const H = 120;
  const field = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const g =
        Math.exp(-(((x - 55) / 28) ** 2 + ((y - 45) / 28) ** 2)) +
        0.8 * Math.exp(-(((x - 110) / 22) ** 2 + ((y - 80) / 22) ** 2));
      const ripple = 0.15 * (0.5 + 0.5 * Math.sin(x / 9) * Math.cos(y / 11));
      field[y * W + x] = Math.min(255, Math.round(255 * (0.9 * g + ripple)));
    }
  const { vertices, faces, values } = heightField(field, W, H, { zScale: 60 });
  const colormaps = ['viridis', 'magma', 'gray'];
  let ci = 0;
  const surface = v.addSurface(vertices, faces, values, { colormap: colormaps[ci] });
  const line = (): string =>
    `surface · ${values.length} verts, ${faces.length / 3} tris · colormap ${colormaps[ci]}` +
    `${surface.wireframe ? ' · wireframe' : ''} · drag = orbit, wheel = zoom, c = colormap, w = wireframe`;
  onKey = (e) => {
    if (e.key === 'c') {
      ci = (ci + 1) % colormaps.length;
      surface.colormap = colormaps[ci];
    } else if (e.key === 'w') {
      surface.wireframe = !surface.wireframe;
    } else {
      return;
    }
    v.requestRender();
    status(line());
  };
  status(line());
}

async function demoScatter3d(): Promise<void> {
  const v = await start({ r: 0.03, g: 0.03, b: 0.05, a: 1 });
  if (!v) return;
  // A 3D point cloud on two nested spheres, colored by radius.
  const N = 4000;
  const pos = new Float32Array(N * 3);
  const val = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = i % 2 === 0 ? 30 : 55;
    const th = (i * 2.399963) % (Math.PI * 2); // golden-angle spiral
    const ph = Math.acos(1 - (2 * (i + 0.5)) / N);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
    pos[i * 3 + 2] = r * Math.cos(ph);
    val[i] = r;
  }
  v.addPoints3D(pos, val, { colormap: 'viridis', size: 6 });
  status(`3D scatter · ${N} points · drag = orbit, wheel = zoom`);
}

async function demoShapes(): Promise<void> {
  const v = await start({ r: 0.05, g: 0.05, b: 0.07, a: 1 });
  if (!v) return;
  // A field of irregular "cell" rings over an image, as flat rings — the shape
  // segmentation arrives in, and the shape that survives 10^5 of them.
  const cols = 60;
  const rows = 40;
  const perRing = 16;
  const shapes = cols * rows;
  const coords = new Float32Array(shapes * perRing * 2);
  const offsets = new Uint32Array(shapes + 1);
  const values = new Float32Array(shapes);
  let w = 0;
  for (let s = 0; s < shapes; s++) {
    offsets[s] = s * perRing;
    const gx = s % cols;
    const gy = Math.floor(s / cols);
    const cx = 12 + gx * 8.5;
    const cy = 12 + gy * 8.5;
    const r = 2.6 + ((gx + gy) % 3) * 0.5;
    for (let i = 0; i < perRing; i++) {
      const a = (i / perRing) * Math.PI * 2;
      const jitter = 0.78 + ((gx * 7 + gy * 13 + i * 5) % 9) / 22;
      coords[w++] = cx + Math.cos(a) * r * jitter;
      coords[w++] = cy + Math.sin(a) * r * jitter;
    }
    values[s] = (gx / cols) * 100; // a stand-in cluster / measurement
  }
  offsets[shapes] = shapes * perRing;

  v.addImage(gradient(512, 512), { colormap: 'gray', opacity: 0.6 });
  const layer = v.addShapes(coords, offsets, {
    draw: 'outline',
    values,
    colormap: 'viridis',
    opacity: 0.95,
    blending: 'translucent',
  });
  const report = (): void =>
    status(
      `shapes · ${shapes} rings × ${perRing} verts · ${layer.draw} · ` +
        `${layer.vertexCount().toLocaleString()} vertices · f = outline/fill, c = colormap`,
    );
  report();
  onKey = (e: KeyboardEvent): void => {
    if (e.key === 'f') {
      layer.draw = layer.draw === 'outline' ? 'fill' : 'outline';
      report();
    } else if (e.key === 'c') {
      layer.colormap = layer.colormap.name === 'viridis' ? 'magma' : 'viridis';
      report();
    }
  };
  cleanup = (): void => {
    onKey = null;
  };
}

interface DemoDef {
  id: string;
  label: string;
  run: () => Promise<void>;
}

const demoList: DemoDef[] = [
  { id: '1', label: '1 · Image + colormap', run: demoImage },
  { id: '2', label: '2 · Multi-channel additive', run: demoMultiChannel },
  { id: '3', label: '3 · Tiled + z-stack', run: demoTiled },
  { id: '4', label: '4 · Points + Labels', run: demoPointsLabels },
  { id: '5', label: '5 · Volume (3D)', run: demoVolume },
  { id: '6', label: '6 · Surface (3D mesh)', run: demoSurface },
  { id: '7', label: '7 · Scatter (3D points)', run: demoScatter3d },
  { id: '8', label: '8 · Shapes (polygon rings)', run: demoShapes },
];

const select = document.getElementById('demo') as HTMLSelectElement;
for (const d of demoList) {
  const opt = document.createElement('option');
  opt.value = d.id;
  opt.textContent = d.label;
  select.appendChild(opt);
}

async function runById(id: string): Promise<void> {
  const def = demoList.find((d) => d.id === id);
  if (!def) return;
  select.value = id;
  await def.run();
}

select.addEventListener('change', () => void runById(select.value));
window.addEventListener('keydown', (e) => {
  if (demoList.some((d) => d.id === e.key)) void runById(e.key);
  else onKey?.(e);
});

void runById('1');
