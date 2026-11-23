import { describe, it, expect } from 'vitest';
// Through the package entry, as a consumer imports them.
import { planTiles, tileRect, type TileDraw, type TileRef } from '../src';

// A 1024² image in 256 px tiles: level 0 is 4×4 tiles, level 1 2×2, level 2 one tile.
const W = 1024;
const H = 1024;
const TS = 256;
const LEVELS = 3;
const key = (r: TileRef) => `${r.level}:${r.col}:${r.row}`;
const readyOf = (refs: TileRef[]) => {
  const set = new Set(refs.map(key));
  return (r: TileRef) => set.has(key(r));
};
const all = (level: number): TileRef[] => {
  const n = 4 / 2 ** level;
  const out: TileRef[] = [];
  for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) out.push({ level, col, row });
  return out;
};
const whole = { x: 0, y: 0, width: W, height: H };
const plan = (target: number, ready: (r: TileRef) => boolean, view = whole) =>
  planTiles(view, W, H, target, LEVELS, TS, undefined, ready);

/** How many draws cover each point of a grid over `area` (cell centres). */
function coverage(draws: TileDraw[], area = whole, step = 32): number[] {
  const counts: number[] = [];
  for (let y = area.y + step / 2; y < area.y + area.height; y += step) {
    for (let x = area.x + step / 2; x < area.x + area.width; x += step) {
      counts.push(
        draws.filter(
          (d) =>
            x >= d.rect.x &&
            x < d.rect.x + d.rect.width &&
            y >= d.rect.y &&
            y < d.rect.y + d.rect.height,
        ).length,
      );
    }
  }
  return counts;
}

describe('planTiles', () => {
  it('draws the target tiles whole once they are loaded', () => {
    const p = plan(0, readyOf([...all(0), ...all(2)]));
    expect(p.draws).toHaveLength(16);
    expect(p.draws.every((d) => d.level === 0 && d.uv.join() === '0,0,1,1')).toBe(true);
    expect(p.fetch).toEqual([]);
  });

  it('zooming in: fills each missing tile with its part of the loaded coarser tile', () => {
    // Level 1 loaded, level 0 not: every level-0 tile shows a quarter of a level-1 tile.
    const p = plan(0, readyOf(all(1)));
    expect(p.draws).toHaveLength(16);
    const d = p.draws.find((t) => t.rect.x === 256 && t.rect.y === 0)!;
    expect(d).toMatchObject({ level: 1, col: 0, row: 0, uv: [0.5, 0, 0.5, 0.5] });
    expect(d.rect).toEqual({ x: 256, y: 0, width: 256, height: 256 });
    expect(coverage(p.draws).every((n) => n === 1)).toBe(true);
  });

  it('uses the nearest coarser level loaded, not the coarsest', () => {
    const p = plan(0, readyOf([...all(1), ...all(2)]));
    expect(new Set(p.draws.map((d) => d.level))).toEqual(new Set([1]));
  });

  it('falls back to the coarsest level when nothing nearer is loaded', () => {
    const p = plan(0, readyOf(all(2)));
    expect(p.draws).toHaveLength(16);
    expect(p.draws.every((d) => d.level === 2)).toBe(true);
    expect(coverage(p.draws).every((n) => n === 1)).toBe(true);
  });

  it('zooming out: draws the loaded finer tiles that cover a missing tile', () => {
    const p = plan(1, readyOf(all(0)));
    expect(p.draws).toHaveLength(16);
    expect(p.draws.every((d) => d.level === 0 && d.uv.join() === '0,0,1,1')).toBe(true);
  });

  it('mixes loaded target tiles and fallbacks without overlap', () => {
    // Half the level-0 tiles loaded, the coarsest level too.
    const half = all(0).filter((r) => (r.col + r.row) % 2 === 0);
    const p = plan(0, readyOf([...half, ...all(2)]));
    expect(coverage(p.draws).every((n) => n === 1)).toBe(true);
    expect(p.draws.filter((d) => d.level === 0)).toHaveLength(8);
    expect(p.draws.filter((d) => d.level === 2)).toHaveLength(8);
  });

  it('never draws a point twice, whatever is loaded', () => {
    // Additive layers (one per channel) would show a point drawn twice brighter.
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 200; trial++) {
      const loaded = [...all(0), ...all(1), ...all(2)].filter(() => rnd() < 0.5);
      const target = Math.floor(rnd() * LEVELS);
      const view = {
        x: rnd() * 600 - 100,
        y: rnd() * 600 - 100,
        width: 200 + rnd() * 600,
        height: 200 + rnd() * 600,
      };
      const p = plan(target, readyOf(loaded), view);
      expect(coverage(p.draws).every((n) => n <= 1)).toBe(true);
    }
  });

  it('draws only the loaded finer tiles when no coarser level covers a missing tile', () => {
    const p = plan(1, readyOf([{ level: 0, col: 0, row: 0 }]), {
      x: 0,
      y: 0,
      width: 512,
      height: 512,
    });
    expect(p.draws).toEqual([
      { level: 0, col: 0, row: 0, rect: { x: 0, y: 0, width: 256, height: 256 }, uv: [0, 0, 1, 1] },
    ]);
  });

  it('fetches the coarsest tiles first, then the target ones from the centre out', () => {
    const p = plan(0, () => false, { x: 256, y: 256, width: 512, height: 512 });
    expect(p.draws).toEqual([]);
    expect(p.fetch[0]).toEqual({ level: 2, col: 0, row: 0 });
    expect(p.fetch.slice(1).map((r) => r.level)).toEqual([0, 0, 0, 0]);
    expect(p.fetch).toHaveLength(5);
  });

  it('clips a coarser edge tile to the image, mapping its texture to the part drawn', () => {
    // 1000 px wide: the last level-1 tile holds 488 px (488 level-0 units at scale 2 → 244 texels).
    const p = planTiles(
      { x: 768, y: 0, width: 232, height: 256 },
      1000,
      1024,
      0,
      LEVELS,
      TS,
      undefined,
      readyOf([{ level: 1, col: 1, row: 0 }]),
    );
    expect(p.draws).toHaveLength(1);
    const d = p.draws[0];
    const a = tileRect(d, 1000, 1024, TS);
    expect(a).toEqual({ x: 512, y: 0, width: 488, height: 512 });
    expect(d.rect).toEqual({ x: 768, y: 0, width: 232, height: 256 });
    expect(d.uv[0]).toBeCloseTo(256 / 488);
    expect(d.uv[2]).toBeCloseTo(232 / 488);
  });

  it('needs every coarser tile a missing tile straddles (non-power-of-two levels)', () => {
    // Level 1 downsamples by 2.5: its tiles are 640 units wide, so level-0 tile 2 (512–768)
    // straddles level-1 tiles 0 and 1.
    const scales = [1, 2.5];
    const view = { x: 0, y: 0, width: 1024, height: 256 };
    const run = (ready: TileRef[]) =>
      planTiles(view, 2048, 1024, 0, 2, TS, scales, readyOf(ready)).draws.sort(
        (a, b) => a.rect.x - b.rect.x || a.col - b.col,
      );

    // Only the first: tiles 0 and 1 fill from it, tile 2 waits (half of it would be blank).
    expect(run([{ level: 1, col: 0, row: 0 }]).map((d) => d.rect.x)).toEqual([0, 256]);

    // Both: tile 2 is drawn in two pieces that meet at 640, and nothing overlaps.
    const both = run([
      { level: 1, col: 0, row: 0 },
      { level: 1, col: 1, row: 0 },
    ]);
    const tile2 = both.filter((d) => d.rect.x >= 512 && d.rect.x < 768);
    expect(tile2.map((d) => [d.col, d.rect.x, d.rect.width])).toEqual([
      [0, 512, 128],
      [1, 640, 128],
    ]);
    expect(coverage(both, view).every((n) => n === 1)).toBe(true);
  });
});
