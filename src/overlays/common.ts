import type { Camera } from '../camera/camera';
import type { Camera3D } from '../camera/camera3d';
import type { Dims } from '../scene/dims';
import type { Rect } from '../io/pyramid';
import type { ProjectedPoints } from '../picking/project';

/**
 * The slice of a viewer the overlays read: the cameras and dims (for their `changed` signals),
 * the visible rect and the 3D projection. `Viewer` and the headless viewer in
 * `napari-js/testing` both satisfy it.
 */
export interface OverlayViewer {
  readonly camera: Camera;
  readonly camera3d: Camera3D;
  readonly dims: Dims;
  visibleWorldRect(): Rect;
  projectPoints(positions: Float32Array): ProjectedPoints | null;
}

/**
 * The canvas's CSS size, recovered from the viewer's own visible rect: `visibleWorldRect` is
 * the canvas size divided by the 2D zoom, so multiplying back gives exactly the size the
 * viewer projects with — not the host's, which may hold more than the canvas.
 */
export function canvasCssSize(viewer: OverlayViewer): { width: number; height: number } {
  const r = viewer.visibleWorldRect();
  const zoom = viewer.camera.zoom;
  return { width: r.width * zoom, height: r.height * zoom };
}

/** The host's document (overlays build DOM in it, so they also work inside an iframe). */
export function docOf(host: HTMLElement): Document {
  return host.ownerDocument;
}

/** The host must be a containing block for the absolutely positioned overlay. */
export function ensurePositioned(host: HTMLElement): void {
  const view = host.ownerDocument.defaultView;
  const position = view?.getComputedStyle(host).position ?? host.style.position;
  if (!position || position === 'static') host.style.position = 'relative';
}

/** Call `fn` whenever `host` resizes, if the environment has a `ResizeObserver`. */
export function observeResize(host: HTMLElement, fn: () => void): () => void {
  const view = host.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  const RO =
    view?.ResizeObserver ?? (typeof ResizeObserver !== 'undefined' ? ResizeObserver : null);
  if (!RO) return () => undefined;
  const ro = new RO(() => fn());
  ro.observe(host);
  return () => ro.disconnect();
}
