import { describe, it, expect } from 'vitest';
import * as testing from '../src/testing';
import { HeadlessViewer } from '../src/testing';
import * as main from '../src/index';
import { Viewer } from '../src/viewer';
import { ImageLayer } from '../src/layers/image-layer';
import { PointsLayer } from '../src/layers/points-layer';
import { Points3DLayer } from '../src/layers/points3d-layer';
import { SurfaceLayer } from '../src/layers/surface-layer';
import { VolumeLayer } from '../src/layers/volume-layer';
import { AxesLayer } from '../src/layers/axes-layer';
import { LabelsLayer } from '../src/layers/labels-layer';
import { ShapesLayer } from '../src/layers/shapes-layer';
import { Camera } from '../src/camera/camera';
import { framingFor, unionBounds } from '../src/scene/fit';
import { projectPoints } from '../src/picking/project';

// Compile-time: every public member of Viewer exists on HeadlessViewer, so code written against
// Viewer can be handed one. A member added to Viewer alone fails `npm run typecheck` here.
const missingFromHeadless: Record<Exclude<keyof Viewer, keyof HeadlessViewer>, never> = {};

const CLOUD = new Float32Array([0, 0, 0, 10, 0, 0, 10, 20, 0, 0, 20, 40]);

/** A canvas-shaped object for the real Viewer, which only reads geometry for these calls. */
const fakeCanvas = (left: number, top: number, width: number, height: number) =>
  ({
    clientWidth: width,
    clientHeight: height,
    width,
    height,
    getBoundingClientRect: () => ({ left, top, width, height }),
  }) as unknown as HTMLCanvasElement;

/** A real Viewer whose GPU init fails (no navigator.gpu here) — its model half still works. */
function realViewer(canvas: HTMLCanvasElement, fit3d?: 'always' | 'once' | 'never'): Viewer {
  const v = new Viewer({ canvas, controls: false, autoResize: false, fit3d });
  v.ready.catch(() => {}); // WebGPUUnsupportedError, expected in node
  return v;
}

describe('napari-js/testing entry', () => {
  it('is the whole public API, with Viewer bound to HeadlessViewer', () => {
    expect(Object.keys(missingFromHeadless)).toEqual([]);
    expect(testing.Viewer).toBe(HeadlessViewer);
    for (const name of Object.keys(main)) {
      if (name === 'Viewer') continue;
      // The same bindings, not copies: a layer built through the testing entry is an instance
      // of the main entry's class.
      expect(testing[name as keyof typeof testing], name).toBe(main[name as keyof typeof main]);
    }
  });

  it('constructs and is ready without WebGPU', async () => {
    expect((globalThis.navigator as { gpu?: unknown } | undefined)?.gpu).toBeUndefined();
    const viewer = new HeadlessViewer();
    await expect(viewer.ready).resolves.toBeUndefined();
    expect(viewer.device).toBeUndefined();
    expect(() => viewer.requestRender()).not.toThrow();
    // Accepts what a Viewer would be given, and keeps it for assertions.
    const withOpts = new testing.Viewer({ clickZoomFactor: 0, controls: false });
    expect(withOpts.options.clickZoomFactor).toBe(0);
    expect(withOpts.controlsActive).toBe(false);
    withOpts.setControlsEnabled(true);
    expect(withOpts.controlsActive).toBe(true);
  });
});

describe('HeadlessViewer add*', () => {
  it('returns real, mounted layers', () => {
    const v = new HeadlessViewer();
    const img = v.addImage({
      kind: 'typed',
      width: 4,
      height: 2,
      channels: 1,
      dtype: 'uint8',
      data: new Uint8Array(8),
    });
    const pts = v.addPoints([[1, 2]], { faceColor: new Float32Array([1, 0, 0, 1]) });
    const labels = v.addLabels(new Uint8Array(4), 2, 2);
    const shapes = v.addShapes(new Float32Array([0, 0, 1, 0, 1, 1]), new Uint32Array([0, 3]));
    expect(img).toBeInstanceOf(ImageLayer);
    expect(pts).toBeInstanceOf(PointsLayer);
    expect(labels).toBeInstanceOf(LabelsLayer);
    expect(shapes).toBeInstanceOf(ShapesLayer);
    expect(v.dims.ndisplay).toBe(2); // 2D adders stay in 2D
    const vol = v.addVolume(new Uint8Array(8), 2, 2, 2, { invert: true });
    const surf = v.addSurface(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 1]),
      new Uint32Array([0, 1, 2]),
    );
    const p3 = v.addPoints3D(CLOUD);
    const axes = v.addAxes(2, 2, 2);
    expect(vol).toBeInstanceOf(VolumeLayer);
    expect(vol.invert).toBe(true);
    expect(surf).toBeInstanceOf(SurfaceLayer);
    expect(p3).toBeInstanceOf(Points3DLayer);
    expect(axes).toBeInstanceOf(AxesLayer);
    expect(v.layers.items).toEqual([img, pts, labels, shapes, vol, surf, p3, axes]);
    expect(v.dims.ndisplay).toBe(3);
    // Real validation, which a stub would skip.
    expect(() => v.addPoints3D(new Float32Array(4))).toThrow(/multiple of 3/);
  });

  it('fits the first 2D image to the canvas, like Viewer', () => {
    const v = new HeadlessViewer({ canvasRect: { width: 400, height: 300 } });
    v.addImage({
      kind: 'typed',
      width: 800,
      height: 200,
      channels: 1,
      dtype: 'uint8',
      data: new Uint8Array(160000),
    });
    const want = new Camera();
    want.fit(800, 200, 400, 300);
    expect(v.camera.zoom).toBe(want.zoom);
    expect(v.camera.center).toEqual(want.center);
  });
});

describe('HeadlessViewer framing', () => {
  it('fitToLayers frames exactly like the real Viewer', () => {
    const canvas = fakeCanvas(0, 0, 300, 600); // portrait, so the aspect matters
    const real = realViewer(canvas, 'never');
    const headless = new HeadlessViewer({ canvas, fit3d: 'never' });
    for (const v of [real, headless]) {
      v.addPoints3D(CLOUD);
      v.addSurface(new Float32Array([-5, -5, -5, 0, 0, 0, 1, 1, 1]), new Uint32Array([0, 1, 2]));
      expect(v.fitToLayers()).toBe(true);
    }
    expect(headless.camera3d.target).toEqual(real.camera3d.target);
    expect(headless.camera3d.distance).toBe(real.camera3d.distance);
    // ...which is framingFor over the union, at the canvas's aspect.
    const want = framingFor(unionBounds(headless.layers)!, {
      fov: headless.camera3d.fov,
      aspect: 300 / 600,
    });
    expect(headless.camera3d.target).toEqual(want.target);
    expect(headless.camera3d.distance).toBeCloseTo(want.distance, 10);
    real.dispose();
  });

  it('honours the fit3d policy on adds', () => {
    const v = new HeadlessViewer({ fit3d: 'once' });
    v.addPoints3D(CLOUD);
    const first = v.camera3d.distance;
    v.addPoints3D(new Float32Array([0, 0, 0, 500, 500, 500]));
    expect(v.camera3d.distance).toBe(first); // `once`: the second add leaves the pose alone
    expect(new HeadlessViewer().fitToLayers()).toBe(false); // nothing 3D mounted
  });
});

describe('HeadlessViewer canvas geometry', () => {
  it('worldToCanvas / canvasToWorld honour a non-zero canvas offset', () => {
    const rect = { left: 120, top: 45, width: 400, height: 200 };
    const v = new HeadlessViewer({ canvasRect: rect });
    v.camera.set([50, 60], 2);
    // The world centre sits at the canvas centre, in page coordinates.
    expect(v.worldToCanvas(50, 60)).toEqual([120 + 200, 45 + 100]);
    expect(v.worldToCanvas(60, 50)).toEqual([320 + 20, 145 - 20]);
    expect(v.canvasToWorld(340, 125)).toEqual([60, 50]);
    // Same answers as the real Viewer over a canvas at the same place.
    const real = realViewer(fakeCanvas(120, 45, 400, 200));
    real.camera.set([50, 60], 2);
    expect(v.worldToCanvas(7, 9)).toEqual(real.worldToCanvas(7, 9));
    expect(v.visibleWorldRect()).toEqual(real.visibleWorldRect());
    real.dispose();
  });

  it('setCanvasRect moves the canvas', () => {
    const v = new HeadlessViewer();
    v.camera.set([0, 0], 1);
    expect(v.worldToCanvas(0, 0)).toEqual([400, 300]); // default 800×600 at the origin
    v.setCanvasRect({ left: 10, top: 20, width: 100, height: 50 });
    expect(v.worldToCanvas(0, 0)).toEqual([60, 45]);
  });

  it('projectPoints uses the canvas size, and is null with none', () => {
    const v = new HeadlessViewer({ canvasRect: { width: 640, height: 480 } });
    v.addPoints3D(CLOUD);
    const got = v.projectPoints(CLOUD)!;
    const want = projectPoints(v.camera3d.viewProjection(640, 480), CLOUD, 640, 480);
    expect(Array.from(got.screen)).toEqual(Array.from(want.screen));
    v.setCanvasRect({ width: 0, height: 0 });
    expect(v.projectPoints(CLOUD)).toBeNull();
  });
});

describe('HeadlessViewer readback', () => {
  it('is a deterministic blank frame at the drawing size', async () => {
    const v = new HeadlessViewer({ canvasRect: { width: 3, height: 2 } });
    const px = await v.readDisplayedPixels();
    expect([px.width, px.height, px.channels]).toEqual([3, 2, 4]);
    expect(Array.from(px.data)).toEqual(new Array(24).fill(0));
    const hist = await v.histogram(4);
    expect(Array.from(hist.counts)).toEqual([6, 0, 0, 0]);
    const blob = await v.screenshot();
    expect(blob.type).toBe('image/png');
  });

  it('rejects after dispose, as Viewer does without a renderer', async () => {
    const v = new HeadlessViewer();
    v.dispose();
    await expect(v.readDisplayedPixels()).rejects.toThrow(/not ready/);
  });
});
