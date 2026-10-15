# 07 — napari → napari-js concept mapping

A reference for porters: where each napari (Python) concept lives, and its napari-js
(TypeScript + WebGPU) counterpart. File references are to `~/git/napari/src/napari`.

## Model

| napari (Python)                                  | napari-js (TS)                                     | Notes                                                              |
| ------------------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------ |
| `ViewerModel` (`components/viewer_model.py:155`) | `Viewer` / `ViewerModel` (`scene/viewer-model.ts`) | Holds layers, camera, dims; emits events. Render-agnostic.         |
| `LayerList` (`components/layerlist.py`)          | `LayerList` (`scene/layer-list.ts`)                | Ordered, evented collection.                                       |
| `Dims` (`components/dims.py`)                    | `Dims` (`scene/dims.ts`)                           | Displayed dims, current step (z/time).                             |
| `Camera` (`components/camera.py`)                | `Camera` (`camera/camera.ts`)                      | center, zoom, (3D) angles, perspective — all numeric/serializable. |
| `EventedModel` + `psygnal`                       | tiny typed emitter (`scene/events.ts`)             | Not Qt signals in either system.                                   |
| pydantic v2 validation                           | TS types + setters                                 | Validation is lighter; types do most of it.                        |

## Layers

| napari layer (`layers/`)                | napari-js                               | Milestone |
| --------------------------------------- | --------------------------------------- | --------- |
| `Image` (`layers/image/image.py`)       | `ImageLayer` (`layers/image-layer.ts`)  | NJ-1/2    |
| multichannel (one `Image` per channel)  | one `ImageLayer` per channel, additive  | NJ-2      |
| `Labels` (`layers/labels/labels.py`)    | `LabelsLayer`                           | NJ-5      |
| `Points` (`layers/points/points.py`)    | `PointsLayer`                           | NJ-5      |
| `Image` 3D / volume                     | `VolumeLayer`                           | NJ-5+     |
| `depiction='plane'`, `plane`            | `VolumeLayer.depiction` / `plane`       | NJ-6      |
| `experimental_clipping_planes`          | `clippingPlanes` (volume, surface)      | NJ-6      |
| `Surface` (`layers/surface/surface.py`) | `SurfaceLayer` (+ `heightField` helper) | NJ-6      |
| `marching_cubes` (skimage) → surface    | `surfaceNets` (`napari-js/geometry`)    | NJ-6      |
| `Shapes` (rings)                        | `ShapesLayer`                           | NJ-6      |
| `Vectors`, `Tracks`                     | (not yet)                               | later     |

Shared layer properties (napari `layers/base/base.py`) → napari-js `layers/layer.ts`:
`opacity`, `blending`, `visible`, `name`, and a 2D data→world `scale` / `translate` (no rotate
or shear yet; 3D layers place themselves by `voxelSize` or their vertex coordinates).

## Rendering boundary

| napari                                               | napari-js                                 | Notes                                        |
| ---------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| `layer_to_visual` dict (`_vispy/utils/visual.py:62`) | visual registry (`visuals/visual.ts`)     | Map layer/IR kind → visual.                  |
| `Vispy*Layer` wrappers (`_vispy/layers/*.py`)        | `*Visual` classes (`visuals/*.ts`)        | Subscribe to model, push to GPU.             |
| implicit per-frame data pushed to VisPy node         | explicit `RenderState` IR (doc 03)        | We name the contract napari leaves implicit. |
| VisPy `SceneCanvas` + OpenGL                         | `engine/` device/canvas/renderer + WebGPU | Full reimplementation.                       |
| `MatrixTransform` (VisPy)                            | `transform.ts` → mat4                     | Plain matrices both sides.                   |

## Color / display

| napari                                                       | napari-js                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------- |
| `Colormap` (`utils/colormaps/`) → GL colormap                | `Colormap` (`color/colormap.ts`) → LUT texture (`color/lut.ts`) |
| `contrast_limits`, `gamma` on Image                          | `contrastLimits`, `gamma` on `ImageLayer`                       |
| blending modes (`opaque`/`translucent`/`additive`/`minimum`) | same `BlendMode` → `GPUBlendState`                              |

## Shaders (GLSL → WGSL)

| napari GLSL                                                               | napari-js WGSL                 | Difficulty                   |
| ------------------------------------------------------------------------- | ------------------------------ | ---------------------------- |
| image window/gamma/LUT (VisPy base + napari)                              | `shaders/image-colormap.wgsl`  | low — foundation             |
| label lookups (`_vispy/layers/labels.py`, ~53 lines)                      | label LUT shader               | low — direct port            |
| volume gradients/iso/categorical (`_vispy/visuals/volume.py`, ~278 lines) | volume WGSL                    | medium (after base raymarch) |
| VisPy base volume raymarch loop (not napari's code)                       | new raymarch (frag or compute) | **high — the long pole**     |
| marker SDFs (VisPy markers)                                               | points SDF shader              | medium                       |

## Data ingestion

| napari                                                                    | napari-js                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| in-memory numpy / dask / `LayerDataProtocol`; lazy `_LayerSlicer` (NAP-4) | pluggable `TextureSource` (bitmaps / typed arrays / tiled); async tile fetch + LRU cache |
| multiscale `MultiScaleData`                                               | `TiledSource` pyramid levels (NJ-3)                                                      |

## What we deliberately do not port

- Qt GUI (`_qt/`) — napari-js is headless + canvas; UI lives in consumers.
- Python plugin system (npe2), app-model, settings — out of scope.
- The Python event loop / Qt threading — replaced by rAF + async I/O / workers.
