/**
 * Real-GPU test harness: the actual {@link Viewer} on a canvas in headless Chromium, read back
 * with `readDisplayedPixels`. Run by `npm run test:gpu` (vitest.gpu.config.ts).
 *
 * With no WebGPU adapter every GPU suite skips, saying why — unless NAPARI_GPU_REQUIRED=1 (CI),
 * where a missing adapter fails the run instead of passing it silently.
 */
import { describe, it } from 'vitest';

import { Viewer, type PixelData, type ViewerOptions } from '../../src';

declare const __NAPARI_GPU_REQUIRED__: boolean;

/** The adapter, probed once per test file. */
const adapter: GPUAdapter | null =
  typeof navigator !== 'undefined' && navigator.gpu ? await navigator.gpu.requestAdapter() : null;

/** Which adapter the suite runs on (e.g. "apple metal-3", "google swiftshader"). */
export const ADAPTER_NAME = adapter
  ? `${adapter.info.vendor} ${adapter.info.architecture}`.trim()
  : 'none';

/** Whether the adapter is a software rasterizer: some tolerances are looser there. */
export const SOFTWARE = /swiftshader/i.test(ADAPTER_NAME);

/**
 * `describe` for a GPU suite: runs with an adapter; without one it skips (or, when the GPU is
 * required, fails with the reason).
 */
export function describeGpu(name: string, fn: () => void): void {
  if (adapter) {
    describe(`${name} [${ADAPTER_NAME}]`, fn);
  } else if (__NAPARI_GPU_REQUIRED__) {
    describe(name, () => {
      it('needs a WebGPU adapter', () => {
        throw new Error('No WebGPU adapter, and NAPARI_GPU_REQUIRED=1: the GPU tests cannot run.');
      });
    });
  } else {
    describe.skip(`${name} (skipped: no WebGPU adapter in this browser)`, fn);
  }
}

/** Canvas side, CSS px (= device px: the config fixes deviceScaleFactor at 1). */
export const SIZE = 64;

/** Black, opaque: a premultiplied layer then reads back as its colour × alpha. */
const BLACK: GPUColor = { r: 0, g: 0, b: 0, a: 1 };

/** A ready viewer on a fresh `size`×`size` canvas, with no pointer controls or resize observer. */
export async function makeViewer(opts: Partial<ViewerOptions> = {}, size = SIZE): Promise<Viewer> {
  const canvas = document.createElement('canvas');
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.style.display = 'block';
  document.body.appendChild(canvas);
  const viewer = new Viewer({
    canvas,
    controls: false,
    autoResize: false,
    background: BLACK,
    ...opts,
  });
  await viewer.ready;
  return viewer;
}

/** Dispose a viewer and take its canvas off the page. */
export function disposeViewer(viewer: Viewer): void {
  const canvas = (viewer as unknown as { canvas: HTMLCanvasElement }).canvas;
  viewer.dispose();
  canvas.remove();
}

/** The RGBA bytes at `(x, y)` (device px, top row first). */
export function pixel(px: PixelData, x: number, y: number): [number, number, number, number] {
  const i = (Math.floor(y) * px.width + Math.floor(x)) * 4;
  return [px.data[i], px.data[i + 1], px.data[i + 2], px.data[i + 3]];
}

/** Fraction of pixels whose brightest RGB channel exceeds `threshold`. */
export function coverage(px: PixelData, threshold = 16): number {
  let lit = 0;
  for (let i = 0; i < px.data.length; i += 4) {
    if (Math.max(px.data[i], px.data[i + 1], px.data[i + 2]) > threshold) lit++;
  }
  return lit / (px.width * px.height);
}

/** Mean RGB over a `w`×`h` block at `(x, y)`. */
export function meanRgb(
  px: PixelData,
  x: number,
  y: number,
  w: number,
  h: number,
): [number, number, number] {
  const sum = [0, 0, 0];
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      const [r, g, b] = pixel(px, i, j);
      sum[0] += r;
      sum[1] += g;
      sum[2] += b;
    }
  }
  const n = w * h;
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

/** Assert-friendly: the largest per-channel difference between two RGB(A) colours. */
export function maxDiff(a: readonly number[], b: readonly number[]): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  return d;
}

/** A uint8 volume (x fastest) with `value` inside the centred cube of half-side `half`, else 0. */
export function cubeVolume(n: number, half: number, value = 255): Uint8Array {
  const data = new Uint8Array(n * n * n);
  const c = (n - 1) / 2;
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (Math.abs(x - c) <= half && Math.abs(y - c) <= half && Math.abs(z - c) <= half) {
          data[x + n * (y + n * z)] = value;
        }
      }
  return data;
}
