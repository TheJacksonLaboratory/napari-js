import type { Camera } from './camera';
import { DEFAULT_WHEEL_ZOOM_SPEED, normalizedWheelDelta } from './wheel';
import { DEFAULT_ZOOM_SMOOTHING_MS, smoothingAlpha } from './zoom-smoothing';
/** Click-to-zoom multiplier (zoom in on a plain click; its reciprocal on a modifier/right click). */
const DEFAULT_CLICK_ZOOM_FACTOR = 2;
/** Pointer travel (CSS px) beyond which a press-release is a pan, not a click (so it won't zoom). */
const CLICK_MOVE_THRESHOLD = 4;

export interface CameraControlOptions {
  /** Wheel-zoom sensitivity (see {@link DEFAULT_WHEEL_ZOOM_SPEED}). Smaller = gentler. */
  wheelZoomSpeed?: number;
  /** Click-to-zoom step (default 2× in / 0.5× out). Set 0 to disable click-to-zoom. */
  clickZoomFactor?: number;
  /**
   * Ease zoom toward its target over this time constant in ms, instead of jumping to it.
   * See {@link DEFAULT_ZOOM_SMOOTHING_MS}. Set 0 to apply zoom instantly.
   */
  zoomSmoothingMs?: number;
}

/**
 * Attach pointer-drag panning, wheel zoom, and OSD-style click-to-zoom to a canvas. Returns a
 * detach function. A plain left click zooms in about the cursor; a right click or modifier-click
 * (shift/ctrl/alt/meta) zooms out; a left drag pans (and never triggers click-zoom). World/screen
 * conversion uses the camera's current center+zoom and the canvas's CSS size.
 */
export function attachCameraControls(
  canvas: HTMLCanvasElement,
  camera: Camera,
  opts: CameraControlOptions = {},
): () => void {
  const wheelSpeed = opts.wheelZoomSpeed ?? DEFAULT_WHEEL_ZOOM_SPEED;
  const clickFactor = opts.clickZoomFactor ?? DEFAULT_CLICK_ZOOM_FACTOR;
  const smoothingMs = opts.zoomSmoothingMs ?? DEFAULT_ZOOM_SMOOTHING_MS;

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let downX = 0;
  let downY = 0;
  let moved = false;

  /** Zoom by `factor` while keeping the world point under the cursor fixed. */
  const zoomAbout = (clientX: number, clientY: number, factor: number): void => {
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left - rect.width / 2;
    const py = clientY - rect.top - rect.height / 2;
    const { zoom } = camera;
    const [cx, cy] = camera.center;
    const wx = cx + px / zoom;
    const wy = cy + py / zoom;
    const newZoom = zoom * factor;
    camera.set([wx - px / newZoom, wy - py / newZoom], newZoom);
  };

  // Animated zoom. A wheel notch sets a TARGET and the camera eases toward it, rather than
  // snapping there — which is the whole of the difference between this and OpenSeadragon, whose
  // wheel feels smooth because every notch runs through a spring.
  let targetZoom = 0; // 0 = idle
  let anchorX = 0;
  let anchorY = 0;
  let lastFrameMs = 0;
  let frame: number | null = null;
  // What we last left the camera at, so a fit() or a host moving it mid-flight is detected and
  // yielded to rather than fought over. Both parts matter: watching the zoom alone misses a host
  // pan, or a fit() that happens to land on the current zoom, and the animation would then re-centre
  // every frame to hold its stale anchor and drag the view off where the host just put it.
  let appliedZoom = 0;
  let appliedCenterX = 0;
  let appliedCenterY = 0;

  const rememberApplied = (): void => {
    appliedZoom = camera.zoom;
    [appliedCenterX, appliedCenterY] = camera.center;
  };

  /** Whether the camera has moved by any hand other than this animator's. */
  const takenOver = (): boolean => {
    const [cx, cy] = camera.center;
    const drifted = (a: number, b: number): boolean =>
      Math.abs(a - b) > Math.max(1, Math.abs(b)) * 1e-9;
    return (
      drifted(camera.zoom, appliedZoom) ||
      drifted(cx, appliedCenterX) ||
      drifted(cy, appliedCenterY)
    );
  };

  const animatable = (): boolean => smoothingMs > 0 && typeof requestAnimationFrame === 'function';

  const step = (): void => {
    frame = null;
    if (!targetZoom) return;
    if (takenOver()) {
      targetZoom = 0;
      return;
    }
    // Timed off performance.now() rather than the frame callback's timestamp: the two are the
    // same clock in a browser, but reading one clock throughout removes any chance of seeding
    // from one and stepping with the other, which silently zeroes the first frame's delta.
    const now = performance.now();
    const dt = Math.max(0, now - lastFrameMs);
    lastFrameMs = now;
    const logCurrent = Math.log(camera.zoom);
    const logTarget = Math.log(targetZoom);
    const remaining = logTarget - logCurrent;
    // Close enough that another frame would not be visible: land exactly, so repeated nudges
    // cannot leave the zoom drifting a hair short of where the user aimed.
    const done = Math.abs(remaining) < 1e-4;
    const logNext = done ? logTarget : logCurrent + remaining * smoothingAlpha(dt, smoothingMs);
    zoomAbout(anchorX, anchorY, Math.exp(logNext - logCurrent));
    rememberApplied();
    if (done) {
      targetZoom = 0;
      return;
    }
    frame = requestAnimationFrame(step);
  };

  /** Zoom about a point, eased when smoothing is on and instantly otherwise. */
  const zoomToward = (clientX: number, clientY: number, factor: number): void => {
    if (!animatable()) {
      zoomAbout(clientX, clientY, factor);
      return;
    }
    // Anchor on the LATEST pointer position, as OpenSeadragon does — a burst of wheel events
    // while the cursor moves should follow the cursor, not the first event's position.
    anchorX = clientX;
    anchorY = clientY;
    // Compound onto the target in flight, so a fast scroll accumulates into one continuous
    // movement instead of restarting from wherever the animation happens to have reached.
    targetZoom = (targetZoom || camera.zoom) * factor;
    if (frame === null) {
      lastFrameMs = performance.now();
      rememberApplied();
      frame = requestAnimationFrame(step);
    }
  };

  const onPointerDown = (e: PointerEvent): void => {
    downX = e.clientX;
    downY = e.clientY;
    moved = false;
    if (e.button === 0) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return;
    if (!moved && Math.hypot(e.clientX - downX, e.clientY - downY) > CLICK_MOVE_THRESHOLD) {
      moved = true;
    }
    const dxPx = e.clientX - lastX;
    const dyPx = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    // Drag right → content moves right → center moves left. Y axis is flipped on screen.
    const { zoom } = camera;
    const [cx, cy] = camera.center;
    camera.center = [cx - dxPx / zoom, cy - dyPx / zoom];
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    const wasDragging = dragging;
    dragging = false;
    // A press-release that didn't pan is a click → zoom about the cursor. Right button or a
    // modifier zooms out; a plain left click zooms in. Skips when click-zoom is disabled.
    if (clickFactor > 0 && !moved && !(wasDragging && moved)) {
      const zoomOut = e.button === 2 || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey;
      zoomToward(e.clientX, e.clientY, zoomOut ? 1 / clickFactor : clickFactor);
    }
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    zoomToward(e.clientX, e.clientY, Math.exp(-normalizedWheelDelta(e, canvas) * wheelSpeed));
  };

  // Suppress the browser context menu so a right-click can zoom out.
  const onContextMenu = (e: MouseEvent): void => e.preventDefault();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    canvas.removeEventListener('contextmenu', onContextMenu);
  };
}
