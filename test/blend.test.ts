import { describe, it, expect } from 'vitest';
import { blendStateFor } from '../src/visuals/blend';
import { blendingUsesDepth } from '../src/layers/layer';

describe('blendStateFor', () => {
  it('disables blending for opaque', () => {
    expect(blendStateFor('opaque')).toBeUndefined();
  });

  it('translucent is premultiplied src-over', () => {
    const b = blendStateFor('translucent')!;
    expect(b.color).toMatchObject({
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    });
    expect(b.alpha).toMatchObject({
      srcFactor: 'one',
      dstFactor: 'one-minus-src-alpha',
      operation: 'add',
    });
  });

  it('translucent_no_depth blends as translucent', () => {
    expect(blendStateFor('translucent_no_depth')).toEqual(blendStateFor('translucent'));
  });

  it('only opaque and translucent take part in depth', () => {
    expect(blendingUsesDepth('opaque')).toBe(true);
    expect(blendingUsesDepth('translucent')).toBe(true);
    expect(blendingUsesDepth('translucent_no_depth')).toBe(false);
    expect(blendingUsesDepth('additive')).toBe(false);
    expect(blendingUsesDepth('minimum')).toBe(false);
  });

  it('additive accumulates (one/one add)', () => {
    const b = blendStateFor('additive')!;
    expect(b.color).toMatchObject({ srcFactor: 'one', dstFactor: 'one', operation: 'add' });
  });

  it('minimum uses the min operation', () => {
    const b = blendStateFor('minimum')!;
    expect(b.color.operation).toBe('min');
    expect(b.alpha.operation).toBe('min');
  });
});
