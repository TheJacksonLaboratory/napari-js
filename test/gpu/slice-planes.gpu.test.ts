import { afterEach, beforeEach, expect, it } from 'vitest';

import { projectPoint, type PixelData, type Viewer } from '../../src';
import { SlicePlanesWidget, slicePlaneCorners, type SliceAxis } from '../../src/overlays';
import {
  SIZE,
  SOFTWARE,
  cubeVolume,
  describeGpu,
  disposeViewer,
  makeViewer,
  pixel,
} from './harness';

const TOL = SOFTWARE ? 6 : 4;
const C = SIZE / 2;
const N = 32;

describeGpu('slice-plane widget on the GPU', () => {
  let viewer: Viewer;
  let host: HTMLDivElement;
  let widget: SlicePlanesWidget | null = null;
  beforeEach(async () => {
    viewer = await makeViewer();
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => {
    widget?.dispose();
    widget = null;
    host.remove();
    disposeViewer(viewer);
  });

  const look = (azimuth: number, elevation = 0) => {
    viewer.camera3d.azimuth = azimuth;
    viewer.camera3d.elevation = elevation;
  };

  /** The screen rectangle and centre of a plane's quad (the viewer's own projection). */
  const projected = (axis: SliceAxis, at: number) => {
    const [vw, vh] = viewer.viewportSize();
    const mvp = viewer.camera3d.viewProjection(vw, vh);
    const c = slicePlaneCorners({ shape: [N, N, N] }, axis, at);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 12; i += 3) {
      const s = projectPoint(mvp, [c[i], c[i + 1], c[i + 2]], vw, vh);
      xs.push(s.x);
      ys.push(s.y);
    }
    return {
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys),
      cx: xs.reduce((a, b) => a + b) / 4,
    };
  };

  /** Mean x of the pixels whose `channel` leads the other two by `margin`. */
  const centroidX = (px: PixelData, channel: 0 | 1 | 2, margin = 8): number => {
    let sum = 0;
    let n = 0;
    for (let y = 0; y < px.height; y++)
      for (let x = 0; x < px.width; x++) {
        const p = pixel(px, x, y);
        const others = [0, 1, 2].filter((c) => c !== channel).map((c) => p[c]);
        if (p[channel] > Math.max(...others) + margin) {
          sum += x + 0.5;
          n++;
        }
      }
    expect(n).toBeGreaterThan(0);
    return sum / n;
  };

  it('draws a plane in its axis colour across the volume’s box, and nothing outside it', async () => {
    const volume = viewer.addVolume(new Uint8Array(N * N * N), N, N, N, { colormap: 'gray' });
    look(0);
    widget = new SlicePlanesWidget(host, viewer, { volume, axes: ['z'] });
    const px = await viewer.readDisplayedPixels();
    const [r, g, b] = pixel(px, C, C);
    expect(b).toBeGreaterThan(20); // the z plane is blue
    expect(b).toBeGreaterThan(g + 4);
    expect(b).toBeGreaterThan(r + 4);
    const q = projected('z', (N - 1) / 2);
    // Lit inside the projected quad, black outside it.
    expect(Math.max(...pixel(px, q.x0 + 2, q.y0 + 2).slice(0, 3))).toBeGreaterThan(10);
    expect(Math.max(...pixel(px, q.x1 - 3, q.y1 - 3).slice(0, 3))).toBeGreaterThan(10);
    if (q.x0 > 3) expect(pixel(px, q.x0 - 3, C).slice(0, 3)).toEqual([0, 0, 0]);
    if (q.x1 < SIZE - 3) expect(pixel(px, q.x1 + 2, C).slice(0, 3)).toEqual([0, 0, 0]);
  });

  it('moves a plane’s pixels with it, where the viewer projects it', async () => {
    const volume = viewer.addVolume(new Uint8Array(N * N * N), N, N, N, { colormap: 'gray' });
    look(0.5, 0.2);
    widget = new SlicePlanesWidget(host, viewer, { volume, axes: ['x'], positions: { x: 6 } });
    const before = centroidX(await viewer.readDisplayedPixels(), 0);
    expect(Math.abs(before - projected('x', 6).cx)).toBeLessThan(3);
    widget.setPosition('x', 25);
    const after = centroidX(await viewer.readDisplayedPixels(), 0);
    expect(Math.abs(after - projected('x', 25).cx)).toBeLessThan(3);
    expect(after - before).toBeGreaterThan(5); // it moved right, as +x does from this side
    // Hidden, it draws nothing.
    widget.setVisible('x', false);
    const hidden = await viewer.readDisplayedPixels();
    expect(Math.max(...pixel(hidden, Math.round(after), C).slice(0, 3))).toBeLessThanOrEqual(TOL);
  });

  it('is translucent: the volume shows through a plane in front of it', async () => {
    const volume = viewer.addVolume(cubeVolume(N, 6, 255), N, N, N, {
      rendering: 'mip',
      colormap: 'gray',
    });
    look(0);
    const bare = pixel(await viewer.readDisplayedPixels(), C, C);
    widget = new SlicePlanesWidget(host, viewer, { volume, axes: ['z'], positions: { z: N - 1 } });
    const [r, , b] = pixel(await viewer.readDisplayedPixels(), C, C);
    expect(r).toBeGreaterThan(bare[0] * 0.6); // the cube still shows
    expect(b).toBeGreaterThanOrEqual(r - TOL); // tinted toward the plane's blue
  });
});
