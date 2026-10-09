/**
 * Point marker symbols: napari's names, their numeric codes, and a CPU reference of the
 * shapes the points shader draws.
 *
 * The CODE of a symbol is its index in {@link POINT_SYMBOLS}. Codes are what a per-point
 * `symbols` array carries and what reaches the shader, so the order is part of the API:
 * new symbols are only ever appended. `disc`, `ring` and `square` keep the codes 0, 1, 2
 * they had when they were the only three.
 */

/**
 * Every marker symbol, in code order. The first fourteen are napari's `Symbol` enum
 * (`napari.layers.points._points_constants.Symbol`); `hexagon` and `pentagon` are
 * napari-js additions — not in napari, but common categorical glyphs.
 */
export const POINT_SYMBOLS = [
  'disc',
  'ring',
  'square',
  'diamond',
  'star',
  'cross',
  'x',
  'triangle_up',
  'triangle_down',
  'arrow',
  'tailed_arrow',
  'hbar',
  'vbar',
  'clobber',
  'hexagon',
  'pentagon',
] as const;

/** A marker symbol name; see {@link POINT_SYMBOLS}. */
export type PointSymbol = (typeof POINT_SYMBOLS)[number];

/** napari's single-character symbol aliases (`SYMBOL_ALIAS`), resolved to the full name. */
export const POINT_SYMBOL_ALIASES = {
  o: 'disc',
  s: 'square',
  d: 'diamond',
  '*': 'star',
  '+': 'cross',
  '^': 'triangle_up',
  v: 'triangle_down',
  '>': 'arrow',
  '->': 'tailed_arrow',
  '-': 'hbar',
  '|': 'vbar',
} as const satisfies Record<string, PointSymbol>;

/** An alias napari accepts for a symbol name, e.g. `'o'` for `'disc'`. */
export type PointSymbolAlias = keyof typeof POINT_SYMBOL_ALIASES;

/**
 * The per-point code meaning "draw this point with the layer's {@link PointsLayer.symbol}".
 * Lets a per-point array override only some points, and lets the layer symbol stay a live
 * setter for the rest.
 */
export const POINT_SYMBOL_LAYER_DEFAULT = 255;

const CODES = new Map<string, number>(POINT_SYMBOLS.map((s, i) => [s, i]));

/** Resolve a symbol name or napari alias to its canonical name; throws on an unknown one. */
export function resolvePointSymbol(symbol: PointSymbol | PointSymbolAlias): PointSymbol {
  if (CODES.has(symbol)) return symbol as PointSymbol;
  const alias = (POINT_SYMBOL_ALIASES as Record<string, PointSymbol>)[symbol];
  if (alias) return alias;
  throw new Error(
    `Unknown point symbol '${String(symbol)}'. Expected one of: ${POINT_SYMBOLS.join(', ')}.`,
  );
}

/**
 * The numeric code of a symbol name or napari alias — what to put in a per-point `symbols`
 * array. Throws on an unknown name.
 */
export function pointSymbolCode(symbol: PointSymbol | PointSymbolAlias): number {
  return CODES.get(resolvePointSymbol(symbol))!;
}

/**
 * Validate a per-point code array, so a bad code surfaces at the assignment rather than as a
 * marker the shader silently draws as a disc.
 */
export function checkPointSymbols(codes: Uint8Array, count: number): Uint8Array {
  if (!(codes instanceof Uint8Array)) {
    throw new Error('Points symbols must be a Uint8Array of symbol codes.');
  }
  if (codes.length !== count) {
    throw new Error(`Points symbols length (${codes.length}) must equal point count (${count}).`);
  }
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c >= POINT_SYMBOLS.length && c !== POINT_SYMBOL_LAYER_DEFAULT) {
      throw new Error(
        `Points symbols[${i}] = ${c} is not a symbol code (0..${POINT_SYMBOLS.length - 1}, ` +
          `or ${POINT_SYMBOL_LAYER_DEFAULT} for the layer symbol).`,
      );
    }
  }
  return codes;
}

/** Half-width of the arms of `cross`, `x`, `hbar` and `vbar`, in marker radii. */
export const SYMBOL_ARM = 0.3;
/** Inner radius of the five-pointed `star`, in marker radii. */
export const SYMBOL_STAR_INNER = 0.45;

const SQRT1_2 = Math.SQRT1_2;

function sdBox(x: number, y: number, bx: number, by: number): number {
  const qx = Math.abs(x) - bx;
  const qy = Math.abs(y) - by;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
}

/** Regular n-gon, circumradius 1, a vertex on +y (down on screen); flip y to point it up. */
function sdNgon(x: number, y: number, n: number): number {
  const an = Math.PI / n;
  const ax = Math.cos(an);
  const ay = Math.sin(an);
  const a = Math.atan2(x, y);
  const period = 2 * an;
  const bn = a - period * Math.floor(a / period) - an;
  const len = Math.hypot(x, y);
  const qx = len * Math.cos(bn) - ax;
  let qy = len * Math.abs(Math.sin(bn)) - ay;
  qy += Math.min(Math.max(-qy, 0), ay);
  return Math.hypot(qx, qy) * Math.sign(qx);
}

function sdStar5(x: number, y: number, rf: number): number {
  const k1x = 0.809016994375;
  const k1y = -0.587785252292;
  let px = Math.abs(x);
  let py = -y; // flip, so the top point is up on screen
  let t = 2 * Math.max(k1x * px + k1y * py, 0);
  px -= t * k1x;
  py -= t * k1y;
  t = 2 * Math.max(-k1x * px + k1y * py, 0);
  px -= t * -k1x;
  py -= t * k1y;
  px = Math.abs(px);
  py -= 1;
  const bax = rf * -k1y;
  const bay = rf * k1x - 1;
  const h = Math.min(Math.max((px * bax + py * bay) / (bax * bax + bay * bay), 0), 1);
  return Math.hypot(px - bax * h, py - bay * h) * Math.sign(py * bax - px * bay);
}

const sdDiamond = (x: number, y: number): number => (Math.abs(x) + Math.abs(y) - 1) * SQRT1_2;
const sdCross = (x: number, y: number): number =>
  Math.min(sdBox(x, y, 1, SYMBOL_ARM), sdBox(x, y, SYMBOL_ARM, 1));
const sdArrow = (x: number, y: number): number => Math.max(sdDiamond(x, y), -sdDiamond(x + 1, y));

/**
 * CPU reference of the marker shape the points shader draws for symbol `code`, at `(x, y)` in
 * marker-local units: the marker's radius is 1 and +y is DOWN on screen (the 2D camera's
 * convention), so `triangle_up` points to -y.
 *
 * Returns `1 + sdf`: below 1 is inside, 1 is the edge, and it grows with Euclidean distance,
 * so the border band `[1 - borderFrac, 1]` has the same thickness on every shape. `disc`/`ring`
 * and `square` keep their original expressions (`length`, `max(|x|, |y|)`), which equal
 * `1 + sdf` inside the marker. Mirrors `symbolDistance` in points-shader.ts — change both.
 */
export function pointSymbolDistance(code: number, x: number, y: number): number {
  switch (code) {
    case 0: // disc
    case 1: // ring
      return Math.hypot(x, y);
    case 2: // square
      return Math.max(Math.abs(x), Math.abs(y));
    case 3: // diamond
      return 1 + sdDiamond(x, y);
    case 4: // star
      return 1 + sdStar5(x, y, SYMBOL_STAR_INNER);
    case 5: // cross
      return 1 + sdCross(x, y);
    case 6: // x
      return 1 + sdCross((x + y) * SQRT1_2, (y - x) * SQRT1_2);
    case 7: // triangle_up
      return 1 + sdNgon(x, -y, 3);
    case 8: // triangle_down
      return 1 + sdNgon(x, y, 3);
    case 9: // arrow
      return 1 + sdArrow(x, y);
    case 10: // tailed_arrow
      return 1 + Math.min(sdArrow(x, y), sdBox(x + 0.5, y, 0.5, SYMBOL_ARM * 0.6));
    case 11: // hbar
      return 1 + sdBox(x, y, 1, SYMBOL_ARM);
    case 12: // vbar
      return 1 + sdBox(x, y, SYMBOL_ARM, 1);
    case 13: {
      // clobber: three discs of radius 0.64, centres 0.36 out, one lobe up.
      const c = 0.36;
      const r = 0.64;
      const s = Math.sqrt(3) / 2;
      return (
        1 +
        Math.min(
          Math.hypot(x, y + c) - r,
          Math.hypot(x - c * s, y - c * 0.5) - r,
          Math.hypot(x + c * s, y - c * 0.5) - r,
        )
      );
    }
    case 14: // hexagon, flat top: vertices on ±x
      return 1 + sdNgon(y, x, 6);
    case 15: // pentagon, a vertex up
      return 1 + sdNgon(x, -y, 5);
    default:
      return Math.hypot(x, y);
  }
}
