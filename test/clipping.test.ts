import { describe, expect, it } from 'vitest';

import { MAX_CLIPPING_PLANES, insideClippingPlanes, normalizeClippingPlanes } from '../src';

describe('clipping planes', () => {
  it('keeps the side the normal points to', () => {
    const plane = { position: [5, 0, 0] as const, normal: [1, 0, 0] as const };
    expect(insideClippingPlanes([6, 0, 0], [plane])).toBe(true);
    expect(insideClippingPlanes([5, 9, 9], [plane])).toBe(true);
    expect(insideClippingPlanes([4, 0, 0], [plane])).toBe(false);
    expect(insideClippingPlanes([4, 0, 0], [{ ...plane, enabled: false }])).toBe(true);
  });

  it('normalizes: unit normals, off and degenerate planes dropped, too many refused', () => {
    const out = normalizeClippingPlanes([
      { position: [0, 0, 0], normal: [0, 0, 2] },
      { position: [0, 0, 0], normal: [0, 0, 0] },
      { position: [0, 0, 0], normal: [1, 0, 0], enabled: false },
    ]);
    expect(out).toEqual([{ position: [0, 0, 0], normal: [0, 0, 1] }]);
    const many = Array.from({ length: MAX_CLIPPING_PLANES + 1 }, () => ({
      position: [0, 0, 0] as const,
      normal: [1, 0, 0] as const,
    }));
    expect(() => normalizeClippingPlanes(many)).toThrow();
  });
});
