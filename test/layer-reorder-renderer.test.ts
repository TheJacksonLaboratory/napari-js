import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The renderer's bookkeeping (one visual per layer id, drawn in `items` order) is GPU-free; only
// the visuals themselves and the device need a GPU. Swap those for recorders so the test can see
// which visuals were created, disposed and drawn — and in what order — after a reorder.
const log = vi.hoisted(() => ({
  created: [] as string[],
  disposed: [] as string[],
  drawn: [] as string[],
}));

vi.mock('../src/visuals/points-visual', () => ({
  PointsVisual: class {
    readonly ndisplay = 2;
    constructor(
      _device: unknown,
      _format: unknown,
      private readonly layer: { name: string },
    ) {
      log.created.push(layer.name);
    }
    sync(): void {}
    draw(): void {
      log.drawn.push(this.layer.name);
    }
    dispose(): void {
      log.disposed.push(this.layer.name);
    }
  },
}));

const fakeDevice = {
  lost: new Promise(() => {}),
  limits: { maxTextureDimension2D: 8192 },
  queue: { submit: () => {} },
  destroy: () => {},
  createCommandEncoder: () => ({
    beginRenderPass: () => ({ end: () => {} }),
    finish: () => ({}),
  }),
};

vi.mock('../src/engine/device', () => ({
  acquireDevice: async () => ({ device: fakeDevice, features: { float32Filterable: false } }),
}));

vi.mock('../src/engine/canvas', () => ({
  CanvasTarget: class {
    readonly format = 'bgra8unorm';
    readonly view = {};
    constructor(readonly canvas: unknown) {}
    syncSize(): boolean {
      return false;
    }
  },
}));

import { Renderer } from '../src/engine/renderer';
import { Viewer } from '../src/viewer';
import { Camera } from '../src/camera/camera';
import { Camera3D } from '../src/camera/camera3d';
import { LayerList } from '../src/scene/layer-list';
import { PointsLayer } from '../src/layers/points-layer';

const canvas = { clientWidth: 100, clientHeight: 100, width: 100, height: 100 };
const inputs = { camera2d: new Camera(), camera3d: new Camera3D(), ndisplay: 2 as const, z: 0 };
const mk = (name: string): PointsLayer => new PointsLayer([[0, 0]], { name });

beforeEach(() => {
  log.created.length = 0;
  log.disposed.length = 0;
  log.drawn.length = 0;
});

describe('Renderer after LayerList.move', () => {
  it('keeps every visual and draws in the new items order', () => {
    const renderer = new Renderer(fakeDevice as never, { canvas, view: {} } as never);
    const list = new LayerList();
    list.added.connect((l) => renderer.addLayer(l));
    list.removed.connect((l) => renderer.removeLayer(l.id));
    const a = list.add(mk('a'));
    list.add(mk('b'));
    list.add(mk('c'));
    renderer.render(inputs, list.items);
    expect(log.drawn).toEqual(['a', 'b', 'c']);

    log.drawn.length = 0;
    list.move(a, 2);
    renderer.render(inputs, list.items);
    expect(log.drawn).toEqual(['b', 'c', 'a']);
    expect(log.created).toEqual(['a', 'b', 'c']); // nothing rebuilt
    expect(log.disposed).toEqual([]); // nothing torn down
    expect(renderer.has(a.id)).toBe(true);
  });

  it('for contrast: a remove + re-add disposes and recreates the visual', () => {
    const renderer = new Renderer(fakeDevice as never, { canvas, view: {} } as never);
    const list = new LayerList();
    list.added.connect((l) => renderer.addLayer(l));
    list.removed.connect((l) => renderer.removeLayer(l.id));
    const a = list.add(mk('a'));
    list.add(mk('b'));
    list.remove(a);
    list.add(a);
    expect(log.disposed).toEqual(['a']);
    expect(log.created).toEqual(['a', 'b', 'a']);
  });
});

describe('Viewer after LayerList.move', () => {
  let frames: FrameRequestCallback[] = [];
  const flush = (): void => {
    const pending = frames;
    frames = [];
    for (const f of pending) f(0);
  };

  beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redraws in the new order without disposing or recreating a visual', async () => {
    const viewer = new Viewer({
      canvas: { ...canvas, getBoundingClientRect: () => ({ left: 0, top: 0 }) } as never,
      controls: false,
      autoResize: false,
    });
    await viewer.ready;
    const a = viewer.addPoints([[0, 0]], { name: 'a' });
    viewer.addPoints([[1, 1]], { name: 'b' });
    flush();
    expect(log.drawn).toEqual(['a', 'b']);

    log.drawn.length = 0;
    viewer.layers.move(a, 1);
    flush(); // the move alone scheduled the redraw
    expect(log.drawn).toEqual(['b', 'a']);
    expect(log.created).toEqual(['a', 'b']);
    expect(log.disposed).toEqual([]);
    viewer.dispose();
  });
});
