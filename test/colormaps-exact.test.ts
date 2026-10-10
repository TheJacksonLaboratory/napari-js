import { describe, it, expect } from 'vitest';
import {
  VIRIDIS_LUT,
  MAGMA_LUT,
  TURBO_LUT,
  GREYS_LUT,
  COLORMAP_LUTS,
  lutColormap,
  matplotlibColormap,
} from '../src/colormaps';
import { VIRIDIS, MAGMA, INFERNO, resolveColormap } from '../src/color/colormap';
import { buildLut } from '../src/color/lut';
import { decodeLut } from '../src/color/lut-data';

const rgbOf = (lut: Uint8Array) => {
  const out = new Uint8Array((lut.length / 4) * 3);
  for (let i = 0; i < lut.length / 4; i++) out.set(lut.subarray(i * 4, i * 4 + 3), i * 3);
  return out;
};

describe('napari-js/colormaps', () => {
  it('ships every map as a 256-entry RGB table', () => {
    const names = Object.keys(COLORMAP_LUTS);
    expect(names.length).toBe(83);
    for (const n of ['viridis', 'magma', 'inferno', 'plasma', 'cividis', 'turbo', 'rdbu', 'gray'])
      expect(names).toContain(n);
    for (const lut of Object.values(COLORMAP_LUTS)) {
      expect(lut).toBeInstanceOf(Uint8Array);
      expect(lut.length).toBe(768);
    }
  });

  it("matches matplotlib's bytes (cmap(x, bytes=True)) at the ends", () => {
    expect(Array.from(VIRIDIS_LUT.slice(0, 3))).toEqual([68, 1, 84]);
    expect(Array.from(VIRIDIS_LUT.slice(765))).toEqual([253, 231, 36]);
    expect(Array.from(MAGMA_LUT.slice(0, 3))).toEqual([0, 0, 3]);
    expect(Array.from(MAGMA_LUT.slice(765))).toEqual([251, 252, 191]);
    expect(Array.from(TURBO_LUT.slice(0, 3))).toEqual([48, 18, 59]);
    expect(Array.from(GREYS_LUT.slice(0, 3))).toEqual([255, 255, 255]);
  });

  it('lutColormap reproduces the table exactly through buildLut', () => {
    for (const [name, lut] of Object.entries(COLORMAP_LUTS)) {
      expect(rgbOf(buildLut(lutColormap(name, lut))), name).toEqual(lut);
    }
  });

  it('the main entry VIRIDIS/MAGMA/INFERNO are the exact tables', () => {
    expect(rgbOf(buildLut(VIRIDIS))).toEqual(VIRIDIS_LUT);
    expect(rgbOf(buildLut(MAGMA))).toEqual(MAGMA_LUT);
    expect(rgbOf(buildLut(INFERNO))).toEqual(COLORMAP_LUTS.inferno);
    expect(resolveColormap('inferno')).toBe(INFERNO);
    expect(VIRIDIS.name).toBe('viridis');
  });

  it('matplotlibColormap resolves by case-insensitive name', () => {
    expect(matplotlibColormap('RdBu')?.name).toBe('rdbu');
    expect(matplotlibColormap('nope')).toBeNull();
  });

  it('lutColormap validates its input and honours maxValue', () => {
    expect(() => lutColormap('x', [1, 2, 3])).toThrow(/n >= 2/);
    expect(() => lutColormap('x', [1, 2, 3, 4])).toThrow(/3·n/);
    expect(lutColormap('x', [0, 0, 0, 1, 1, 1], 1).sample(1)).toEqual([1, 1, 1]);
  });

  it('decodeLut decodes base64', () => {
    expect(Array.from(decodeLut('AAEC/w=='))).toEqual([0, 1, 2, 255]);
  });
});
