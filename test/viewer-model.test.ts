import { describe, it, expect } from 'vitest';
import { ViewerModel } from '../src/scene/viewer-model';
import { PointsLayer } from '../src/layers/points-layer';

describe('ViewerModel', () => {
  it('exposes layers, camera, camera3d, and dims', () => {
    const m = new ViewerModel();
    expect(m.layers.length).toBe(0);
    expect(m.camera.zoom).toBeGreaterThan(0);
    expect(m.dims.ndisplay).toBe(2);
    expect(m.camera3d.distance).toBeGreaterThan(0);
  });

  it('bubbles layer-list, camera, dims, and per-layer changes into `changed`', () => {
    const m = new ViewerModel();
    let n = 0;
    m.changed.connect(() => n++);

    const layer = new PointsLayer([[0, 0]]);
    m.layers.add(layer);
    const afterAdd = n;
    expect(afterAdd).toBeGreaterThan(0);

    layer.opacity = 0.5; // per-layer change bubbles
    expect(n).toBeGreaterThan(afterAdd);

    const beforeCamera = n;
    m.camera.zoom = 3;
    m.camera3d.orbit(0.1, 0);
    m.dims.ndisplay = 3;
    expect(n).toBeGreaterThan(beforeCamera);
  });

  it('stops bubbling a layer after it is removed', () => {
    const m = new ViewerModel();
    const layer = new PointsLayer([[0, 0]]);
    m.layers.add(layer);
    let n = 0;
    m.changed.connect(() => n++);
    m.layers.remove(layer);
    const afterRemove = n;
    layer.opacity = 0.1; // disposer detached → no longer bubbles
    expect(n).toBe(afterRemove);
  });
});

describe('ViewerModel with a duplicate add', () => {
  it('keeps one listener per layer, so a removed layer stops forwarding changes', () => {
    const m = new ViewerModel();
    const a = m.layers.add(new PointsLayer([[0, 0]]));
    // A second add used to mount `a` twice and overwrite its disposer, leaking a listener.
    expect(() => m.layers.add(a)).toThrow(/already in the list/);
    m.layers.remove(a);
    let changed = 0;
    m.changed.connect(() => changed++);
    a.opacity = 0.5;
    expect(changed).toBe(0);
  });
});

describe('ViewerModel after a layer move', () => {
  it('still forwards the moved layer’s changes, and the move itself', () => {
    const m = new ViewerModel();
    const a = m.layers.add(new PointsLayer([[0, 0]]));
    m.layers.add(new PointsLayer([[1, 1]]));
    let changed = 0;
    m.changed.connect(() => changed++);
    m.layers.move(a, 1);
    expect(changed).toBe(1);
    // The per-layer subscription survives: a move is not a remove, so nothing unhooked it.
    a.opacity = 0.5;
    expect(changed).toBe(2);
  });
});
