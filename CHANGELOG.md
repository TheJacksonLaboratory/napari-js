# Changelog

All notable changes to napari-js are documented here. The format roughly follows
[Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [0.10.0]

### Added

- **Per-axis voxel scale on volumes (`VolumeLayer.voxelSize`).** New `voxelSize?: [sx, sy, sz]`
  option (napari's `scale`, default `[1, 1, 1]`). The rendered box is `[width*sx, height*sy,
  depth*sz]` and the camera frames that world box, so an anisotropic stack — e.g. XY downsampled
  but Z kept — holds its true proportions instead of the raw voxel-count aspect. Threaded through
  `VolumeChannel.voxelSize` in `MultiChannelVolumeView`. The raymarch samples in normalized texture
  space, so the box scale is independent of the sampling resolution: changing the decimate factor
  changes detail, not the volume's shape.

## [0.9.3]

### Added

- **3D scatter (`Points3DLayer`)** — `Viewer.addPoints3D(positions, values?, opts?)` renders a 3D
  point cloud: `positions` (N×3, world coords) with optional per-point `values` colored through a
  colormap (windowed by `contrastLimits` + `gamma`). Drawn as instanced, screen-facing billboards
  (disc SDF, `size` in px), depth-tested against the 3D pass so points occlude under the orbit
  camera; frames the camera on the point bounds. Complements the 2D `PointsLayer`. Playground demo 7.

## [0.9.2]

### Added

- **Surface wireframe.** `SurfaceLayer.wireframe` (and the `wireframe` option) renders the mesh as
  its triangle edges (a `line-list`, colored by the value LUT, fullbright) instead of a filled,
  shaded surface — toggle it live with no geometry rebuild. `buildEdgeIndices()` derives the edge
  index buffer from the faces. Playground demo 6 toggles it with `w`.

## [0.9.1]

### Added

- **`heightField` — `center` option + windowed heights.** `heightField(..., { center: true })` centers
  the mesh on the origin (all axes) so it can be wrapped in an origin-centered `AxesLayer` gizmo and
  framed like a volume. Heights are now clamped into `[0, zScale]` for intensities outside `zLimits`,
  so an explicit contrast window maps 1:1 to relief (a consumer can re-run `heightField` with the
  live `[min, max]` to make the surface's Z follow the contrast window).

## [0.9.0]

### Added

- **Surface layer** — a 3D triangular mesh (the napari `Surface` layer analog), the last of
  napari's core layer types to be ported. `Viewer.addSurface(vertices, faces, values?, opts?)`
  takes `vertices` (N×3, world/data coords, x-fastest), `faces` (M×3 triangle indices), and
  optional per-vertex `values` colored through a colormap (windowed by `contrastLimits` + `gamma`;
  defaults to coloring by z). It switches the viewer to 3D and frames the orbit camera on the mesh
  bounds. Rendered as an indexed triangle mesh with **depth testing** and two-sided, screen-space
  flat shading (normals derived per-fragment via `dpdx`/`dpdy` — no per-vertex normals needed).
- **`heightField(data, cols, rows, opts?)`** — a pure, GPU-free helper that turns a 2D scalar grid
  into a height-field surface mesh (z = normalized intensity), the classic "surface plot". Supports
  `zScale`, `zLimits`, and `stride` decimation for large images. Returns generic
  `{ vertices, faces, values }` for `addSurface`, so a host can render a surface in two calls.

### Changed

- **Depth buffer for 3D passes** — the renderer now attaches a `depth24plus` depth texture when
  drawing `ndisplay === 3` layers, so surface meshes self-occlude correctly. Volume and axes
  visuals keep their previous look (they never depth-test or write). 2D passes are unchanged (no
  depth attachment).

## [0.5.1]

### Added

- **Click-to-zoom** — a plain left click zooms in about the cursor; a right click or modifier-click
  (shift/ctrl/alt/meta) zooms out; a left drag still pans (and never triggers click-zoom). Tunable
  via `ViewerOptions.clickZoomFactor` (default 2×; 0 disables). Mirrors OpenSeadragon's click-zoom.

### Changed

- **Gentler, tunable wheel zoom** — lower default sensitivity + a tighter per-event delta clamp so
  high-resolution mice / trackpad momentum zoom smoothly. Override via `ViewerOptions.wheelZoomSpeed`.

## [0.5.0]

### Added

- **Arbitrary (non-power-of-two) tiled pyramids** — `TiledSource.levelScales?: number[]` supplies an
  explicit per-level downsample factor (level-0 units per level pixel, ascending). The pyramid
  helpers (`levelScale`/`levelDims`/`tileGrid`/`visibleTiles`/`selectLevel`) and `TiledImageVisual`
  honour it, so a server pyramid with arbitrary level ratios (e.g. Bio-Formats / `/tiles/info`)
  renders with correct level selection and tile placement, refining to higher resolution on zoom.
  Omit it for the classic power-of-two behaviour (unchanged).

## [0.4.2]

### Changed

- **Gentler wheel zoom** — the 2D wheel-zoom handler now normalizes the wheel delta across devices
  (line/page `deltaMode`) and clamps it per event, so high-resolution mice and trackpad momentum
  zoom smoothly instead of in large, over-sensitive jumps. Sensitivity is a single tunable constant.

## [0.4.1]

### Fixed

- **Readback format mismatch** — `readDisplayedPixels()` (and `screenshot()`/`histogram()`, which
  build on it) rendered into a hardcoded `rgba8unorm` texture while the layer pipelines are built
  for the canvas/swapchain format. On platforms whose preferred canvas format is `bgra8unorm`
  (e.g. Metal) this produced a WebGPU validation error ("attachment state … is not compatible")
  on every readback. The readback texture now uses the target format and `readTextureToRGBA`
  swizzles BGRA→RGBA, so callers still get RGBA bytes.

## [0.4.0]

### Added

- **Runtime control toggle** — `Viewer.setControlsEnabled(enabled)` and the `controlsActive`
  getter attach/detach the pointer pan/zoom (2D) and orbit (3D) controls on demand. A host can
  disable navigation so it owns the pointer for region drawing (rectangle/polygon/lasso), then
  re-enable it to restore navigation. The `controls` constructor option is now toggleable at
  runtime rather than fixed at construction.

## [0.3.0]

### Added

- **3D camera drag modes** — `Camera3D.dragMode` (`'rotate'` | `'pan'` | `'zoom'`) plus
  `Camera3D.pan(dx, dy, viewportHeight)`; the orbit controls branch a pointer drag accordingly
  (the wheel still always dollies). `Viewer.setCameraDragMode(mode)` lets a host switch it
  (e.g. orbit / pan / zoom toolbar buttons). Enables interactive volume navigation beyond
  orbit-only.

## [0.2.1]

### Changed

- Documentation: README adds a Features list and a library Install/Use example, and references
  the originating issue [jit-ui#102](https://github.com/TheJacksonLaboratory/jit-ui/issues/102);
  `docs/06` links the tracking issue and marks Phase C underway. (No code changes.)

## [0.2.0]

### Added

- **Device-loss recovery** — on `GPUDevice.lost` (GPU reset/driver crash), the viewer
  re-acquires a device and rebuilds the canvas target, renderer, and all layer textures.
- **uint16 / uint32 labels** — `LabelsLayer` / `Viewer.addLabels` accept
  `Uint8Array | Uint16Array | Uint32Array`; ids are stored in an `r32uint` texture and
  integer-fetched (`textureLoad`), so label ids > 255 render correctly.
- **`ImageBitmap` tile chunks** — `TiledSource.fetchTile` may return a decoded `ImageBitmap`
  (e.g. a PNG tile from a server), uploaded via `copyExternalImageToTexture`.
- **Per-channel native histogram** — `Viewer.layerHistogram(layer, bins)` computes a
  histogram from a single-channel image layer's in-memory source at native bit depth, plus a
  pure `histogramScalar()` helper.

## [0.1.1]

### Added

- Host-embedding APIs: `Viewer.worldToCanvas()`, `Viewer.visibleWorldRect()`, and optional
  `ResizeObserver` auto-resize (`autoResize` option).
- Multi-demo playground with a dropdown selector (image, multi-channel, tiled + z-stack,
  points + labels, volume) for browser verification.
- Coverage tooling (`npm run test:coverage`) and expanded unit tests.
- `docs/08` — landscape & related work (how napari-js differs from Viv/vizarr and the
  Python-in-browser napari direction).

## [0.1.0]

- Initial release. Phase B milestones NJ-0…NJ-5+: WebGPU image rendering
  (single / multi-channel / 16-bit / float32), tiled + pyramidal large images with z-stacks,
  points (SDF markers), labels, and 3D volume raymarching (MIP / translucent / iso), plus
  pixel readback, screenshot, and histogram. Tag-triggered CI/CD publishes to npm with
  provenance.
