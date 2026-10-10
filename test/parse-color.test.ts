import { describe, it, expect } from 'vitest';
import { parseColor } from '../src/color/parse';
import { tintColormap } from '../src/color/colormap';

const close = (got: number[] | null, want: number[]) => {
  expect(got).not.toBeNull();
  got!.forEach((v, i) => expect(v).toBeCloseTo(want[i], 6));
};

describe('parseColor', () => {
  it('parses every hex form', () => {
    expect(parseColor('#f80')).toEqual([1, 136 / 255, 0, 1]);
    expect(parseColor('#f808')).toEqual([1, 136 / 255, 0, 136 / 255]);
    expect(parseColor('#FF8000')).toEqual([1, 128 / 255, 0, 1]);
    expect(parseColor('#ff800080')).toEqual([1, 128 / 255, 0, 128 / 255]);
  });

  it('parses rgb() and rgba() in comma, space and slash syntax', () => {
    expect(parseColor('rgb(255, 0, 51)')).toEqual([1, 0, 0.2, 1]);
    expect(parseColor('rgba(255,0,51,0.5)')).toEqual([1, 0, 0.2, 0.5]);
    expect(parseColor('  RGB( 0 255 0 / 25% ) ')).toEqual([0, 1, 0, 0.25]);
    close(parseColor('rgb(100%, 50%, 0%)'), [1, 0.5, 0, 1]);
    expect(parseColor('rgb(300, -5, 0)')).toEqual([1, 0, 0, 1]); // clamped
  });

  it('knows the basic named colours and matplotlib shorthands', () => {
    expect(parseColor('red')).toEqual([1, 0, 0, 1]);
    expect(parseColor('Lime')).toEqual([0, 1, 0, 1]);
    close(parseColor('green'), [0, 128 / 255, 0, 1]);
    expect(parseColor('transparent')).toEqual([0, 0, 0, 0]);
    expect(parseColor('k')).toEqual([0, 0, 0, 1]);
    close(parseColor('orange'), [1, 165 / 255, 0, 1]);
  });

  it('returns a fresh tuple (named colours are not shared)', () => {
    const a = parseColor('red')!;
    a[0] = 0;
    expect(parseColor('red')![0]).toBe(1);
  });

  it('is null for anything else', () => {
    for (const bad of [
      '',
      '#',
      '#12',
      '#12345',
      '#gggggg',
      'f80',
      'rgb(1, 2)',
      'rgb(1, 2, x)',
      'rgb(1, 2, 3, 4, 5)',
      'rgb(1 2 3 / 1 / 2)',
      'hsl(0, 100%, 50%)',
      'chartreuse-ish',
    ]) {
      expect(parseColor(bad), bad).toBeNull();
    }
    expect(parseColor(undefined as unknown as string)).toBeNull();
  });
});

describe('tintColormap uses parseColor', () => {
  it('accepts rgb() and named colours', () => {
    expect(tintColormap('rgb(255, 0, 0)').sample(1)).toEqual([1, 0, 0]);
    expect(tintColormap('magenta').sample(1)).toEqual([1, 0, 1]);
    expect(tintColormap('magenta').name).toBe('tint-ff00ff');
  });

  it('ignores alpha and keeps bare-hex input working', () => {
    expect(tintColormap('#00ff0080').sample(1)).toEqual([0, 1, 0]);
    expect(tintColormap('FF8000').name).toBe('tint-ff8000');
  });
});
