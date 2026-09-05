import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_ZOOM_SMOOTHING_MS, smoothingAlpha } from '../src/camera/zoom-smoothing';
import { attachCameraControls } from '../src/camera/controls';
import { Camera } from '../src/camera/camera';

describe('smoothingAlpha', () => {
  it('moves further the more time has passed', () => {
    expect(smoothingAlpha(10, 90)).toBeLessThan(smoothingAlpha(50, 90));
  });

  it('is frame-rate independent: two half-steps equal one whole step', () => {
    // The property a fixed per-frame fraction would break — the same wall-clock
    // time must cover the same distance whether it arrives in one frame or two.
    const one = smoothingAlpha(32, 90);
    const half = smoothingAlpha(16, 90);
    const twice = 1 - (1 - half) * (1 - half);
    expect(twice).toBeCloseTo(one, 12);
  });

  it('lands 99% of the way after ln(100) time constants', () => {
    expect(smoothingAlpha(Math.log(100) * 90, 90)).toBeCloseTo(0.99, 10);
  });

  it('jumps straight there when smoothing is off', () => {
    expect(smoothingAlpha(16, 0)).toBe(1);
  });

  it('does not move on a zero-length frame', () => {
    expect(smoothingAlpha(0, 90)).toBe(0);
  });
});

describe('animated wheel zoom', () => {
  const rafs: ((t: number) => void)[] = [];
  let now = 0;

  /** Drive the animation by hand: one frame per call, 16ms apart. */
  const runFrames = (n: number) => {
    for (let i = 0; i < n; i++) {
      const queued = rafs.splice(0, rafs.length);
      if (queued.length === 0) return;
      now += 16;
      queued.forEach((fn) => fn(now));
    }
  };

  /** The animator reads performance.now(), so the fake clock has to drive it. */
  const realNow = performance.now.bind(performance);

  function harness(opts = {}) {
    rafs.length = 0;
    now = 0;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (
      fn: (t: number) => void,
    ) => {
      rafs.push(fn);
      return rafs.length;
    };
    (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = () => {};
    performance.now = () => now;
    const listeners = new Map<string, (e: unknown) => void>();
    const canvas = {
      addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
      removeEventListener: (type: string) => listeners.delete(type),
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
      clientHeight: 600,
      clientWidth: 800,
    } as unknown as HTMLCanvasElement;
    const camera = new Camera();
    camera.set([0, 0], 1);
    const detach = attachCameraControls(canvas, camera, opts);
    const wheel = (deltaY: number, x = 400, y = 300) =>
      listeners.get('wheel')?.({
        deltaY,
        deltaMode: 0,
        clientX: x,
        clientY: y,
        preventDefault: () => {},
      } as unknown as WheelEvent);
    return { camera, wheel, detach };
  }

  afterEach(() => {
    delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    performance.now = realNow;
  });

  it('does not apply the whole zoom on the event itself', () => {
    // This is the difference from the old behaviour: the wheel event used to BE
    // the zoom. Now it only sets a target.
    const { camera, wheel } = harness();
    wheel(-100);
    expect(camera.zoom).toBe(1);
  });

  it('eases toward the target over several frames', () => {
    const { camera, wheel } = harness();
    wheel(-100);
    runFrames(1);
    const afterOne = camera.zoom;
    expect(afterOne).toBeGreaterThan(1);
    runFrames(1);
    expect(camera.zoom).toBeGreaterThan(afterOne);
  });

  it('arrives at the full step and then stops', () => {
    const { camera, wheel } = harness();
    wheel(-100);
    runFrames(60);
    // 24 px clamped delta at the default speed.
    expect(camera.zoom).toBeCloseTo(Math.exp(24 * 0.0012), 6);
    const settled = camera.zoom;
    runFrames(10);
    expect(camera.zoom).toBe(settled); // no drift once landed
  });

  it('accumulates a burst instead of restarting from mid-flight', () => {
    // A trackpad sends many events per swipe. Each must add to the target, or a
    // fast scroll would keep resetting and travel less than a slow one.
    const { camera, wheel } = harness();
    wheel(-100);
    wheel(-100);
    wheel(-100);
    runFrames(80);
    expect(camera.zoom).toBeCloseTo(Math.exp(3 * 24 * 0.0012), 5);
  });

  it('keeps the anchored point fixed on screen throughout', () => {
    // Zoom about a corner, not the centre: the world point under the cursor must
    // stay under it on EVERY frame, not just when the animation lands.
    const { camera, wheel } = harness();
    const [ax, ay] = [700, 500];
    const worldUnder = () => {
      const px = ax - 400;
      const py = ay - 300;
      return [camera.center[0] + px / camera.zoom, camera.center[1] + py / camera.zoom];
    };
    wheel(-100, ax, ay);
    const before = worldUnder();
    for (let i = 0; i < 8; i++) {
      runFrames(1);
      const during = worldUnder();
      expect(during[0]).toBeCloseTo(before[0], 6);
      expect(during[1]).toBeCloseTo(before[1], 6);
    }
  });

  it('re-anchors on the latest pointer, not the first of a burst', () => {
    // Scrolling while moving the cursor must keep zooming about where the cursor
    // IS. Holding the first event's anchor would drag the view away from it.
    const { camera, wheel } = harness();
    const worldUnder = (sx: number, sy: number) => [
      camera.center[0] + (sx - 400) / camera.zoom,
      camera.center[1] + (sy - 300) / camera.zoom,
    ];
    wheel(-100, 700, 500);
    runFrames(1);
    wheel(-100, 200, 100);
    const anchored = worldUnder(200, 100);
    for (let i = 0; i < 8; i++) {
      runFrames(1);
      const during = worldUnder(200, 100);
      expect(during[0]).toBeCloseTo(anchored[0], 6);
      expect(during[1]).toBeCloseTo(anchored[1], 6);
    }
  });

  it('applies instantly when smoothing is turned off', () => {
    const { camera, wheel } = harness({ zoomSmoothingMs: 0 });
    wheel(-100);
    expect(camera.zoom).toBeCloseTo(Math.exp(24 * 0.0012), 6);
  });

  it('yields when something else changes the zoom mid-flight', () => {
    // A fit(), or a host driving the camera, must not be fought over. Changing
    // ONLY the zoom, so this pins the zoom half of the takeover check — moving
    // the centre too would let the centre half cover for it.
    const { camera, wheel } = harness();
    wheel(-100);
    runFrames(1);
    camera.set(camera.center, 5);
    runFrames(20);
    expect(camera.zoom).toBe(5);
  });

  it('yields when something else pans mid-flight, without moving the zoom', () => {
    // A center-only change is just as much a takeover as a zoom change: a host
    // pan, or a fit() that happens to land on the current zoom. Continuing to
    // animate re-centres each frame to hold the stale wheel anchor, dragging the
    // view away from where the host just put it.
    const { camera, wheel } = harness();
    wheel(-100, 700, 500);
    runFrames(1);
    const zoomWhenTakenOver = camera.zoom;
    camera.center = [123, -456];
    runFrames(20);
    expect(camera.center[0]).toBe(123);
    expect(camera.center[1]).toBe(-456);
    expect(camera.zoom).toBe(zoomWhenTakenOver);
  });

  it('zooms out on a downward scroll', () => {
    const { camera, wheel } = harness();
    wheel(100);
    runFrames(60);
    expect(camera.zoom).toBeLessThan(1);
  });

  it('uses a time constant close to the OSD backend’s animation time', () => {
    // ln(100) time constants to settle, against the 0.4s OSD is configured with.
    const settleMs = DEFAULT_ZOOM_SMOOTHING_MS * Math.log(100);
    expect(settleMs).toBeGreaterThan(300);
    expect(settleMs).toBeLessThan(500);
  });
});
