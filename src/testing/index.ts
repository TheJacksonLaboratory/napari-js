// `napari-js/testing`: the whole public API, with a GPU-free `Viewer`.
//
// Everything is re-exported from the main entry — the same classes, not copies, so a layer
// built here passes `instanceof` against the real ones — except `Viewer`, which is bound to
// {@link HeadlessViewer}. A test runner can therefore map `napari-js` to this module and run
// code that does `new Viewer({ canvas })` without WebGPU, instead of keeping a hand-written stub.
export * from '../index';
export { HeadlessViewer, HeadlessViewer as Viewer } from './headless-viewer';
export type { HeadlessViewerOptions, CanvasRect } from './headless-viewer';
export type { CanvasGeometry } from '../viewer-base';
