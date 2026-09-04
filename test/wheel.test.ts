import { describe, it, expect } from 'vitest';
import { WHEEL_DELTA_CLAMP, normalizedWheelDelta } from '../src/camera/wheel';

/** A wheel event carrying only what the normalizer reads. */
const wheel = (deltaY: number, deltaMode = 0): WheelEvent =>
  ({
    deltaY,
    deltaMode,
    clientX: 0,
    clientY: 0,
    preventDefault: () => {},
  }) as unknown as WheelEvent;

/** An element with a measurable box, for page-mode deltas. */
const element = (height: number): HTMLElement =>
  ({ getBoundingClientRect: () => ({ height }) }) as unknown as HTMLElement;

describe('normalizedWheelDelta', () => {
  it('passes pixel-mode deltas through', () => {
    expect(normalizedWheelDelta(wheel(10), element(600))).toBe(10);
  });

  it('converts line-mode deltas to pixels', () => {
    // Firefox reports deltaMode 1 with a deltaY of ~3 for one mouse notch. Left raw, that is a
    // thirtieth of Chrome's ~100px for the same physical gesture.
    expect(normalizedWheelDelta(wheel(3, 1), element(600))).toBe(24);
  });

  it('converts page-mode deltas using the element height', () => {
    expect(normalizedWheelDelta(wheel(0.5, 2), element(40))).toBe(20);
  });

  it('falls back to a nominal page when the element has no box', () => {
    // A detached or unlaid-out canvas measures 0; multiplying by it would zoom not at all.
    expect(normalizedWheelDelta(wheel(0.01, 2), element(0))).toBeCloseTo(8, 6);
  });

  it('clamps an oversized event in both directions', () => {
    // A trackpad momentum tick reaches several hundred px.
    expect(normalizedWheelDelta(wheel(400), element(600))).toBe(WHEEL_DELTA_CLAMP);
    expect(normalizedWheelDelta(wheel(-400), element(600))).toBe(-WHEEL_DELTA_CLAMP);
  });
});
