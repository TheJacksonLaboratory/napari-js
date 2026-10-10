import type { RGBA } from '../layers/points-layer';

const hex = (r: number, g: number, b: number): RGBA => [r / 255, g / 255, b / 255, 1];

/**
 * The named colours {@link parseColor} knows: the CSS basic set (plus `orange`, `grey`,
 * `transparent`) and matplotlib's single-letter shorthands, which napari also accepts.
 */
const NAMED: Record<string, RGBA> = {
  black: hex(0, 0, 0),
  white: hex(255, 255, 255),
  red: hex(255, 0, 0),
  lime: hex(0, 255, 0),
  green: hex(0, 128, 0),
  blue: hex(0, 0, 255),
  yellow: hex(255, 255, 0),
  cyan: hex(0, 255, 255),
  aqua: hex(0, 255, 255),
  magenta: hex(255, 0, 255),
  fuchsia: hex(255, 0, 255),
  gray: hex(128, 128, 128),
  grey: hex(128, 128, 128),
  silver: hex(192, 192, 192),
  maroon: hex(128, 0, 0),
  olive: hex(128, 128, 0),
  purple: hex(128, 0, 128),
  teal: hex(0, 128, 128),
  navy: hex(0, 0, 128),
  orange: hex(255, 165, 0),
  transparent: [0, 0, 0, 0],
  // matplotlib base colours
  r: [1, 0, 0, 1],
  g: [0, 0.5, 0, 1],
  b: [0, 0, 1, 1],
  c: [0, 0.75, 0.75, 1],
  m: [0.75, 0, 0.75, 1],
  y: [0.75, 0.75, 0, 1],
  k: [0, 0, 0, 1],
  w: [1, 1, 1, 1],
};

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** One `rgb()` channel: a number 0..255 or a percentage. NaN when malformed. */
function channel(s: string): number {
  if (s.endsWith('%')) return clamp01(Number(s.slice(0, -1)) / 100);
  return s === '' ? NaN : clamp01(Number(s) / 255);
}

/** An alpha: a number 0..1 or a percentage. NaN when malformed. */
function alpha(s: string): number {
  if (s.endsWith('%')) return clamp01(Number(s.slice(0, -1)) / 100);
  return s === '' ? NaN : clamp01(Number(s));
}

/**
 * Parse a CSS-style colour into RGBA floats in 0..1 (napari's `transform_color` for one
 * colour), or null when it is not one. Accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
 * `rgb(r, g, b)` / `rgba(r, g, b, a)` (comma or space separated, `/ a` alpha, channels as
 * 0..255 or percentages, alpha as 0..1 or a percentage), and the basic named colours — CSS's
 * plus matplotlib's `r g b c m y k w`. Case and surrounding whitespace are ignored. Each caller
 * chooses its own fallback (`parseColor(s) ?? [1, 1, 1, 1]`). Pure.
 */
export function parseColor(css: string): RGBA | null {
  if (typeof css !== 'string') return null;
  const s = css.trim().toLowerCase();
  if (!s) return null;
  const named = NAMED[s];
  if (named) return [named[0], named[1], named[2], named[3]];

  if (s[0] === '#') {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const v = Array.from(h, (d) => parseInt(d + d, 16) / 255);
      return [v[0], v[1], v[2], v[3] ?? 1];
    }
    if (h.length === 6 || h.length === 8) {
      const v = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) / 255 : 1));
      return [v[0], v[1], v[2], v[3]];
    }
    return null;
  }

  const m = /^rgba?\(\s*(.*?)\s*\)$/.exec(s);
  if (!m) return null;
  let body = m[1];
  let a = '1';
  const slash = body.split('/');
  if (slash.length === 2) {
    body = slash[0].trim();
    a = slash[1].trim();
  } else if (slash.length > 2) return null;
  const parts = body.includes(',') ? body.split(',').map((p) => p.trim()) : body.split(/\s+/);
  if (parts.length === 4 && slash.length === 1) a = parts.pop()!;
  if (parts.length !== 3) return null;
  const out: RGBA = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha(a)];
  return out.every((v) => Number.isFinite(v)) ? out : null;
}
