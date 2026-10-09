# Changelog

All notable changes to napari-js are documented here. The format roughly follows
[Keep a Changelog](https://keepachangelog.com/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **`LayerList.move(layer, index)` and `LayerList.insert(index, layer)`** (napari's
  `LayerList.move`/`insert`). Restacking by remove + re-add disposes the layer's GPU visual and
  re-uploads its whole buffer on the next frame; `move` only reorders `items`, emitting `moved`
  and `changed` but never `removed`/`added`, so the renderer keeps the visual it already has.

- **Packed per-point colours.** `PointsLayer` `faceColor`/`borderColor` accept a `Float32Array` of
  RGBA (length 4N), copied straight into the instance buffer instead of via N tuples.
  `Points3DLayer` gains `colors` (option + setter, same packing): when set it wins over
  `values` + `colormap`, its alpha multiplies `alphas`, and it moves only the style clock.
  `Points3DLayer.colorAt(i)` is the CPU reference for that combination. Wrong lengths throw.

- **`invert` on `VolumeLayer`, `SurfaceLayer` and `Points3DLayer`** (option + live setter), and on
  `VolumeChannel`/`VolumeChannelUpdate`, with `ImageLayer`'s order: window → invert → gamma →
  colormap. Replaces reversing the colormap, which differs once gamma ≠ 1. On a volume only the
  colour inverts; the MIP maximum, translucent alpha and iso threshold use the un-inverted value.

- **`Camera3D.worldPerPixel(viewportHeight)`**: world units per CSS pixel at the target's depth,
  `2 · distance · tan(fov / 2) / viewportHeight` — the 3D analog of `1 / zoom`, for a scale bar.
  `pan` now uses it instead of inlining the formula; its behaviour is unchanged.

- **`napari-js/testing`**, a GPU-free test double: the whole public API with `Viewer` bound to
  `HeadlessViewer` — the real model, layers, `add*`, framing and canvas maths, no device, readback
  a blank frame. Replaces hand-written stubs that drift from the library. `Viewer`'s GPU-free half
  moved into a shared `ViewerBase`, so the two cannot diverge; the main bundle is still one file.

- **Per-point marker symbols.** `PointSymbol` grows to napari's set (`diamond`, `star`, `cross`,
  `x`, `triangle_up`/`_down`, `arrow`, `tailed_arrow`, `hbar`, `vbar`, `clobber`) plus `hexagon` and
  `pentagon`; napari aliases (`'o'`, `'+'`, `'^'`, …) resolve. `PointsLayer.symbols` takes one code
  per point (`Uint8Array`, `pointSymbolCode(name)`; 255 = the layer `symbol`), drawn as SDFs with
  the existing border. `pointSymbolDistance` is the CPU reference. `borderWidth` is now a uniform.

- **Per-shape colours on `ShapesLayer`**: `faceColor` (option + setter), napari Shapes'
  `face_color` — one RGBA or a packed `Float32Array(4 · shapeCount)`. When set it wins over
  `values` + `colormap`; null restores them. Uploaded per shape (a storage buffer), so a recolour
  re-expands nothing. `colorAt(i)` / `colorMode()` are the CPU reference.

- **Alpha in colormaps, and `ImageLayer.transparentBelow`.** `ColorStop.color` may be RGBA
  (alpha interpolated, `Colormap.sampleRGBA`, carried in the LUT); a scalar image multiplies it
  into its alpha. `transparentBelow` (option + setter, a uniform) draws values ≤ the low contrast
  limit fully transparent, so a density map recolours on a `contrastLimits` change without a
  re-upload. `mapScalarRGBA` is the CPU reference. Other colormapped layers still use RGB only.

- **Picking.** `GridIndex`, a bucket grid over any 2D coordinate set (`ScreenIndex` now builds on
  it). `PointsLayer.pick(worldX, worldY, { tolerance, radiusAt, pickable, tieBreak })` — napari's
  `get_value`: `'topmost'` (default, last drawn) or `'nearest'`, over a lazily built index rebuilt
  on `dataVersion`. `PointPicker(viewer, points3d, { maxReach })` owns the 3D policy: lazy
  re-projection on camera / data / resize into reused buffers, the screen index, layer-style
  radii and muting. `Viewer.viewportSize()` gives the canvas size in CSS px.

- **`Viewer.canvasTransform()` and `worldToCanvasLocal(x, y)`** (on `ViewerBase`, so also
  `HeadlessViewer`): the 2D camera's world → canvas-local CSS-px affine `[a, b, c, d, e, f]` and
  its point form, with no `getBoundingClientRect()` read. An SVG overlay sets one
  `matrix(...)` per camera change instead of a layout read per vertex.

- **`visibleTiles(..., scales, { order, limit })`**: `order: 'center-out'` lists the tiles nearest
  the view's centre first (ties row-major) so a streaming consumer fills the middle of the screen
  first; `limit` keeps the first N after ordering. Without options the list is unchanged.

- **Whole-level reads from a `TiledSource`**: `readLevel(source, z, opts)` picks the finest level
  within `maxTiles`/`maxTextureDim` (`chooseStitchLevel`, on `selectLevel`/`tileGrid`), stitches it
  with bounded concurrency and box-downscales to `maxSide`; `assembleVolume` stacks z-slices into a
  uint8 volume with progress; `bitmapToScalar`/`rgbaToScalar` decode images. All cancel via
  `AbortSignal`, which is also passed to `fetchTile(key, signal?)`.

### Changed

- **`addVolume` frames like the other 3D adders**: on `layer.bounds()` through `framingFor` (field
  of view and canvas aspect), not `Camera3D.frame`'s `max(w, h, d) × 1.8`. Same target (the
  origin); the distance now fits the box's half-diagonal, so the camera sits further back
  (about 26% for a cube on a landscape canvas) and a portrait canvas no longer clips.

- **`napari-js/overlays`**: `ScaleBarOverlay` (2D zoom or the 3D camera's `worldPerPixel`),
  `AxesLabelsOverlay` (projected 3D axis text) and `NavigatorOverlay` (minimap on
  `visibleWorldRect`), each `(host, viewer, opts)` with `dispose()`. The pure `scaleBarFor` snaps
  to the nearest 1/2/5 × 10ⁿ and `formatLength` picks the unit. A second entry, like `testing`.

- **`napari-js/colormaps`**: all 83 matplotlib colormaps as exact 256-entry tables, one
  tree-shakeable `Uint8Array(768)` export each (base64 in source), plus `COLORMAP_LUTS`,
  `matplotlibColormap(name)` and `lutColormap(name, lut)` (also in the main entry). Licences are
  noted in `src/colormaps/luts.ts`.

- **`INFERNO`** colormap (`'inferno'` by name).

- **`napari-js/geometry`**: `rasterizePolygon` (scanline, pixel-centre rule, holes),
  `pointInRing`/`pointInPolygonWithHoles`/`ringArea`, `labelComponents` (4/8-connected, by value),
  `traceContours` (outer rings + holes along pixel edges, unclamped `origin`; exact round trip with
  `rasterizePolygon`) and `floodFill`. Ported and generalised from SIV's wand service.

- **`autoContrastLimits(histogram, saturation)`**: saturation-based auto contrast that clips a
  fraction at each end and ignores a dominant padding bin. In the main entry and `geometry`.

- **`parseColor(css): RGBA | null`** (napari's `transform_color` for one colour): `#rgb`, `#rgba`,
  `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` (comma, space or slash syntax, percentages) and the basic
  named colours, including matplotlib's `r g b c m y k w`. Null when unparseable, so each caller
  picks its fallback.

### Changed

- **`VIRIDIS` and `MAGMA` are matplotlib's exact 256-entry tables**, not 6-anchor approximations.
  Costs the main bundle about 3 kB gzip (with `INFERNO`).

- **`tintColormap` parses with `parseColor`**, so it also takes `rgb()` and named colours. Bare hex
  without `#` still works; a partly invalid hex now gives black as a whole rather than per channel,
  and the name is always lower-case `tint-rrggbb`.

## [0.13.0]

### Added

- **`zoomSmoothingMs`** on `ViewerOptions` and `CameraControlOptions`. The 2D wheel now sets a
  TARGET zoom and eases toward it over frames instead of jumping there on the event itself, which
  is the whole of what made the wheel feel steppy next to OpenSeadragon on the same images — OSD
  animates every notch through a spring. Set `0` for the previous instant behaviour.

  Eased in LOG space, because zoom is multiplicative: 1x to 4x is the same perceptual distance as
  4x to 16x, so easing the raw factor makes zoom-in crawl and zoom-out snap. OSD reaches the same
  conclusion from the other direction — its zoom spring is the only one it constructs with
  `exponential: true`. The default time constant of 90ms settles in about 415ms (an exponential
  covers 99% in ln(100) time constants).

  The cursor anchor is re-read on every event and held on every FRAME rather than only at the end,
  so the point under the cursor stays under it for the whole animation and a burst of events while
  the cursor moves follows the cursor. Events compound onto the target in flight instead of
  restarting from wherever the animation has reached, so a fast scroll travels as far as a slow one
  — which matters most on a trackpad, where one swipe is a burst.

- **`wheelZoomSpeed` on the 3D orbit controls** (`OrbitControlOptions`). `ViewerOptions` documented
  this but it never reached 3D: the viewer called `attachOrbitControls` with no options at all.

- **`DEFAULT_WHEEL_ZOOM_SPEED`, `WHEEL_DELTA_CLAMP` and `DEFAULT_ZOOM_SMOOTHING_MS`** are exported,
  so a host that wants to match the wheel to another renderer can derive its setting from the real
  values rather than copying the numbers.

### Changed

- **Gentler wheel zoom.** One notch moved 3.67%, which compounds quickly on a trackpad; it is now
  about 2.9%, roughly 24 notches to double rather than 19.

- Wheel-delta normalization moved into `camera/wheel.ts`, shared by the 2D and 3D paths. It is not
  specific to either: browsers report deltas in three units and the same physical gesture differs
  by more than an order of magnitude between them — Chrome sends one ~100px event per notch,
  Firefox reports line mode with a `deltaY` around 3, and a trackpad's momentum ticks reach several
  hundred px.

### Fixed

- **The 3D wheel dolly was never normalized**, having been written against the raw `deltaY`. One
  Chrome mouse notch dollied **16.18%** — about 4.4x the 2D wheel — a single trackpad momentum tick
  dollied **1.82x**, and Firefox's line mode moved **0.45%**, so one gesture differed by 36x between
  two browsers. It now shares the 2D path's normalization and clamp.

- **The animated zoom yields the camera** when anything else moves it mid-flight. The first cut
  watched the zoom only, so a host pan — or a `fit()` landing on the current zoom — was not
  recognised, and the animation kept re-centring each frame to hold its stale anchor: setting
  `camera.center = [123, -456]` mid-animation left the centre at 129.91.

## [0.12.0]

### Added

- **`ShapesLayer` — closed polygon rings in 2D** (`viewer.addShapes(coords, offsets, opts)`), the
  napari `Shapes` analog restricted to rings. Geometry arrives **flat**: `coords` is
  `[x0,y0,x1,y1,…]` and `offsets` holds `shapeCount + 1` vertex offsets, so shape `i` is
  `coords[2*offsets[i] .. 2*offsets[i+1])` and closes implicitly. That is the shape segmentation
  comes in, and the only shape that survives 10⁵–10⁶ cells — one object and one array per polygon
  would dominate memory long before the GPU noticed.

  Draws boundaries (`draw: 'outline'`, a `line-list`) or interiors (`'fill'`, a centroid fan), and
  colours by **one scalar per shape** through a colormap, so a cluster id or a measurement maps to
  colour without the caller expanding anything per vertex. `values` and `positions` live in
  separate vertex buffers: recolouring rewrites the smaller one and leaves 10⁶ positions untouched.

  The expansion is **pure, GPU-free** — `ringsToOutline`, `ringsToFan` and `polygonKernelPoint`,
  plus `shapeVertexCount` to size a buffer before paying for it — following `heightField`'s
  precedent and unit-tested the same way. The fan is exact for every **star-convex** ring, which
  cell and nucleus boundaries are: its apex comes from the ring's KERNEL (the intersection of its
  edges' interior half-planes) rather than from the vertex mean, which is only guaranteed to lie
  inside a CONVEX ring. A ring with an empty kernel is not star-convex at all and needs a general
  triangulation, which this is not; it falls back to the mean and may self-overlap. WebGPU has no
  line width, so an outline is one device pixel at any zoom.

  Measured before it was written: 2.4 M edges draw in ~3.5 ms and 24 M in ~7 ms, and filled cells
  are cheaper than outlines. Playground demo **8** exercises both modes over an image.

### Changed

- **`acquireDevice` now requests the adapter's buffer limits.** `requestDevice` otherwise grants the
  spec defaults — 256 MiB per buffer, 128 MiB per storage binding — whatever the hardware offers,
  and a layer that needs more fails **asynchronously**: the allocation is dropped, the buffer reads
  as zeros, and nothing throws, so it presents as a coordinate bug rather than a limits one. The
  request asks for the adapter's own values (which can never exceed them) and falls back to the
  defaults if an implementation refuses, since device acquisition must not regress.
- **`ShapesVisual` refuses an over-limit expansion loudly**, naming the size, the shape count and
  `maxBufferSize`, instead of allocating past the limit and drawing nothing.

## [0.11.1]

### Changed

- **The project now lives at
  [TheJacksonLaboratory/napari-js](https://github.com/TheJacksonLaboratory/napari-js).** Repository,
  homepage, bug-tracker, and security-advisory links point at the new org. The package name on npm
  (`napari-js`) is unchanged, as are the MIT terms — The Jackson Laboratory is added alongside the
  original creator in `LICENSE`.
- **`package-lock.json` version field corrected.** It had drifted at `0.1.1` since that release while
  `package.json` moved on; both now track the real version.

### Added

- **README: integration guide for the primary consumer**, `sci-image-visualizer` — dependency and
  adapter wiring, plot-type dispatch, and rendered screenshots (volume, multi-channel, iso-surface,
  axes gizmo) under `docs/images/`.
- **README acknowledgments** crediting upstream [napari](https://napari.org) (BSD-3-Clause), whose
  layer model, naming, and rendering semantics napari-js follows.

## [0.11.0]

### Changed

- **`VolumeLayer.voxelSize` is now live-mutable.** Setting it bumps a `geometryVersion` and rebuilds
  only the model matrix (the volume texture is untouched), so a host can restretch an axis smoothly
  — e.g. an interactive Z-height gizmo — without re-uploading the volume.
- **`AxesLayer` dimensions (`width`/`height`/`depth`) are now live-mutable** (settable, bumping
  `geometryVersion`), so the gizmo box can follow a volume restretch in real time.

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
