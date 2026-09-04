import { describe, it, expect } from 'vitest';
import { DEFAULT_WHEEL_ZOOM_SPEED, WHEEL_DELTA_CLAMP } from '../src/camera/wheel';
import { attachOrbitControls } from '../src/camera/controls3d';
import { Camera3D } from '../src/camera/camera3d';

/** A wheel event carrying only what the normalizer reads. */
const wheel = (deltaY: number, deltaMode = 0): WheelEvent =>
  ({
    deltaY,
    deltaMode,
    clientX: 0,
    clientY: 0,
    preventDefault: () => {},
  }) as unknown as WheelEvent;

describe('the 3D wheel dolly', () => {
  /** A canvas stand-in that hands back the listeners it was given. */
  function fakeCanvas() {
    const listeners = new Map<string, (e: unknown) => void>();
    const canvas = {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      getBoundingClientRect: () => ({ height: 600, width: 800 }),
      clientHeight: 600,
      clientWidth: 800,
    } as unknown as HTMLCanvasElement;
    return { canvas, fire: (e: WheelEvent) => listeners.get('wheel')?.(e) };
  }

  /** The factor the camera's distance moved by for one wheel event. */
  const dollyFor = (e: WheelEvent, opts = {}) => {
    const { canvas, fire } = fakeCanvas();
    const camera = new Camera3D();
    const detach = attachOrbitControls(canvas, camera, opts);
    const before = camera.distance;
    fire(e);
    const after = camera.distance;
    detach();
    return after / before;
  };

  it('dollies by the normalized delta, not the raw one', () => {
    // The bug: this used e.deltaY directly, so a Chrome notch dollied by exp(100 * 0.0015) = 16%.
    expect(dollyFor(wheel(100))).toBeCloseTo(
      Math.exp(WHEEL_DELTA_CLAMP * DEFAULT_WHEEL_ZOOM_SPEED),
      6,
    );
  });

  it('treats one mouse notch the same in Chrome and in Firefox', () => {
    // ~100px (Chrome, pixel mode) and 3 lines (Firefox) are the same gesture. Raw, they differed
    // by 36x: 16.18% against 0.45%.
    expect(dollyFor(wheel(100))).toBeCloseTo(dollyFor(wheel(3, 1)), 6);
  });

  it('clamps a trackpad momentum tick to one step', () => {
    // Raw, deltaY 400 dollied 1.82x in a single event.
    expect(dollyFor(wheel(400))).toBeCloseTo(dollyFor(wheel(WHEEL_DELTA_CLAMP)), 6);
    expect(dollyFor(wheel(400))).toBeLessThan(1.05);
  });

  it('zooms out scrolling down and in scrolling up', () => {
    expect(dollyFor(wheel(100))).toBeGreaterThan(1);
    expect(dollyFor(wheel(-100))).toBeLessThan(1);
  });

  it('honours a caller’s wheelZoomSpeed, which it used to ignore', () => {
    // `ViewerOptions.wheelZoomSpeed` was documented but never reached the 3D controls: the viewer
    // called attachOrbitControls with no options at all.
    const gentle = dollyFor(wheel(100), { wheelZoomSpeed: DEFAULT_WHEEL_ZOOM_SPEED / 3 });
    expect(gentle).toBeCloseTo(Math.exp((WHEEL_DELTA_CLAMP * DEFAULT_WHEEL_ZOOM_SPEED) / 3), 6);
    expect(gentle).toBeLessThan(dollyFor(wheel(100)));
  });

  it('is gentle enough that a notch is a few percent, not a sixth', () => {
    // The user-visible complaint: one notch moved too far.
    const step = dollyFor(wheel(100)) - 1;
    expect(step).toBeGreaterThan(0.005);
    expect(step).toBeLessThan(0.04);
  });
});
