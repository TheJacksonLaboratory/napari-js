/**
 * Wheel-delta normalization and zoom sensitivity, shared by the 2D and 3D controls.
 *
 * Browsers report wheel deltas in three different units, and the SAME physical gesture differs by
 * more than an order of magnitude between them: Chrome sends one ~100px event per mouse notch,
 * Firefox reports `deltaMode: 1` (lines) with `deltaY` around 3, and a trackpad sends a burst of
 * small events whose momentum ticks can reach several hundred px. Feeding the raw value to an
 * exponential zoom therefore makes the wheel violent on one device and nearly dead on another.
 *
 * Shared rather than inlined so every wheel path in the library feels the same on a given device.
 */

/**
 * Zoom multiplier per normalized, clamped wheel-delta unit, applied as `exp(±delta * speed)`.
 * Smaller = gentler.
 *
 * Chosen so one mouse notch — a clamped {@link WHEEL_DELTA_CLAMP} of delta — moves about 3%,
 * roughly 24 notches to double. That matches the step OpenSeadragon is configured with for the
 * same images, so switching rendering implementation does not change how the wheel feels.
 */
export const DEFAULT_WHEEL_ZOOM_SPEED = 0.0012;

/** Per-event delta clamp, applied AFTER unit normalization, so one oversized event — a
 *  high-resolution wheel, or a trackpad momentum tick — cannot zoom far in a single step. */
export const WHEEL_DELTA_CLAMP = 24;

/** Pixels per line, for `deltaMode: 1`. Matches the step browsers use for a text line. */
const PIXELS_PER_LINE = 16;

/** Fallback viewport height for `deltaMode: 2` when the element has no measured box. */
const FALLBACK_PAGE_PX = 800;

/**
 * A wheel event's vertical delta in approximate CSS pixels, clamped to {@link WHEEL_DELTA_CLAMP}.
 *
 * `element` is measured only for page-mode deltas, where a "page" means this element's height.
 */
export function normalizedWheelDelta(e: WheelEvent, element: HTMLElement): number {
  let delta = e.deltaY;
  if (e.deltaMode === 1) {
    delta *= PIXELS_PER_LINE;
  } else if (e.deltaMode === 2) {
    delta *= element.getBoundingClientRect().height || FALLBACK_PAGE_PX;
  }
  return Math.max(-WHEEL_DELTA_CLAMP, Math.min(WHEEL_DELTA_CLAMP, delta));
}
