/**
 * Pixel ingestion for NJ-1: a single full-resolution image (no tiling — that arrives in
 * NJ-3 as a pyramidal `TiledSource`). A source is either raw typed-array pixels or an
 * external decoded image (ImageBitmap/canvas) uploaded via `copyExternalImageToTexture`.
 */

export type PixelDtype = 'uint8' | 'uint16' | 'float32';

/**
 * Raw scalar/RGBA pixels in a typed array. `uint8` → `r8unorm`/`rgba8unorm`;
 * `uint16`/`float32` scalar → `r32float` (native-precision windowing). RGBA is `uint8` only.
 */
export interface TypedImageSource {
  readonly kind: 'typed';
  readonly width: number;
  readonly height: number;
  readonly channels: 1 | 4;
  readonly dtype: PixelDtype;
  readonly data: Uint8Array | Uint16Array | Float32Array;
}

/** A decoded image to upload directly to an RGBA8 texture. */
export interface ExternalImageSource {
  readonly kind: 'external';
  readonly width: number;
  readonly height: number;
  readonly image: ImageBitmap | HTMLCanvasElement | OffscreenCanvas | HTMLImageElement;
}

/** Identifies one tile within a pyramidal/tiled source. */
export interface TileKey {
  /** Pyramid level (0 = full resolution; each level halves resolution). */
  level: number;
  col: number;
  row: number;
  /** Z-slice (0 when not a stack). */
  z: number;
}

/**
 * Pixels for one tile. Edge tiles may be smaller than the nominal `tileSize`. `data` is
 * either a typed array (matching the source's dtype/channels) or a decoded `ImageBitmap`
 * (for RGBA8 sources — e.g. PNG tiles from a server uploaded directly).
 */
export interface PixelChunk {
  width: number;
  height: number;
  data: Uint8Array | Uint16Array | Float32Array | ImageBitmap;
}

/**
 * A pyramidal, tiled, optionally z-stacked image — the general large-image case (whole-slide
 * microscopy etc.). `width`/`height` are full-resolution (level 0). Tiles are fetched lazily
 * via {@link fetchTile} and cached on the GPU. The host supplies `fetchTile` (e.g. a server
 * `/tile` request); napari-js stays ignorant of any backend.
 */
export interface TiledSource {
  readonly kind: 'tiled';
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly levels: number;
  /**
   * Per-level downsample factors (level-0 units per level pixel), ascending — level 0 is finest
   * (factor 1). Supply this for arbitrary, non-power-of-two pyramids (e.g. Bio-Formats / a server's
   * `/tiles/info` levels); omit it for a classic power-of-two pyramid (`2^level`).
   */
  readonly levelScales?: number[];
  readonly depth: number;
  readonly channels: 1 | 4;
  readonly dtype: PixelDtype;
  /**
   * Fetch one tile. `signal` is passed by callers that can be cancelled (e.g. {@link readLevel}
   * with an `AbortSignal`), so an implementation can forward it to `fetch`; ignoring it is fine.
   */
  fetchTile(key: TileKey, signal?: AbortSignal): Promise<PixelChunk>;
}

export type TextureSource = TypedImageSource | ExternalImageSource | TiledSource;

/** Anything `Viewer.addImage` accepts. */
export type ImageInput =
  | TypedImageSource
  | TiledSource
  | ImageBitmap
  | HTMLCanvasElement
  | HTMLImageElement;

export function channelsOf(source: TextureSource): 1 | 4 {
  return source.kind === 'typed' || source.kind === 'tiled' ? source.channels : 4;
}

/** Number of z-slices in a source (1 unless it's a z-stacked tiled source). */
export function depthOf(source: TextureSource): number {
  return source.kind === 'tiled' ? source.depth : 1;
}

export function isGrayscale(source: TextureSource): boolean {
  return channelsOf(source) === 1;
}

/** Default contrast-limit window for a source, in source-data units. */
export function defaultContrastLimits(source: TextureSource): [number, number] {
  if (source.kind === 'typed' || source.kind === 'tiled') {
    if (source.dtype === 'float32') return [0, 1];
    if (source.dtype === 'uint16') return [0, 65535];
  }
  return [0, 255];
}

/** Normalize a user input into a {@link TextureSource}. */
export function toTextureSource(input: ImageInput): TextureSource {
  if (
    typeof input === 'object' &&
    'kind' in input &&
    (input.kind === 'typed' || input.kind === 'tiled')
  ) {
    return input;
  }
  const image = input as ImageBitmap | HTMLCanvasElement | HTMLImageElement;
  const width = 'width' in image ? Number(image.width) : 0;
  const height = 'height' in image ? Number(image.height) : 0;
  return { kind: 'external', width, height, image };
}
