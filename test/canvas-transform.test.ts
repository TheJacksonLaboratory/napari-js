import { describe, it, expect } from 'vitest';
import { HeadlessViewer } from '../src/testing';
import { ViewerBase } from '../src/viewer-base';

const apply = (m: number[], x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

describe('canvasTransform / worldToCanvasLocal', () => {
  const poses: [[number, number], number][] = [
    [[0, 0], 1],
    [[512, 384], 0.25],
    [[-40.5, 1000], 7.5],
  ];
  const rects = [
    { left: 0, top: 0, width: 800, height: 600 },
    { left: 37, top: 112.5, width: 640, height: 360 },
  ];

  for (const rect of rects) {
    for (const [center, zoom] of poses) {
      it(`equals worldToCanvas minus the canvas rect (rect ${rect.left},${rect.top}; zoom ${zoom})`, () => {
        const viewer = new HeadlessViewer({ canvasRect: rect });
        viewer.camera.set(center, zoom);
        const m = viewer.canvasTransform();
        expect([m[1], m[2]]).toEqual([0, 0]); // no rotation or shear in the 2D camera
        for (const [x, y] of [
          [0, 0],
          [123.25, -7],
          [center[0], center[1]],
        ]) {
          const [cx, cy] = viewer.worldToCanvas(x, y);
          const want: [number, number] = [cx - rect.left, cy - rect.top];
          const viaMatrix = apply(m, x, y);
          const local = viewer.worldToCanvasLocal(x, y);
          expect(viaMatrix[0]).toBeCloseTo(want[0], 9);
          expect(viaMatrix[1]).toBeCloseTo(want[1], 9);
          expect(local[0]).toBeCloseTo(want[0], 9);
          expect(local[1]).toBeCloseTo(want[1], 9);
        }
        // The camera centre lands mid-canvas.
        expect(viewer.worldToCanvasLocal(center[0], center[1])).toEqual([
          rect.width / 2,
          rect.height / 2,
        ]);
      });
    }
  }

  it('inverts canvasToWorld once the rect origin is added back', () => {
    const rect = { left: 10, top: 20, width: 300, height: 200 };
    const viewer = new HeadlessViewer({ canvasRect: rect });
    viewer.camera.set([50, 60], 3);
    const [lx, ly] = viewer.worldToCanvasLocal(41, 77);
    const [wx, wy] = viewer.canvasToWorld(lx + rect.left, ly + rect.top);
    expect(wx).toBeCloseTo(41, 9);
    expect(wy).toBeCloseTo(77, 9);
  });

  it('reads no layout: getBoundingClientRect is never called', () => {
    let reads = 0;
    const canvas = {
      clientWidth: 400,
      clientHeight: 300,
      width: 800,
      height: 600,
      getBoundingClientRect() {
        reads++;
        return { left: 5, top: 5, width: 400, height: 300 };
      },
    };
    const viewer = new HeadlessViewer({ canvas: canvas as unknown as HTMLCanvasElement });
    viewer.camera.set([10, 10], 2);
    reads = 0;
    expect(viewer.canvasTransform()).toEqual([2, 0, 0, 2, 180, 130]);
    expect(viewer.worldToCanvasLocal(20, 10)).toEqual([220, 150]);
    expect(reads).toBe(0);
    // The CSS size (clientWidth), not the drawing buffer, as the renderer projects with.
    expect(viewer.viewportSize()).toEqual([400, 300]);
  });

  it('lives on ViewerBase, so Viewer and HeadlessViewer share it', () => {
    expect(ViewerBase.prototype.canvasTransform).toBeTypeOf('function');
    expect(ViewerBase.prototype.worldToCanvasLocal).toBeTypeOf('function');
  });
});
