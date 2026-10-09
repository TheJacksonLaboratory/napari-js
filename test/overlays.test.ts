import { describe, it, expect, vi } from 'vitest';
import {
  ScaleBarOverlay,
  AxesLabelsOverlay,
  NavigatorOverlay,
  scaleBarFor,
  formatLength,
  niceLength,
  navigatorLayout,
  navigatorToWorld,
} from '../src/overlays';
import { HeadlessViewer } from '../src/testing';
import { fakeHost, type FakeElement } from './helpers/fake-dom';

const viewer = () => new HeadlessViewer({ canvasRect: { width: 800, height: 600 } });

describe('scale-bar maths', () => {
  it('snaps to the NEAREST 1/2/5 × 10ⁿ', () => {
    expect(niceLength(1.4)).toBe(1);
    expect(niceLength(1.6)).toBe(2);
    expect(niceLength(3.4)).toBe(2);
    expect(niceLength(3.6)).toBe(5);
    expect(niceLength(7.4)).toBe(5);
    expect(niceLength(8)).toBe(10);
    expect(niceLength(120)).toBe(100);
    expect(niceLength(0)).toBe(1);
  });

  it('scaleBarFor returns the length and its unrounded screen width', () => {
    // 2 screen px per world unit, 0.5 µm per world unit → 0.25 µm/px; 120 px ≈ 30 µm → 20 µm.
    expect(scaleBarFor(2, 0.5)).toEqual({ length: 20, widthPx: 80 });
    expect(scaleBarFor(1, 1, 300)).toEqual({ length: 200, widthPx: 200 });
  });

  it('scaleBarFor is null when a scale is unknown', () => {
    expect(scaleBarFor(0, 1)).toBeNull();
    expect(scaleBarFor(1, 0)).toBeNull();
    expect(scaleBarFor(Infinity, 1)).toBeNull();
    expect(scaleBarFor(1, NaN)).toBeNull();
  });

  it('formatLength picks the unit that suits the magnitude', () => {
    expect(formatLength(100)).toBe('100 µm');
    expect(formatLength(1500)).toBe('1.5 mm');
    expect(formatLength(1e4)).toBe('1 cm');
    expect(formatLength(2e6)).toBe('2 m');
    expect(formatLength(0.01)).toBe('10 nm');
    expect(formatLength(0.5, 'mm')).toBe('500 µm');
    expect(formatLength(3, 'um')).toBe('3 µm');
    expect(formatLength(250, 'px')).toBe('250 px');
    expect(formatLength(12.25, 'px')).toBe('12.3 px');
  });
});

describe('ScaleBarOverlay', () => {
  const bar = (el: FakeElement) => el.children[0];
  const label = (el: FakeElement) => bar(el).children[0].textContent;
  const lineWidth = (el: FakeElement) => bar(el).children[1].style.width;

  // SIV's napari-scale-bar golden table: zoom 1, varying µm/px.
  it.each<[number, string]>([
    [1, '100 µm'],
    [2.0833, '200 µm'],
    [5, '500 µm'],
    [7.5, '1 mm'],
    [1000, '10 cm'],
    [10000, '1 m'],
    [0.0001, '10 nm'],
  ])('labels unitPerWorld=%p as %p', (mpp, expected) => {
    const { host, el } = fakeHost();
    new ScaleBarOverlay(host, viewer(), { unitPerWorld: mpp });
    expect(label(el)).toBe(expected);
  });

  it('sizes the line, follows the camera and positions the host', () => {
    const { host, el } = fakeHost();
    const v = viewer();
    new ScaleBarOverlay(host, v, { unitPerWorld: 1 });
    expect(el.style.position).toBe('relative');
    expect(lineWidth(el)).toBe('100px');
    v.camera.zoom = 2; // 0.5 µm/px → 60 µm → 50 µm → 100 px
    expect(label(el)).toBe('50 µm');
    expect(lineWidth(el)).toBe('100px');
  });

  it('hides when the scale is unknown or when asked', () => {
    const { host, el } = fakeHost();
    const sb = new ScaleBarOverlay(host, viewer(), { unitPerWorld: 0 });
    expect(bar(el).style.display).toBe('none');
    sb.setOptions({ unitPerWorld: 1 });
    expect(bar(el).style.display).toBe('');
    sb.setVisible(false);
    expect(bar(el).style.display).toBe('none');
  });

  it('uses the 3D camera at its target depth in 3D', () => {
    const { host, el } = fakeHost();
    const v = viewer();
    const sb = new ScaleBarOverlay(host, v, { unitPerWorld: 1 });
    v.dims.ndisplay = 3;
    const pxPerWorld = 1 / v.camera3d.worldPerPixel(600);
    expect(sb.pxPerWorld()).toBeCloseTo(pxPerWorld);
    const spec = scaleBarFor(pxPerWorld, 1)!;
    expect(lineWidth(el)).toBe(`${Math.round(spec.widthPx)}px`);
    v.camera3d.distance *= 2; // the bar follows the orbit camera
    expect(sb.pxPerWorld()).toBeCloseTo(pxPerWorld / 2);
  });

  it('dispose removes the element and stops listening', () => {
    const { host, el } = fakeHost();
    const v = viewer();
    const sb = new ScaleBarOverlay(host, v, { unitPerWorld: 1 });
    const update = vi.spyOn(sb, 'update');
    sb.dispose();
    expect(el.children).toHaveLength(0);
    v.camera.zoom = 3;
    v.dims.ndisplay = 3;
    expect(update).not.toHaveBeenCalled();
  });
});

describe('AxesLabelsOverlay', () => {
  const labels = (v: HeadlessViewer) => {
    const t = v.camera3d.target;
    return [
      { anchor: [t[0], t[1], t[2]] as [number, number, number], text: 'X', color: '#f00' },
      { anchor: [t[0], t[1], t[2]] as [number, number, number], text: 'Y', color: '#0f0' },
    ];
  };

  it('projects each label through the 3D camera, and only shows in 3D', () => {
    const { host, el } = fakeHost();
    const v = viewer();
    new AxesLabelsOverlay(host, v, { labels: labels(v) });
    expect(el.children).toHaveLength(2);
    expect(el.children[0].style.display).toBe('none'); // 2D
    v.dims.ndisplay = 3;
    const x = el.children[0];
    expect(x.style.display).toBe('');
    expect(x.textContent).toBe('X');
    expect(x.style.color).toBe('#f00');
    // The camera's target projects to the canvas centre.
    expect(parseFloat(x.style.left)).toBeCloseTo(400, 3);
    expect(parseFloat(x.style.top)).toBeCloseTo(300, 3);
  });

  it('hides a label the projection rejects (behind the eye / clipped)', () => {
    const { host, el } = fakeHost();
    const v = viewer();
    v.dims.ndisplay = 3;
    v.projectPoints = () => ({
      screen: new Float32Array([NaN, NaN, 10, 20]),
      depth: new Float32Array([NaN, 1]),
    });
    new AxesLabelsOverlay(host, v, { labels: labels(v) });
    expect(el.children[0].style.display).toBe('none');
    expect(el.children[1].style.left).toBe('10px');
  });

  it('setLabels reuses elements for the same count and rebuilds otherwise', () => {
    const { host, el } = fakeHost();
    const v = viewer();
    v.dims.ndisplay = 3;
    const ov = new AxesLabelsOverlay(host, v, { labels: labels(v) });
    const first = el.children[0];
    ov.setLabels(labels(v).map((l) => ({ ...l, text: l.text + '!' })));
    expect(el.children[0]).toBe(first);
    expect(first.textContent).toBe('X!');
    ov.setLabels(labels(v).slice(0, 1));
    expect(el.children).toHaveLength(1);
    ov.setVisible(false);
    expect(el.children[0].style.display).toBe('none');
    ov.dispose();
    expect(el.children).toHaveLength(0);
  });
});

describe('NavigatorOverlay', () => {
  it('layout and point mapping (pure)', () => {
    expect(navigatorLayout(800, 1000, 500)).toEqual({ width: 128, height: 64, scale: 0.128 });
    expect(navigatorLayout(100, 1000, 500)!.width).toBe(110); // min size
    expect(navigatorLayout(4000, 1000, 500)!.width).toBe(300); // max size
    expect(navigatorLayout(0, 1000, 500)).toBeNull();
    const l = navigatorLayout(800, 1000, 500)!;
    expect(navigatorToWorld(64, 32, l, 1000, 500)).toEqual([500, 250]);
    expect(navigatorToWorld(-5, 999, l, 1000, 500)).toEqual([0, 500]);
  });

  it('draws the visible rect from the viewer, clipped to the box', () => {
    const { host, el } = fakeHost();
    const v = viewer();
    v.camera.set([500, 250], 1); // visible: x 100..900, y -50..550
    new NavigatorOverlay(host, v, { worldWidth: 1000, worldHeight: 500 });
    const box = el.children[0];
    expect(box.style.width).toBe('128px');
    expect(box.style.display).toBe('block');
    const region = box.children[1];
    expect(parseFloat(region.style.left)).toBeCloseTo(12.8);
    expect(parseFloat(region.style.top)).toBe(0);
    expect(parseFloat(region.style.width)).toBeCloseTo(102.4);
    expect(parseFloat(region.style.height)).toBe(64);
    v.camera.zoom = 4; // the region follows the camera: 200×150 world → 25.6×19.2 px
    expect(parseFloat(region.style.width)).toBeCloseTo(25.6);
  });

  it('re-centres the view on click and pan-drags, consuming the events', () => {
    const { host, el } = fakeHost();
    const v = viewer();
    v.camera.set([0, 0], 2);
    const onEnter = vi.fn();
    new NavigatorOverlay(host, v, { worldWidth: 1000, worldHeight: 500, onEnter });
    const box = el.children[0];
    const down = box.dispatch('pointerdown', { clientX: 64, clientY: 32 });
    expect(down.stopped).toBe(true);
    expect(v.camera.center).toEqual([500, 250]);
    expect(v.camera.zoom).toBe(2);
    box.dispatch('pointermove', { clientX: 12.8, clientY: 6.4 });
    expect(v.camera.center[0]).toBeCloseTo(100);
    box.dispatch('pointerup');
    box.dispatch('pointermove', { clientX: 64, clientY: 32 });
    expect(v.camera.center[0]).toBeCloseTo(100); // no longer dragging
    expect(box.dispatch('wheel').prevented).toBe(true);
    box.dispatch('pointerenter');
    expect(onEnter).toHaveBeenCalledOnce();
  });

  it('draws the thumbnail, hides in 3D and on request, and disposes cleanly', () => {
    const { host, el } = fakeHost();
    const v = viewer();
    const nav = new NavigatorOverlay(host, v, { worldWidth: 1000, worldHeight: 500 });
    const box = el.children[0];
    const canvas = box.children[0];
    const img = {} as CanvasImageSource;
    nav.setImage(img);
    expect(canvas.draws.at(-1)).toEqual(['drawImage', img, 0, 0, 128, 64]);
    v.dims.ndisplay = 3;
    expect(box.style.display).toBe('none');
    v.dims.ndisplay = 2;
    expect(box.style.display).toBe('block');
    nav.setVisible(false);
    expect(box.style.display).toBe('none');
    nav.setWorld(500, 1000);
    expect(nav.currentLayout).toEqual({ width: 64, height: 128, scale: 0.128 });
    nav.dispose();
    expect(el.children).toHaveLength(0);
    expect(box.listenerCount('pointerdown')).toBe(0);
  });
});
