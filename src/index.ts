// Public API barrel.

// Viewer + device
export { Viewer } from './viewer';
export type { ViewerOptions } from './viewer';
export { acquireDevice, WebGPUUnsupportedError } from './engine/device';
export type { DeviceContext, DeviceFeatures } from './engine/device';
export type { PixelData } from './engine/readback';

// Readback / analysis
export { histogramRGBA, histogramScalar, luminance8 } from './color/histogram';
export type { Histogram } from './color/histogram';

// Model
export { ViewerModel } from './scene/viewer-model';
export { LayerList } from './scene/layer-list';
export { Dims } from './scene/dims';
export { Camera } from './camera/camera';
export { Camera3D } from './camera/camera3d';
export type { CameraDragMode } from './camera/camera3d';
export { Layer } from './layers/layer';
export type { BlendMode } from './layers/layer';
export { ImageLayer } from './layers/image-layer';
export type { ImageLayerOptions, Interpolation } from './layers/image-layer';
export { PointsLayer } from './layers/points-layer';
export type { PointsLayerOptions, PointSymbol, RGBA } from './layers/points-layer';
export { LabelsLayer } from './layers/labels-layer';
export type { LabelsLayerOptions, LabelData } from './layers/labels-layer';
export { VolumeLayer } from './layers/volume-layer';
export type { VolumeLayerOptions, VolumeRendering } from './layers/volume-layer';
export { AxesLayer, axesLineVertices } from './layers/axes-layer';
export type { AxesLayerOptions, AxesColors } from './layers/axes-layer';
export { SurfaceLayer, heightField } from './layers/surface-layer';
export type {
  SurfaceLayerOptions,
  SurfaceBounds,
  HeightFieldOptions,
} from './layers/surface-layer';
export { Points3DLayer } from './layers/points3d-layer';
export type { Points3DLayerOptions } from './layers/points3d-layer';
export { ShapesLayer, ringsToOutline, ringsToFan, shapeVertexCount } from './layers/shapes-layer';
export type { ShapesLayerOptions, ShapeDraw, ShapeGeometry } from './layers/shapes-layer';
export { nearestPointIndex } from './picking/pick';

// Color
export {
  Colormap,
  resolveColormap,
  colormapFromLut,
  tintColormap,
  reverseColormap,
  NAMED_COLORMAPS,
  GRAY,
  RED,
  GREEN,
  BLUE,
  VIRIDIS,
  MAGMA,
} from './color/colormap';
export type { RGB, ColorStop } from './color/colormap';
export { buildLut, LUT_SIZE } from './color/lut';
export { buildLabelLut } from './color/label-colormap';
export { windowGamma, mapScalar, additiveComposite } from './color/display-pipeline';

// High-level views
export { MultiChannelImageView } from './views/multichannel-image-view';
export type {
  ChannelMode,
  ChannelView,
  ChannelUpdate,
  MultiChannelRenderOptions,
  ImageLayerHost,
} from './views/multichannel-image-view';
export { MultiChannelVolumeView } from './views/multichannel-volume-view';
export type {
  VolumeMode,
  VolumeChannel,
  VolumeChannelUpdate,
  MultiChannelVolumeRenderOptions,
  VolumeHost,
} from './views/multichannel-volume-view';

// Data sources
export {
  toTextureSource,
  defaultContrastLimits,
  isGrayscale,
  channelsOf,
  depthOf,
} from './io/texture-source';
export type {
  TextureSource,
  TypedImageSource,
  ExternalImageSource,
  TiledSource,
  TileKey,
  PixelChunk,
  ImageInput,
  PixelDtype,
} from './io/texture-source';

// Pyramid / tiling helpers
export {
  selectLevel,
  levelScale,
  levelDims,
  tileGrid,
  visibleTiles,
  worldViewport,
} from './io/pyramid';
export type { Rect, VisibleTile } from './io/pyramid';
export { LruCache } from './cache/lru';

export { VERSION } from './version';
