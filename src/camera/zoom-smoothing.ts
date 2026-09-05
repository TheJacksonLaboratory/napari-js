/**
 * Frame-rate-independent easing for animated zoom.
 *
 * Zoom is MULTIPLICATIVE — going 1x to 4x is the same perceptual distance as 4x to 16x — so the
 * easing runs in log space. OpenSeadragon reaches the same conclusion from the other direction: its
 * zoom spring is the only one it constructs with `exponential: true`. Easing the raw factor instead
 * makes a zoom-in crawl and a zoom-out snap.
 */

/**
 * Time constant of the exponential approach, in milliseconds.
 *
 * An exponential ease is ~99% of the way there after 4.6 time constants, so 90ms settles in about
 * 415ms. That is deliberately close to the 0.4s `animationTime` the OpenSeadragon backend is
 * configured with, since the two render the same images and should not feel different.
 */
export const DEFAULT_ZOOM_SMOOTHING_MS = 90;

/**
 * How far to move toward the target this frame, as a fraction of the remaining distance.
 *
 * Derived from elapsed time rather than applied per frame at a fixed rate, so the animation takes
 * the same wall-clock time on a 60Hz and a 144Hz display — a fixed per-frame fraction would settle
 * more than twice as fast on the latter.
 */
export function smoothingAlpha(elapsedMs: number, timeConstantMs: number): number {
  if (!(timeConstantMs > 0)) return 1;
  if (!(elapsedMs > 0)) return 0;
  return 1 - Math.exp(-elapsedMs / timeConstantMs);
}
