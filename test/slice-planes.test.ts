import { describe, it, expect } from 'vitest';
import {
  SlicePlanesWidget,
  rayAxisParam,
  slicePlaneCorners,
  slicePlaneGripPoint,
  volumeDataToWorld,
  type SliceAxis,
  type SlicePlaneChange,
} from '../src/overlays';
import { DEFAULT_AXES_COLORS, projectPoint } from '../src';
import { HeadlessViewer } from '../src/testing';
import { fakeHost, type FakeElement } from './helpers/fake-dom';

const W = 40,
  H = 30,
  D = 20;
const volumeData = () => new Uint8Array(W * H * D);

function setup(opts: Partial<ConstructorParameters<typeof SlicePlanesWidget>[2]> = {}) {
  const { host, el } = fakeHost(800, 600);
  const viewer = new HeadlessViewer({ canvasRect: { width: 800, height: 600 } });
  const volume = viewer.addVolume(volumeData(), W, H, D, { voxelSize: [1, 1, 2] });
  const widget = new SlicePlanesWidget(host, viewer, { volume, ...opts });
  return { host, el, viewer, volume, widget };
}

/** The canvas point where world `p` projects (the viewer's own viewport, as the widget uses). */
function screenOf(viewer: HeadlessViewer, p: readonly [number, number, number]): [number, number] {
  const [vw, vh] = viewer.viewportSize();
  const s = projectPoint(viewer.camera3d.viewProjection(vw, vh), p, vw, vh);
  expect(s.visible).toBe(true);
  return [s.x, s.y];
}

function grip(el: FakeElement, axis: SliceAxis): FakeElement {
  return el.children.find((c) => c.textContent === axis.toUpperCase())!;
}

describe('slice-plane geometry', () => {
  const box = { shape: [W, H, D] as const, voxelSize: [1, 1, 2] as const };

  it('maps data to world as the volume visual does: voxel i centred on i, box centred', () => {
    expect(volumeDataToWorld(box, [-0.5, -0.5, -0.5])).toEqual([-20, -15, -20]);
    expect(volumeDataToWorld(box, [W - 0.5, H - 0.5, D - 0.5])).toEqual([20, 15, 20]);
    expect(volumeDataToWorld(box, [0, 0, 0])).toEqual([-19.5, -14.5, -19]);
  });

  it('spans the box with each plane, at its position along its axis', () => {
    const z = slicePlaneCorners(box, 'z', 5);
    for (let i = 2; i < 12; i += 3) expect(z[i]).toBe(volumeDataToWorld(box, [0, 0, 5])[2]);
    expect([
      Math.min(...z.filter((_, i) => i % 3 === 0)),
      Math.max(...z.filter((_, i) => i % 3 === 0)),
    ]).toEqual([-20, 20]);
    const x = slicePlaneCorners(box, 'x', 0);
    for (let i = 0; i < 12; i += 3) expect(x[i]).toBe(-19.5);
  });

  it('finds where a ray passes nearest an axis line', () => {
    // A ray along −z through (3, 7, …) passes the x-axis line through the origin at x = 3.
    expect(rayAxisParam({ origin: [3, 7, 50], dir: [0, 0, -1] }, [0, 0, 0], 'x')).toBeCloseTo(3);
    expect(rayAxisParam({ origin: [3, 7, 50], dir: [0, 0, -1] }, [0, 0, 0], 'y')).toBeCloseTo(7);
    // Along the line itself: no answer.
    expect(rayAxisParam({ origin: [0, 0, 50], dir: [0, 0, -1] }, [0, 0, 0], 'z')).toBeNull();
  });
});

describe('SlicePlanesWidget', () => {
  it('adds one translucent quad per axis in its axis colour, through the middle, without framing', () => {
    const { viewer, widget } = setup();
    expect(viewer.layers.items).toHaveLength(4); // the volume + three planes
    for (const axis of ['x', 'y', 'z'] as const) {
      const layer = widget.layer(axis)!;
      expect(layer.color).toEqual([...DEFAULT_AXES_COLORS[axis], 1]);
      expect(layer.opacity).toBeCloseTo(0.22);
      expect(layer.blending).toBe('translucent');
    }
    expect(widget.position('x')).toBe((W - 1) / 2);
    expect(widget.position('z')).toBe((D - 1) / 2);
  });

  it('places each grip where its plane’s grip point projects, and hides them outside 3D', () => {
    const { el, viewer, widget } = setup({ positions: { x: 4, y: 20, z: 3 } });
    for (const axis of ['x', 'y', 'z'] as const) {
      const [x, y] = screenOf(
        viewer,
        slicePlaneGripPoint(
          { shape: [W, H, D], voxelSize: [1, 1, 2] },
          axis,
          widget.position(axis),
        ),
      );
      const g = grip(el, axis);
      expect(g.style.display).toBe('');
      expect(parseFloat(g.style.left)).toBeCloseTo(x, 3);
      expect(parseFloat(g.style.top)).toBeCloseTo(y, 3);
    }
    viewer.camera3d.orbit(0.8, -0.3);
    const [x] = screenOf(
      viewer,
      slicePlaneGripPoint({ shape: [W, H, D], voxelSize: [1, 1, 2] }, 'z', 3),
    );
    expect(parseFloat(grip(el, 'z').style.left)).toBeCloseTo(x, 3);
    viewer.dims.ndisplay = 2;
    expect(grip(el, 'z').style.display).toBe('none');
  });

  it('moves a plane in place: same layer, its quad replaced, no layer added or removed', () => {
    const { viewer, widget } = setup();
    const layer = widget.layer('z')!;
    const version = layer.dataVersion;
    let churn = 0;
    viewer.layers.added.connect(() => churn++);
    viewer.layers.removed.connect(() => churn++);
    const events: SlicePlaneChange[] = [];
    widget.changed.connect((e) => events.push(e));
    widget.setPosition('z', 7);
    expect(widget.layer('z')).toBe(layer);
    expect(layer.dataVersion).toBe(version + 1);
    expect(layer.vertices[2]).toBe(
      volumeDataToWorld({ shape: [W, H, D], voxelSize: [1, 1, 2] }, [0, 0, 7])[2],
    );
    expect(churn).toBe(0);
    expect(events).toEqual([{ axis: 'z', value: 7, dragging: false }]);
  });

  it('clamps positions to the voxel centres, and snaps when asked', () => {
    const { widget } = setup();
    widget.setPosition('x', -5);
    expect(widget.position('x')).toBe(0);
    widget.setPosition('x', 1e6);
    expect(widget.position('x')).toBe(W - 1);
    const snapped = setup({ snap: true }).widget;
    snapped.setPosition('y', 4.6);
    expect(snapped.position('y')).toBe(5);
  });

  it('drags a plane along its axis by its grip, at several camera angles', () => {
    for (const [az, el] of [
      [0, 0],
      [0.7, 0.3],
      [-1.2, -0.5],
      [2.4, 0.9],
    ]) {
      for (const axis of ['x', 'y', 'z'] as const) {
        const s = setup();
        s.viewer.camera3d.azimuth = az;
        s.viewer.camera3d.elevation = el;
        const box = { shape: [W, H, D] as const, voxelSize: [1, 1, 2] as const };
        const start = s.widget.position(axis);
        const target = start + (axis === 'z' ? -4 : 6);
        const from = screenOf(s.viewer, slicePlaneGripPoint(box, axis, start));
        const to = screenOf(s.viewer, slicePlaneGripPoint(box, axis, target));
        const g = grip(s.el, axis);
        const events: SlicePlaneChange[] = [];
        s.widget.changed.connect((e) => events.push(e));
        const down = g.dispatch('pointerdown', { clientX: from[0], clientY: from[1] });
        expect(down.stopped).toBe(true); // the camera does not orbit
        g.dispatch('pointermove', { clientX: to[0], clientY: to[1] });
        // A grip dragged to where the plane would put it at `target` moves the plane there.
        expect(s.widget.position(axis)).toBeCloseTo(target, 3);
        expect(s.widget.layer(axis)!.opacity).toBeCloseTo(0.4);
        g.dispatch('pointerup', { clientX: to[0], clientY: to[1] });
        expect(s.widget.layer(axis)!.opacity).toBeCloseTo(0.22);
        expect(events.at(-2)).toMatchObject({ axis, dragging: true });
        expect(events.at(-1)).toMatchObject({ axis, dragging: false });
        expect(events.at(-1)!.value).toBeCloseTo(target, 3);
      }
    }
  });

  it('steps a focused grip with the arrow keys', () => {
    const { el, widget } = setup({ positions: { z: 5 } });
    grip(el, 'z').dispatch('keydown', { key: 'ArrowUp' });
    expect(widget.position('z')).toBe(6);
    grip(el, 'z').dispatch('keydown', { key: 'ArrowDown', shiftKey: true });
    expect(widget.position('z')).toBe(0);
  });

  it('keeps the volume’s plane on a linked plane', () => {
    const { volume, widget } = setup({ linkPlane: 'z', positions: { z: 4 } });
    expect(volume.plane.position[2]).toBe(4);
    expect(volume.plane.normal).toEqual([0, 0, 1]);
    widget.setPosition('z', 9);
    expect(volume.plane.position[2]).toBe(9);
    widget.setPosition('x', 3); // not linked
    expect(volume.plane.normal).toEqual([0, 0, 1]);
  });

  it('follows the volume’s voxel size', () => {
    const { volume, widget } = setup({ positions: { z: 0 } });
    volume.voxelSize = [1, 1, 4];
    expect(widget.layer('z')!.vertices[2]).toBe(
      volumeDataToWorld({ shape: [W, H, D], voxelSize: [1, 1, 4] }, [0, 0, 0])[2],
    );
  });

  it('hides a plane with its grip', () => {
    const { el, widget } = setup();
    widget.setVisible('y', false);
    expect(widget.layer('y')!.visible).toBe(false);
    expect(grip(el, 'y').style.display).toBe('none');
    widget.setVisible('all', true);
    expect(widget.layer('y')!.visible).toBe(true);
    expect(grip(el, 'y').style.display).toBe('');
  });

  it('shows only the axes asked for, and no grips when told', () => {
    const { el, viewer, widget } = setup({ axes: ['z'], grips: false });
    expect(viewer.layers.items).toHaveLength(2);
    expect(widget.layer('x')).toBeUndefined();
    expect(el.children).toHaveLength(0);
  });

  it('disposes its planes, grips and listeners', () => {
    const { el, viewer, volume, widget } = setup();
    let events = 0;
    widget.changed.connect(() => events++);
    widget.dispose();
    expect(viewer.layers.items).toEqual([volume]);
    expect(el.children).toHaveLength(0);
    // Camera and volume changes no longer reach it.
    viewer.camera3d.orbit(0.5, 0);
    volume.voxelSize = [2, 2, 2];
    widget.setPosition('z', 1);
    expect(events).toBe(0);
    widget.dispose(); // idempotent
  });
});
