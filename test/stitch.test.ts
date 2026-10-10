import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  chooseStitchLevel,
  readLevel,
  downscaleImage,
  DEFAULT_MAX_TEXTURE_DIM,
} from '../src/io/stitch';
import { assembleVolume } from '../src/io/volume';
import { rgbaToScalar, fitWithin, bitmapToScalar } from '../src/io/decode';
import { levelDims } from '../src/io/pyramid';
import type { PixelChunk, PixelDtype, TiledSource, TileKey } from '../src/io/texture-source';

/** Value of level-pixel (x, y) on slice z at `level` — distinct enough to catch misplacement. */
const pixel = (level: number, x: number, y: number, z: number): number =>
  (x * 7 + y * 13 + z * 31 + level * 3) % 251;

interface FakeOpts {
  width: number;
  height: number;
  tileSize: number;
  levels: number;
  levelScales?: number[];
  channels?: 1 | 4;
  dtype?: PixelDtype;
  /** Make every tile this many px larger than its level clip (a server that pads edges). */
  pad?: number;
  delay?: () => Promise<void>;
}

function fakeSource(o: FakeOpts) {
  const channels = o.channels ?? 1;
  const fetched: Array<TileKey & { signal?: AbortSignal }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const src: TiledSource = {
    kind: 'tiled',
    width: o.width,
    height: o.height,
    tileSize: o.tileSize,
    levels: o.levels,
    levelScales: o.levelScales,
    depth: 8,
    channels,
    dtype: o.dtype ?? 'uint8',
    async fetchTile(key: TileKey, signal?: AbortSignal): Promise<PixelChunk> {
      fetched.push({ ...key, signal });
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await (o.delay ? o.delay() : Promise.resolve());
        const d = levelDims(o.width, o.height, key.level, o.levelScales);
        const x0 = key.col * o.tileSize;
        const y0 = key.row * o.tileSize;
        const w = Math.min(o.tileSize, d.width - x0) + (o.pad ?? 0);
        const h = Math.min(o.tileSize, d.height - y0) + (o.pad ?? 0);
        const Ctor =
          o.dtype === 'uint16' ? Uint16Array : o.dtype === 'float32' ? Float32Array : Uint8Array;
        const data = new Ctor(w * h * channels);
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++)
            for (let c = 0; c < channels; c++)
              data[(y * w + x) * channels + c] = pixel(key.level, x0 + x, y0 + y, key.z) + c;
        return { width: w, height: h, data };
      } finally {
        inFlight--;
      }
    },
  };
  return { src, fetched, maxInFlight: () => maxInFlight };
}

describe('chooseStitchLevel', () => {
  const geom = { width: 4096, height: 2048, tileSize: 512, levels: 4 };

  it('picks the finest level within the tile budget', () => {
    // level 0: 8×4 = 32 tiles; level 1: 4×2 = 8; level 2: 2×1 = 2.
    expect(chooseStitchLevel(geom, { maxTiles: 32 })).toMatchObject({ level: 0, fits: true });
    expect(chooseStitchLevel(geom, { maxTiles: 31 })).toMatchObject({
      level: 1,
      width: 2048,
      height: 1024,
      cols: 4,
      rows: 2,
      fits: true,
    });
  });

  it('honours the texture limit', () => {
    expect(chooseStitchLevel(geom, { maxTiles: 1000, maxTextureDim: 2048 }).level).toBe(1);
    expect(DEFAULT_MAX_TEXTURE_DIM).toBe(8192);
  });

  it('falls back to the coarsest level, flagged, when nothing fits', () => {
    expect(chooseStitchLevel(geom, { maxTiles: 0 })).toMatchObject({ level: 3, fits: false });
  });

  it('skips levels finer than maxSide needs', () => {
    // 1000 px wanted of a 4096 px side: level 2 (1024) is the coarsest that still has it.
    expect(chooseStitchLevel(geom, { maxTiles: 1000, maxSide: 1000 }).level).toBe(2);
    expect(chooseStitchLevel(geom, { maxTiles: 1000, maxSide: 1024 }).level).toBe(2);
    expect(chooseStitchLevel(geom, { maxTiles: 1000, maxSide: 1025 }).level).toBe(1);
  });

  it('uses explicit non-power-of-two level scales', () => {
    const g = { ...geom, levels: 3, levelScales: [1, 3, 9] };
    const c = chooseStitchLevel(g, { maxTiles: 6 });
    expect(c).toMatchObject({ level: 1, width: 1366, height: 683, cols: 3, rows: 2 });
  });
});

describe('readLevel', () => {
  it('stitches a level with smaller edge tiles into the exact level image', async () => {
    const { src } = fakeSource({ width: 1300, height: 700, tileSize: 256, levels: 3 });
    // level 1: 650×350 → 3×2 tiles (edges 138 and 94 wide/high).
    const img = await readLevel(src, 2, { maxTiles: 6 });
    expect(img).toMatchObject({ kind: 'typed', width: 650, height: 350, level: 1, fits: true });
    expect(img.channels).toBe(1);
    expect(img.dtype).toBe('uint8');
    for (const [x, y] of [
      [0, 0],
      [255, 0],
      [256, 0],
      [649, 349],
      [300, 260],
    ]) {
      expect(img.data[y * 650 + x]).toBe(pixel(1, x, y, 2));
    }
  });

  it('clips tiles that are larger than the level (padded edges)', async () => {
    const { src } = fakeSource({ width: 300, height: 200, tileSize: 128, levels: 1, pad: 40 });
    const img = await readLevel(src, 0, { maxTiles: 100 });
    expect(img.width).toBe(300);
    expect(img.data[199 * 300 + 299]).toBe(pixel(0, 299, 199, 0));
    expect(img.data[0]).toBe(pixel(0, 0, 0, 0));
  });

  it('stitches RGBA sources and keeps their dtype', async () => {
    const { src } = fakeSource({ width: 20, height: 10, tileSize: 8, levels: 1, channels: 4 });
    const img = await readLevel(src, 0, { maxTiles: 100 });
    expect(img.channels).toBe(4);
    expect(img.data.length).toBe(20 * 10 * 4);
    const o = (9 * 20 + 17) * 4;
    expect(Array.from(img.data.slice(o, o + 4))).toEqual(
      [0, 1, 2, 3].map((c) => pixel(0, 17, 9, 0) + c),
    );
  });

  it('keeps no more than `concurrency` tile requests in flight', async () => {
    const f = fakeSource({
      width: 2048,
      height: 2048,
      tileSize: 256,
      levels: 1,
      delay: () => new Promise((r) => setTimeout(r, 1)),
    });
    await readLevel(f.src, 0, { maxTiles: 64, concurrency: 3 });
    expect(f.fetched).toHaveLength(64);
    expect(f.maxInFlight()).toBe(3);
  });

  it('box-downscales to maxSide', async () => {
    const { src } = fakeSource({ width: 512, height: 256, tileSize: 256, levels: 1 });
    const img = await readLevel(src, 0, { maxTiles: 10, maxSide: 128 });
    expect([img.width, img.height]).toEqual([128, 64]);
    // Output (0,0) averages the 4×4 block at the origin.
    let sum = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sum += pixel(0, x, y, 0);
    expect(img.data[0]).toBe(Math.round(sum / 16));
  });

  it('downscales to the texture limit even when no smaller level exists', async () => {
    const { src } = fakeSource({ width: 300, height: 100, tileSize: 100, levels: 1 });
    const img = await readLevel(src, 0, { maxTiles: 3, maxTextureDim: 150 });
    expect([img.width, img.height]).toEqual([150, 50]);
    expect(img.fits).toBe(false);
  });

  it('passes the signal to fetchTile and rejects when aborted mid-read', async () => {
    const ctrl = new AbortController();
    const f = fakeSource({
      width: 1024,
      height: 1024,
      tileSize: 128,
      levels: 1,
      delay: () => new Promise((r) => setTimeout(r, 2)),
    });
    const p = readLevel(f.src, 0, { maxTiles: 64, concurrency: 2, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 3);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.fetched.length).toBeLessThan(64);
    expect(f.fetched[0].signal).toBe(ctrl.signal);
    const after = f.fetched.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(f.fetched.length).toBe(after); // nothing new is requested after the abort
  });

  it('does not fetch at all when already aborted', async () => {
    const f = fakeSource({ width: 64, height: 64, tileSize: 32, levels: 1 });
    const ctrl = new AbortController();
    ctrl.abort(new Error('stop'));
    await expect(readLevel(f.src, 0, { maxTiles: 4, signal: ctrl.signal })).rejects.toThrow('stop');
    expect(f.fetched).toHaveLength(0);
  });

  it('rejects with a tile error', async () => {
    const { src } = fakeSource({ width: 64, height: 64, tileSize: 32, levels: 1 });
    src.fetchTile = () => Promise.reject(new Error('504'));
    await expect(readLevel(src, 0, { maxTiles: 4 })).rejects.toThrow('504');
  });

  describe('ImageBitmap tiles', () => {
    /** A stand-in bitmap: not a typed array, so readLevel hands it to `decode`. */
    const fakeBitmap = (w: number, h: number, rgb: [number, number, number]) => {
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.set([...rgb, 255], i * 4);
      return { width: w, height: h, rgba, close: vi.fn() };
    };
    type Fake = ReturnType<typeof fakeBitmap>;

    const bitmapSource = (channels: 1 | 4, dtype: PixelDtype = 'uint8') => {
      const made: Fake[] = [];
      const src: TiledSource = {
        kind: 'tiled',
        width: 16,
        height: 8,
        tileSize: 8,
        levels: 1,
        depth: 1,
        channels,
        dtype,
        fetchTile: async ({ col }) => {
          const b = fakeBitmap(8, 8, col === 0 ? [255, 0, 0] : [10, 10, 10]);
          made.push(b);
          return { width: 8, height: 8, data: b as unknown as ImageBitmap };
        },
      };
      const decode = (img: ImageBitmap) => {
        const b = img as unknown as Fake;
        return { data: b.rgba, width: b.width, height: b.height };
      };
      return { src, made, decode };
    };

    it('decodes to luminance for a single-channel source and closes each tile', async () => {
      const { src, made, decode } = bitmapSource(1);
      const img = await readLevel(src, 0, { maxTiles: 2, decode });
      expect(img.data[0]).toBe(Math.round(0.299 * 255)); // pure red, BT.601
      expect(img.data[8]).toBe(10); // gray maps to itself
      expect(made.every((b) => b.close.mock.calls.length === 1)).toBe(true);
    });

    it("takes the red channel with weights 'r', and leaves tiles open with closeTiles: false", async () => {
      const { src, made, decode } = bitmapSource(1);
      const img = await readLevel(src, 0, { maxTiles: 2, decode, weights: 'r', closeTiles: false });
      expect(img.data[0]).toBe(255);
      expect(made.some((b) => b.close.mock.calls.length > 0)).toBe(false);
    });

    it('keeps RGBA for a 4-channel source', async () => {
      const { src, decode } = bitmapSource(4);
      const img = await readLevel(src, 0, { maxTiles: 2, decode });
      expect(Array.from(img.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
    });

    it('refuses a bitmap tile for a uint16 source', async () => {
      const { src, decode } = bitmapSource(1, 'uint16');
      await expect(readLevel(src, 0, { maxTiles: 2, decode })).rejects.toThrow(/uint8 source/);
    });
  });
});

describe('downscaleImage', () => {
  it('area-averages and rounds integer dtypes', () => {
    const src = {
      kind: 'typed' as const,
      width: 4,
      height: 2,
      channels: 1 as const,
      dtype: 'uint8' as const,
      data: new Uint8Array([0, 1, 10, 20, 2, 4, 30, 41]),
    };
    const out = downscaleImage(src, 2, 1);
    expect(Array.from(out.data)).toEqual([2, 25]); // (0+1+2+4)/4 = 1.75, (10+20+30+41)/4 = 25.25
  });

  it('keeps float precision', () => {
    const src = {
      kind: 'typed' as const,
      width: 2,
      height: 1,
      channels: 1 as const,
      dtype: 'float32' as const,
      data: new Float32Array([0.25, 0.5]),
    };
    expect(downscaleImage(src, 1, 1).data[0]).toBeCloseTo(0.375);
  });

  it('returns the input when the target is not smaller', () => {
    const src = {
      kind: 'typed' as const,
      width: 2,
      height: 2,
      channels: 1 as const,
      dtype: 'uint8' as const,
      data: new Uint8Array(4),
    };
    expect(downscaleImage(src, 2, 2)).toBe(src);
  });
});

describe('decode helpers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('rgbaToScalar: bt601 maps gray to itself (no truncation to 254)', () => {
    const rgba = new Uint8Array([255, 255, 255, 255, 7, 7, 7, 255, 0, 255, 0, 255]);
    expect(Array.from(rgbaToScalar(rgba, 3, 1))).toEqual([255, 7, Math.round(0.587 * 255)]);
    expect(Array.from(rgbaToScalar(rgba, 3, 1, 'r'))).toEqual([255, 7, 0]);
    expect(() => rgbaToScalar(rgba, 4, 1)).toThrow(/expected 16/);
  });

  it('fitWithin caps the longest side', () => {
    expect(fitWithin(4000, 1000, 1000)).toEqual({ width: 1000, height: 250 });
    expect(fitWithin(100, 50, 1000)).toEqual({ width: 100, height: 50 });
    expect(fitWithin(100, 50)).toEqual({ width: 100, height: 50 });
  });

  it('bitmapToScalar draws the whole image scaled into maxSide, and leaves it open', () => {
    const draws: number[][] = [];
    class FakeOffscreen {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        const { width, height } = this;
        return {
          drawImage: (_i: unknown, x: number, y: number, w: number, h: number) =>
            draws.push([x, y, w, h]),
          getImageData: () => ({
            data: new Uint8ClampedArray(width * height * 4).fill(200),
          }),
        };
      }
    }
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
    const bmp = { width: 400, height: 200, close: vi.fn() };
    const plane = bitmapToScalar(bmp as unknown as ImageBitmap, { maxSide: 100 });
    expect([plane.width, plane.height]).toEqual([100, 50]);
    expect(draws).toEqual([[0, 0, 100, 50]]);
    expect(plane.data[0]).toBe(200);
    expect(bmp.close).not.toHaveBeenCalled();
  });
});

describe('assembleVolume', () => {
  it('stacks the requested slices in order at the shared level size', async () => {
    const { src } = fakeSource({ width: 1024, height: 512, tileSize: 256, levels: 3 });
    const progress: Array<[number, number]> = [];
    const vol = await assembleVolume(src, [0, 2, 4], {
      maxSide: 256,
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect([vol.width, vol.height, vol.depth]).toEqual([256, 128, 3]);
    expect(vol.data.length).toBe(256 * 128 * 3);
    // maxSide 256 of 1024 → level 2 (256×128) is read as-is.
    const plane = 256 * 128;
    expect(vol.data[0 * plane + 5]).toBe(pixel(2, 5, 0, 0));
    expect(vol.data[1 * plane + 5]).toBe(pixel(2, 5, 0, 2));
    expect(vol.data[2 * plane + 1 * 256 + 130]).toBe(pixel(2, 130, 1, 4));
    expect(progress.map((p) => p[0])).toEqual([1, 2, 3]);
    expect(progress.every((p) => p[1] === 3)).toBe(true);
  });

  it('bounds the slices in flight', async () => {
    let inFlight = 0;
    let max = 0;
    const { src } = fakeSource({ width: 64, height: 64, tileSize: 64, levels: 1 });
    const inner = src.fetchTile.bind(src);
    src.fetchTile = async (k, s) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await inner(k, s);
      } finally {
        inFlight--;
      }
    };
    await assembleVolume(src, [0, 1, 2, 3, 4, 5, 6, 7], { maxSide: 64, concurrency: 2 });
    expect(max).toBe(2);
  });

  it('windows uint16 slices into uint8 by contrastLimits', async () => {
    const { src } = fakeSource({ width: 4, height: 1, tileSize: 4, levels: 1, dtype: 'uint16' });
    src.fetchTile = async () => ({
      width: 4,
      height: 1,
      data: new Uint16Array([0, 100, 200, 400]),
    });
    const vol = await assembleVolume(src, [0], { maxSide: 4, contrastLimits: [100, 300] });
    expect(Array.from(vol.data)).toEqual([0, 0, 128, 255]);
  });

  it('reduces RGBA slices by luminance', async () => {
    const { src } = fakeSource({ width: 2, height: 1, tileSize: 2, levels: 1, channels: 4 });
    src.fetchTile = async () => ({
      width: 2,
      height: 1,
      data: new Uint8Array([255, 255, 255, 255, 0, 0, 255, 255]),
    });
    const vol = await assembleVolume(src, [0], { maxSide: 2 });
    expect(Array.from(vol.data)).toEqual([255, Math.round(0.114 * 255)]);
  });

  it('rejects when aborted, without requesting further slices', async () => {
    const ctrl = new AbortController();
    const f = fakeSource({
      width: 64,
      height: 64,
      tileSize: 64,
      levels: 1,
      delay: () => new Promise((r) => setTimeout(r, 2)),
    });
    const p = assembleVolume(f.src, [0, 1, 2, 3, 4, 5, 6, 7], {
      maxSide: 64,
      concurrency: 1,
      signal: ctrl.signal,
    });
    setTimeout(() => ctrl.abort(), 3);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.fetched.length).toBeLessThan(8);
  });
});
