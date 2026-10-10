import { describe, it, expect } from 'vitest';
import { PointsLayer } from '../src/layers/points-layer';
import {
  POINT_SYMBOLS,
  POINT_SYMBOL_ALIASES,
  POINT_SYMBOL_LAYER_DEFAULT,
  SYMBOL_ARM,
  SYMBOL_STAR_INNER,
  pointSymbolCode,
  pointSymbolDistance,
  resolvePointSymbol,
} from '../src/layers/point-symbols';
import { packPointsUniforms, POINTS_UNIFORM_FLOATS } from '../src/visuals/points-visual';
import { POINTS_SHADER } from '../src/visuals/points-shader';
import { identity } from '../src/math/mat4';

const PTS = new Float32Array([0, 0, 10, 0, 20, 0]);
const code = pointSymbolCode;

describe('point symbol codes', () => {
  it("covers napari's Symbol enum, plus hexagon and pentagon", () => {
    const napari = [
      'arrow',
      'clobber',
      'cross',
      'diamond',
      'disc',
      'hbar',
      'ring',
      'square',
      'star',
      'tailed_arrow',
      'triangle_down',
      'triangle_up',
      'vbar',
      'x',
    ];
    expect([...POINT_SYMBOLS].sort()).toEqual([...napari, 'hexagon', 'pentagon'].sort());
    expect(new Set(POINT_SYMBOLS).size).toBe(POINT_SYMBOLS.length);
  });

  it('keeps the original three codes (disc 0, ring 1, square 2)', () => {
    expect([code('disc'), code('ring'), code('square')]).toEqual([0, 1, 2]);
    POINT_SYMBOLS.forEach((s, i) => expect(code(s)).toBe(i));
    expect(POINT_SYMBOLS.length).toBeLessThan(POINT_SYMBOL_LAYER_DEFAULT);
  });

  it("resolves napari's aliases and rejects unknown names", () => {
    expect(resolvePointSymbol('o')).toBe('disc');
    expect(code('+')).toBe(code('cross'));
    expect(code('^')).toBe(code('triangle_up'));
    expect(code('v')).toBe(code('triangle_down'));
    expect(code('->')).toBe(code('tailed_arrow'));
    for (const target of Object.values(POINT_SYMBOL_ALIASES)) {
      expect(POINT_SYMBOLS).toContain(target);
    }
    expect(() => code('circle' as never)).toThrow(/Unknown point symbol 'circle'/);
  });
});

describe('PointsLayer symbols', () => {
  it('takes a layer symbol by name or alias, as a live setter', () => {
    const p = new PointsLayer(PTS, { symbol: '*' });
    expect(p.symbol).toBe('star');
    expect(p.symbolCode()).toBe(code('star'));
    let emitted = 0;
    p.changed.connect(() => emitted++);
    const v = p.dataVersion;
    p.symbol = 'hexagon';
    expect(p.symbolCode()).toBe(14);
    expect(emitted).toBe(1);
    // A uniform: the instance buffer does not change.
    expect(p.dataVersion).toBe(v);
    expect(() => {
      p.symbol = 'blob' as never;
    }).toThrow(/Unknown point symbol/);
    expect(p.symbol).toBe('hexagon');
  });

  it('packs per-point codes into the instance symbol slot, -1 for the layer default', () => {
    const symbols = new Uint8Array([code('star'), POINT_SYMBOL_LAYER_DEFAULT, code('x')]);
    const p = new PointsLayer(PTS, { symbol: 'diamond', symbols });
    const d = p.buildInstanceData();
    expect(d.length).toBe(3 * 12);
    expect([d[11], d[23], d[35]]).toEqual([4, -1, 6]);
    expect([0, 1, 2].map((i) => p.symbolCodeAt(i))).toEqual([4, 3, 6]);
    // No per-point array: every slot defers to the layer.
    const plain = new PointsLayer(PTS, { symbol: 'ring' }).buildInstanceData();
    expect([plain[11], plain[23], plain[35]]).toEqual([-1, -1, -1]);
  });

  it('per-point symbols are settable, bump dataVersion, and are kept by reference', () => {
    const p = new PointsLayer(PTS);
    expect(p.symbols).toBeNull();
    let emitted = 0;
    p.changed.connect(() => emitted++);
    const v = p.dataVersion;
    const codes = new Uint8Array([1, 2, 3]);
    p.symbols = codes;
    expect(p.symbols).toBe(codes);
    expect(p.dataVersion).toBe(v + 1);
    p.symbols = null;
    expect(p.dataVersion).toBe(v + 2);
    expect(emitted).toBe(2);
    expect(p.buildInstanceData()[11]).toBe(-1);
  });

  it('rejects a wrong length or an unknown code, leaving the old value', () => {
    expect(() => new PointsLayer(PTS, { symbols: new Uint8Array(2) })).toThrow(
      /symbols length \(2\) must equal point count \(3\)/,
    );
    expect(() => new PointsLayer(PTS, { symbols: new Uint8Array([0, 16, 0]) })).toThrow(
      /symbols\[1\] = 16 is not a symbol code/,
    );
    const p = new PointsLayer(PTS, { symbols: new Uint8Array([0, 1, 2]) });
    expect(() => {
      p.symbols = new Uint8Array([0, 0, 200]);
    }).toThrow(/symbols\[2\]/);
    expect(Array.from(p.symbols!)).toEqual([0, 1, 2]);
  });

  it('borderWidth is a uniform: it emits without rebuilding the instances', () => {
    const p = new PointsLayer(PTS);
    const v = p.dataVersion;
    let emitted = 0;
    p.changed.connect(() => emitted++);
    p.borderWidth = 3;
    expect(emitted).toBe(1);
    expect(p.dataVersion).toBe(v);
  });
});

describe('points uniforms', () => {
  it('packs mvp, layer symbol code, opacity, borderWidth', () => {
    const out = new Float32Array(POINTS_UNIFORM_FLOATS);
    const p = new PointsLayer(PTS, { symbol: 'clobber', opacity: 0.5, borderWidth: 2 });
    packPointsUniforms(out, p, identity());
    expect(Array.from(out.subarray(0, 16))).toEqual(Array.from(identity()));
    expect(Array.from(out.subarray(16, 20))).toEqual([13, 0.5, 2, 0]);
  });
});

describe('pointSymbolDistance (CPU reference of the shader)', () => {
  const d = (s: (typeof POINT_SYMBOLS)[number], x: number, y: number): number =>
    pointSymbolDistance(code(s), x, y);

  it('puts every filled symbol centre inside and the far corner outside', () => {
    for (const s of POINT_SYMBOLS) {
      // `ring` draws its border only, but its shape is the disc's.
      expect(d(s, 0, 0.05), s).toBeLessThan(1);
      expect(d(s, 1.1, 1.1), s).toBeGreaterThan(1);
    }
  });

  it('keeps the original disc and square expressions', () => {
    expect(d('disc', 0.6, 0.8)).toBeCloseTo(1, 12);
    expect(d('ring', 0.3, 0.4)).toBeCloseTo(0.5, 12);
    expect(d('square', 0.9, -0.2)).toBe(0.9);
  });

  it('measures Euclidean distance, so a border is equally thick on every shape', () => {
    // A point 0.1 inside the edge reads 0.9 on straight edges of every kind.
    const n = 0.1 * Math.SQRT1_2; // 0.1 along the diamond edge's normal
    expect(d('diamond', 0.5 - n, 0.5 - n)).toBeCloseTo(0.9, 6);
    expect(d('hbar', 0, SYMBOL_ARM - 0.1)).toBeCloseTo(0.9, 6);
    expect(d('vbar', SYMBOL_ARM - 0.1, 0)).toBeCloseTo(0.9, 6);
    expect(d('cross', 0.9, 0)).toBeCloseTo(0.9, 6);
    expect(d('hexagon', 0, Math.sqrt(3) / 2 - 0.1)).toBeCloseTo(0.9, 6); // flat top
  });

  it('orients "up" to -y, the 2D camera\'s screen-up', () => {
    // triangle_up: the apex at -y, the base at +y = 0.5.
    expect(d('triangle_up', 0, -0.95)).toBeLessThan(1);
    expect(d('triangle_up', 0, 0.6)).toBeGreaterThan(1);
    expect(d('triangle_down', 0, 0.95)).toBeLessThan(1);
    expect(d('triangle_down', 0, -0.6)).toBeGreaterThan(1);
    expect(d('star', 0, -0.95)).toBeLessThan(1);
    expect(d('star', 0, 0.95)).toBeGreaterThan(1); // between the two lower points
    expect(d('pentagon', 0, -0.95)).toBeLessThan(1);
    // star's inner vertices sit at SYMBOL_STAR_INNER.
    expect(d('star', 0, SYMBOL_STAR_INNER)).toBeCloseTo(1, 6);
  });

  it('draws x as a rotated cross and arrow as a right-pointing chevron', () => {
    expect(d('x', 0.6, 0.6)).toBeLessThan(1);
    expect(d('x', 0.9, 0)).toBeGreaterThan(1);
    expect(d('arrow', 0.9, 0)).toBeLessThan(1); // tip at +x
    expect(d('arrow', -0.1, 0)).toBeGreaterThan(1); // the notch
    expect(d('tailed_arrow', -0.9, 0)).toBeLessThan(1); // the tail fills the notch
  });
});

describe('points shader contract', () => {
  it('switches on every symbol code, in POINT_SYMBOLS order', () => {
    const cases = [...POINTS_SHADER.matchAll(/case (\d+)u(?:, (\d+)u)?: \{.*?\/\/ (\w+)/g)];
    const named: string[] = [];
    for (const m of cases) {
      named[Number(m[1])] = m[3].replace(/,$/, '');
    }
    // `case 0u, 1u` carries "disc, ring"; the rest one name per case.
    expect(named[0]).toBe('disc');
    for (let i = 2; i < POINT_SYMBOLS.length; i++)
      expect(named[i], `code ${i}`).toBe(POINT_SYMBOLS[i]);
    expect(POINTS_SHADER).toMatch(/case 0u, 1u: \{ return length\(p\); \}\s*\/\/ disc, ring/);
  });

  it('shares the shape constants with the CPU reference', () => {
    expect(POINTS_SHADER).toContain(`const ARM : f32 = ${SYMBOL_ARM};`);
    expect(POINTS_SHADER).toContain(`const STAR_INNER : f32 = ${SYMBOL_STAR_INNER};`);
  });

  it('reads the per-point code flat, deferring to the layer code when negative', () => {
    expect(POINTS_SHADER).toContain('@location(4) @interpolate(flat) symbol : f32');
    expect(POINTS_SHADER).toContain('select(symbol, u.params.x, symbol < 0.0)');
    expect(POINTS_SHADER).toContain('u.params.z / max(size, 1e-6)'); // borderWidth uniform
    expect(POINTS_SHADER).toContain('if (code == 1u) { a = a * borderMix; }'); // ring
  });
});
