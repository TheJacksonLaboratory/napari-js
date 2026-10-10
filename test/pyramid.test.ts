import { describe, it, expect } from 'vitest';
import { selectLevel, levelDims, tileGrid, visibleTiles, worldViewport } from '../src/io/pyramid';

describe('selectLevel', () => {
  it('uses level 0 when zoomed in (≥ 1:1)', () => {
    expect(selectLevel(1, 5)).toBe(0);
    expect(selectLevel(4, 5)).toBe(0);
  });

  it('steps coarser as zoom halves', () => {
    expect(selectLevel(0.5, 5)).toBe(1);
    expect(selectLevel(0.25, 5)).toBe(2);
    expect(selectLevel(0.125, 5)).toBe(3);
  });

  it('clamps to the coarsest available level', () => {
    expect(selectLevel(0.001, 3)).toBe(2);
  });
});

describe('levelDims', () => {
  it('halves per level, rounding up, min 1', () => {
    expect(levelDims(1024, 768, 0)).toEqual({ width: 1024, height: 768 });
    expect(levelDims(1024, 768, 1)).toEqual({ width: 512, height: 384 });
    expect(levelDims(1025, 1, 1)).toEqual({ width: 513, height: 1 });
    expect(levelDims(1, 1, 8)).toEqual({ width: 1, height: 1 });
  });
});

describe('tileGrid', () => {
  it('counts tiles per level', () => {
    expect(tileGrid(1024, 1024, 0, 256)).toEqual({ cols: 4, rows: 4 });
    expect(tileGrid(1024, 1024, 1, 256)).toEqual({ cols: 2, rows: 2 });
    expect(tileGrid(513, 256, 0, 256)).toEqual({ cols: 3, rows: 1 });
  });
});

describe('visibleTiles', () => {
  it('returns tiles overlapping the view, in level-0 coords', () => {
    // Level 0, 256px tiles, view covering the top-left 300×300 → tiles (0,0),(1,0),(0,1),(1,1).
    const tiles = visibleTiles({ x: 0, y: 0, width: 300, height: 300 }, 1024, 1024, 0, 256);
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toMatchObject({ col: 0, row: 0, x: 0, y: 0, w: 256, h: 256 });
  });

  it('clips edge tiles to the image bounds', () => {
    // 600px wide, 256 tiles → last col is 600-512 = 88px wide.
    const tiles = visibleTiles({ x: 500, y: 0, width: 200, height: 100 }, 600, 100, 0, 256);
    const last = tiles.find((t) => t.col === 2);
    expect(last).toBeDefined();
    expect(last!.w).toBe(600 - 512);
  });

  it('scales tile extents by the level factor', () => {
    // Level 1: each tile covers 256*2 = 512 level-0 units.
    const tiles = visibleTiles({ x: 0, y: 0, width: 10, height: 10 }, 2048, 2048, 1, 256);
    expect(tiles[0]).toMatchObject({ col: 0, row: 0, x: 0, y: 0, w: 512, h: 512 });
  });

  it('returns nothing when the view misses the image', () => {
    expect(visibleTiles({ x: -500, y: -500, width: 100, height: 100 }, 1024, 1024, 0, 256)).toEqual(
      [],
    );
  });
});

describe('arbitrary (non-power-of-two) level scales', () => {
  // A Bio-Formats-style pyramid: full res, then 4× and 16× downsamples (not 2×).
  const scales = [1, 4, 16];

  it('selectLevel picks the coarsest level that does not under-sample', () => {
    expect(selectLevel(1, 3, scales)).toBe(0); // 1/zoom=1 → only level 0 (scale 1) fits
    expect(selectLevel(0.25, 3, scales)).toBe(1); // 1/zoom=4 → level 1 (scale 4)
    expect(selectLevel(1 / 16, 3, scales)).toBe(2); // 1/zoom=16 → level 2 (scale 16)
    expect(selectLevel(1 / 64, 3, scales)).toBe(2); // beyond coarsest → clamp to last
  });

  it('levelDims / tileGrid use the explicit factor', () => {
    expect(levelDims(2048, 2048, 1, scales)).toEqual({ width: 512, height: 512 }); // 2048/4
    expect(tileGrid(2048, 2048, 1, 256, scales)).toEqual({ cols: 2, rows: 2 });
  });

  it('visibleTiles scales tile extents by the explicit factor', () => {
    // Level 1 (4×): each 256px tile covers 256*4 = 1024 level-0 units.
    const tiles = visibleTiles({ x: 0, y: 0, width: 10, height: 10 }, 2048, 2048, 1, 256, scales);
    expect(tiles[0]).toMatchObject({ col: 0, row: 0, x: 0, y: 0, w: 1024, h: 1024 });
  });
});

describe('worldViewport', () => {
  it('is centered on the camera and scales inversely with zoom', () => {
    expect(worldViewport(100, 50, 2, 800, 600)).toEqual({
      x: 100 - 200,
      y: 50 - 150,
      width: 400,
      height: 300,
    });
  });
});

describe('visibleTiles options', () => {
  // A 4×4 grid of 100-px tiles, fully in view.
  const all = { x: 0, y: 0, width: 400, height: 400 };
  const key = (t: { col: number; row: number }): string => `${t.col},${t.row}`;

  it('defaults to the unchanged row-major list', () => {
    const plain = visibleTiles(all, 400, 400, 0, 100);
    expect(visibleTiles(all, 400, 400, 0, 100, undefined, {})).toEqual(plain);
    expect(visibleTiles(all, 400, 400, 0, 100, undefined, { order: 'row-major' })).toEqual(plain);
    expect(plain.map(key).slice(0, 5)).toEqual(['0,0', '1,0', '2,0', '3,0', '0,1']);
  });

  it("'center-out' puts the tiles nearest the view centre first, ties row-major", () => {
    const tiles = visibleTiles(all, 400, 400, 0, 100, undefined, { order: 'center-out' });
    expect(tiles).toHaveLength(16);
    // The four central tiles, equidistant from (200, 200), in row-major order.
    expect(tiles.slice(0, 4).map(key)).toEqual(['1,1', '2,1', '1,2', '2,2']);
    // Corners last.
    expect(tiles.slice(12).map(key).sort()).toEqual(['0,0', '0,3', '3,0', '3,3']);
    // Same set as row-major.
    expect(tiles.map(key).sort()).toEqual(visibleTiles(all, 400, 400, 0, 100).map(key).sort());
  });

  it('centres on the unclipped view, so a view hanging off the image orders from its middle', () => {
    // View centred at (350, 50): the top-right tile first.
    const view = { x: 150, y: -150, width: 400, height: 400 };
    const tiles = visibleTiles(view, 400, 400, 0, 100, undefined, { order: 'center-out' });
    expect(key(tiles[0])).toBe('3,0');
  });

  it('limit keeps the first N after ordering', () => {
    const near = visibleTiles(all, 400, 400, 0, 100, undefined, { order: 'center-out', limit: 4 });
    expect(near.map(key)).toEqual(['1,1', '2,1', '1,2', '2,2']);
    const firstRow = visibleTiles(all, 400, 400, 0, 100, undefined, { limit: 3 });
    expect(firstRow.map(key)).toEqual(['0,0', '1,0', '2,0']);
    expect(visibleTiles(all, 400, 400, 0, 100, undefined, { limit: 0 })).toEqual([]);
    expect(visibleTiles(all, 400, 400, 0, 100, undefined, { limit: 99 })).toHaveLength(16);
  });

  it('works on coarser levels in level-0 coordinates', () => {
    // Level 1: 200-px tiles over a 800×800 image; view centred at (500, 300).
    const view = { x: 300, y: 100, width: 400, height: 400 };
    const tiles = visibleTiles(view, 800, 800, 1, 100, undefined, { order: 'center-out' });
    expect(key(tiles[0])).toBe('2,1');
    expect(tiles[0]).toMatchObject({ x: 400, y: 200, w: 200, h: 200 });
  });
});
