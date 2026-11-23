/** An axis-aligned rectangle in level-0 (full-resolution) data coordinates. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A visible tile plus its rect in level-0 data coordinates (so the camera is uniform). */
export interface VisibleTile {
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Downsample factor of a pyramid level — level-0 units per level pixel. With `scales` it's the
 * explicit factor for `level` (arbitrary, non-power-of-two pyramids such as Bio-Formats); without
 * it the classic power-of-two default (level 0 = 1, level 1 = 2, …). `scales` is expected ascending
 * (level 0 finest = smallest factor).
 */
export function levelScale(level: number, scales?: readonly number[]): number {
  const s = scales?.[level];
  return s != null && s > 0 ? s : 2 ** level;
}

/** Pixel dimensions of a pyramid level. */
export function levelDims(
  width: number,
  height: number,
  level: number,
  scales?: readonly number[],
): { width: number; height: number } {
  const s = levelScale(level, scales);
  return { width: Math.max(1, Math.ceil(width / s)), height: Math.max(1, Math.ceil(height / s)) };
}

/** Tile grid (cols × rows) at a level. */
export function tileGrid(
  width: number,
  height: number,
  level: number,
  tileSize: number,
  scales?: readonly number[],
): { cols: number; rows: number } {
  const d = levelDims(width, height, level, scales);
  return { cols: Math.ceil(d.width / tileSize), rows: Math.ceil(d.height / tileSize) };
}

/**
 * Choose the pyramid level whose texels are ≈1 screen pixel for `zoom` (CSS px per level-0
 * unit). With `scales`, pick the coarsest level whose downsample factor doesn't under-sample the
 * screen (factor ≤ 1/zoom); without it, the power-of-two default (each halving of zoom steps one
 * level coarser). Clamped to `[0, levels-1]`.
 */
export function selectLevel(zoom: number, levels: number, scales?: readonly number[]): number {
  if (scales && scales.length) {
    const inv = 1 / Math.max(zoom, 1e-9); // level-0 units per screen pixel
    let best = 0;
    for (let l = 0; l < scales.length && l < levels; l++) {
      if (scales[l] <= inv) best = l;
      else break; // ascending → no finer-than-needed level beyond here
    }
    return Math.min(levels - 1, Math.max(0, best));
  }
  const raw = Math.floor(Math.log2(1 / Math.max(zoom, 1e-9)));
  return Math.min(levels - 1, Math.max(0, raw));
}

/** The level-0 data rectangle currently visible for a camera and CSS viewport size. */
export function worldViewport(
  centerX: number,
  centerY: number,
  zoom: number,
  vw: number,
  vh: number,
): Rect {
  const hw = vw / 2 / Math.max(zoom, 1e-9);
  const hh = vh / 2 / Math.max(zoom, 1e-9);
  return { x: centerX - hw, y: centerY - hh, width: 2 * hw, height: 2 * hh };
}

/** Options for {@link visibleTiles}. The defaults reproduce the plain row-major list. */
export interface VisibleTilesOptions {
  /**
   * `'row-major'` (default): top row first, left to right. `'center-out'`: nearest the
   * view's centre first (by grid-cell centre; ties keep row-major order), so a streaming
   * consumer that fetches in list order fills the middle of the screen first.
   */
  order?: 'row-major' | 'center-out';
  /**
   * Keep at most this many tiles, AFTER ordering — with `'center-out'`, the central ones.
   * Default: all of them.
   */
  limit?: number;
}

/**
 * Tiles of `level` that overlap `view` (level-0 coords), with each tile's rect in level-0
 * coords (edge tiles clipped to the image bounds). Empty when the view misses the image.
 * Row-major unless `opts` asks for centre-out order and/or a limit.
 */
export function visibleTiles(
  view: Rect,
  width: number,
  height: number,
  level: number,
  tileSize: number,
  scales?: readonly number[],
  opts: VisibleTilesOptions = {},
): VisibleTile[] {
  const tw = tileSize * levelScale(level, scales);
  const { cols, rows } = tileGrid(width, height, level, tileSize, scales);

  const x0 = Math.max(0, view.x);
  const y0 = Math.max(0, view.y);
  const x1 = Math.min(width, view.x + view.width);
  const y1 = Math.min(height, view.y + view.height);
  if (x1 <= x0 || y1 <= y0) return [];

  const c0 = Math.max(0, Math.floor(x0 / tw));
  const c1 = Math.min(cols - 1, Math.floor((x1 - 1e-6) / tw));
  const r0 = Math.max(0, Math.floor(y0 / tw));
  const r1 = Math.min(rows - 1, Math.floor((y1 - 1e-6) / tw));

  const tiles: VisibleTile[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const x = col * tw;
      const y = row * tw;
      tiles.push({ col, row, x, y, w: Math.min(tw, width - x), h: Math.min(tw, height - y) });
    }
  }
  if (opts.order === 'center-out') {
    // In tile units, from the UNCLIPPED view's centre: what the user is looking at.
    const cx = (view.x + view.width / 2) / tw;
    const cy = (view.y + view.height / 2) / tw;
    const d2 = (t: VisibleTile): number => (t.col + 0.5 - cx) ** 2 + (t.row + 0.5 - cy) ** 2;
    tiles.sort((a, b) => d2(a) - d2(b)); // stable: equal distances stay row-major
  }
  const limit = opts.limit;
  if (limit !== undefined && limit >= 0 && tiles.length > limit) tiles.length = Math.floor(limit);
  return tiles;
}

/** One tile of a pyramid level. */
export interface TileRef {
  level: number;
  col: number;
  row: number;
}

/** One draw of a tile: where it goes and which part of its texture fills it. */
export interface TileDraw extends TileRef {
  /** Destination, in level-0 coords. */
  rect: Rect;
  /** The part of the tile's texture drawn there: `[u0, v0, du, dv]`, in 0..1 of the tile. */
  uv: [number, number, number, number];
}

/** What to draw this frame, and what to fetch for the next. */
export interface TilePlan {
  draws: TileDraw[];
  fetch: TileRef[];
}

/** The level-0 rect of a tile (an edge tile clipped to the image). */
export function tileRect(
  ref: TileRef,
  width: number,
  height: number,
  tileSize: number,
  scales?: readonly number[],
): Rect {
  const tw = tileSize * levelScale(ref.level, scales);
  const x = ref.col * tw;
  const y = ref.row * tw;
  return { x, y, width: Math.min(tw, width - x), height: Math.min(tw, height - y) };
}

/**
 * The tiles to draw for a view at pyramid level `target`, and the tiles to fetch.
 *
 * Each target tile not yet loaded is filled from tiles already loaded at other levels, so a
 * zoom or pan shows the best resolution at hand instead of dropping to the coarsest level, or
 * to nothing:
 *
 *  1. the next finer level, when its tiles cover the target tile completely (zooming out);
 *  2. else the nearest coarser level whose tiles cover it completely (zooming in), down to the
 *     coarsest level, which is always fetched for the view so that something can fill in;
 *  3. else whatever finer tiles are loaded, leaving the rest blank until the target arrives.
 *
 * Each fallback is clipped to its target tile, so every point of the image is drawn by exactly
 * one draw: no double-counting under additive blending (one layer per channel), and no darker
 * seams under translucent ones.
 *
 * `fetch` lists the coarsest level's missing tiles first (few, and what everything falls back
 * to), then the target level's, nearest the view's centre first.
 */
export function planTiles(
  view: Rect,
  width: number,
  height: number,
  target: number,
  levels: number,
  tileSize: number,
  scales: readonly number[] | undefined,
  ready: (ref: TileRef) => boolean,
): TilePlan {
  const draws: TileDraw[] = [];
  const fetch: TileRef[] = [];
  const coarsest = levels - 1;

  /** The tiles of `level` that overlap `rect`. */
  const covering = (level: number, rect: Rect): TileRef[] =>
    visibleTiles(rect, width, height, level, tileSize, scales).map(({ col, row }) => ({
      level,
      col,
      row,
    }));
  /** `ref`'s part inside `dest`, or null for a sliver left by rounding. */
  const piece = (ref: TileRef, dest: Rect): TileDraw | null => {
    const a = tileRect(ref, width, height, tileSize, scales);
    const x0 = Math.max(a.x, dest.x);
    const y0 = Math.max(a.y, dest.y);
    const x1 = Math.min(a.x + a.width, dest.x + dest.width);
    const y1 = Math.min(a.y + a.height, dest.y + dest.height);
    const eps = 1e-6 * Math.max(a.width, a.height);
    if (x1 - x0 <= eps || y1 - y0 <= eps) return null;
    return {
      ...ref,
      rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
      uv: [(x0 - a.x) / a.width, (y0 - a.y) / a.height, (x1 - x0) / a.width, (y1 - y0) / a.height],
    };
  };
  const drawAll = (refs: TileRef[], dest: Rect): void => {
    for (const ref of refs) {
      const d = piece(ref, dest);
      if (d) draws.push(d);
    }
  };

  if (target !== coarsest) {
    for (const t of visibleTiles(view, width, height, coarsest, tileSize, scales)) {
      const ref = { level: coarsest, col: t.col, row: t.row };
      if (!ready(ref)) fetch.push(ref);
    }
  }

  const tiles = visibleTiles(view, width, height, target, tileSize, scales, {
    order: 'center-out',
  });
  for (const t of tiles) {
    const ref = { level: target, col: t.col, row: t.row };
    const rect = { x: t.x, y: t.y, width: t.w, height: t.h };
    if (ready(ref)) {
      draws.push({ ...ref, rect, uv: [0, 0, 1, 1] });
      continue;
    }
    fetch.push(ref);

    const finer = target > 0 ? covering(target - 1, rect) : [];
    if (finer.length && finer.every(ready)) {
      drawAll(finer, rect);
      continue;
    }
    let filled = false;
    for (let level = target + 1; level <= coarsest && !filled; level++) {
      const coarser = covering(level, rect);
      if (coarser.length && coarser.every(ready)) {
        drawAll(coarser, rect);
        filled = true;
      }
    }
    if (!filled) drawAll(finer.filter(ready), rect);
  }
  return { draws, fetch };
}
