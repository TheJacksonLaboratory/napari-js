// `napari-js/overlays`: DOM chrome drawn over the canvas — scale bar, 3D axes labels and the
// 2D navigator (napari's viewer overlays). Each takes `(host, viewer, opts)` and has
// `dispose()`. A separate entry so the main bundle stays free of DOM UI a host may not want.
export {
  ScaleBarOverlay,
  scaleBarFor,
  formatLength,
  niceLength,
  SCALE_BAR_TARGET_PX,
} from './scale-bar';
export type { ScaleBarOverlayOptions, ScaleBarSpec } from './scale-bar';
export { AxesLabelsOverlay } from './axes-labels';
export type { AxesLabelsOverlayOptions, AxisLabelSpec } from './axes-labels';
export {
  NavigatorOverlay,
  navigatorLayout,
  navigatorToWorld,
  NAVIGATOR_SIZE_RATIO,
  NAVIGATOR_MIN_PX,
  NAVIGATOR_MAX_PX,
} from './navigator';
export type { NavigatorOverlayOptions, NavigatorLayout } from './navigator';
export type { OverlayViewer } from './common';
