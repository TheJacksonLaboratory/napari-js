import type { Camera3D } from './camera3d';
import { DEFAULT_WHEEL_ZOOM_SPEED, normalizedWheelDelta } from './wheel';

export interface OrbitControlOptions {
  /** Wheel-dolly sensitivity (see {@link DEFAULT_WHEEL_ZOOM_SPEED}). Smaller = gentler. */
  wheelZoomSpeed?: number;
}

/**
 * Attach orbit controls to a canvas. A pointer drag does `camera.dragMode` — rotate
 * (azimuth/elevation), pan (translate the target), or zoom (dolly) — and the wheel always
 * dollies. Returns a detach function.
 */
export function attachOrbitControls(
  canvas: HTMLCanvasElement,
  camera: Camera3D,
  opts: OrbitControlOptions = {},
): () => void {
  const wheelSpeed = opts.wheelZoomSpeed ?? DEFAULT_WHEEL_ZOOM_SPEED;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent): void => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (camera.dragMode === 'pan') {
      camera.pan(dx, dy, canvas.clientHeight || canvas.height || 1);
    } else if (camera.dragMode === 'zoom') {
      camera.zoomBy(Math.exp(dy * 0.005));
    } else {
      camera.orbit(-dx * 0.01, -dy * 0.01);
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    // Same normalization and clamp as the 2D wheel: this used the RAW deltaY, which made one
    // Chrome mouse notch dolly 16% and one trackpad momentum tick dolly 1.8x.
    camera.zoomBy(Math.exp(normalizedWheelDelta(e, canvas) * wheelSpeed));
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
  };
}
