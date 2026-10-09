// `napari-js/geometry`: framework-free raster/vector geometry — the operations behind napari's
// Labels tools and shapes utilities (`polygon2mask`, fill bucket, label contours,
// `points_in_poly`). Rings are flat `[x0, y0, x1, y1, …]`; rasters are row-major `Grid`s.
export { pointInRing, pointInPolygonWithHoles, ringArea } from './ring';
export type { Ring } from './ring';
export { rasterizePolygon, floodFill, RASTER_MAX_PIXELS } from './raster';
export type { Grid, BBoxMask, RasterBounds, RasterizeOptions, FloodFillOptions } from './raster';
export { labelComponents, traceContours } from './contour';
export type { Components, Contour, TraceOptions, Connectivity } from './contour';
export { autoContrastLimits } from '../color/histogram';
export type { AutoContrastOptions } from '../color/histogram';
