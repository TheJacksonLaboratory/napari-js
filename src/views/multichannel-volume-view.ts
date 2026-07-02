import { VolumeLayer, type VolumeLayerOptions, type VolumeRendering } from '../layers/volume-layer';
import type { BlendMode } from '../layers/layer';
import { Colormap, tintColormap } from '../color/colormap';

/** How a multichannel volume is composited. */
export type VolumeMode =
  /** One additive black→tint volume per channel (fluorescence). */
  | 'multichannel'
  /** A single scalar volume through a colormap. */
  | 'grayscale';

/** One channel's 3D scalar field (uint8, x-fastest) plus its display state. The host assembles the
 *  `data` (e.g. from server tiles); this view only owns how it becomes a layer. */
export interface VolumeChannel {
  data: Uint8Array;
  width: number;
  height: number;
  depth: number;
  /** `multichannel`: hex tint → a black→tint ramp colormap. */
  tint?: string;
  /** Explicit colormap (instance or registry name); wins over `tint` when both are set. */
  colormap?: Colormap | string;
  contrastLimits?: [number, number];
  gamma?: number;
  visible?: boolean;
  /** World size of one voxel per axis (napari's `scale`); keeps an anisotropic stack's true
   *  proportions. All channels of a volume share the same grid, so pass the same value. */
  voxelSize?: readonly [number, number, number];
}

/** Live display patch for a single volume channel (see {@link MultiChannelVolumeView.updateChannel}). */
export type VolumeChannelUpdate = Partial<
  Pick<VolumeChannel, 'tint' | 'colormap' | 'contrastLimits' | 'gamma' | 'visible'>
>;

export interface MultiChannelVolumeRenderOptions {
  rendering?: VolumeRendering;
}

/** The slice of {@link Viewer} this view drives — satisfied by `Viewer`, trivial to fake in tests. */
export interface VolumeHost {
  addVolume(
    data: Uint8Array,
    width: number,
    height: number,
    depth: number,
    opts?: VolumeLayerOptions,
  ): VolumeLayer;
  readonly layers: { clear(): void };
  requestRender(): void;
}

/**
 * High-level multichannel volume rendering on top of {@link Viewer}'s primitives — the 3D analog
 * of {@link MultiChannelImageView}. Turns a list of per-channel scalar fields + display state into
 * the right layer set: one additive, tinted {@link VolumeLayer} per channel (so each channel's
 * colour composites into the render), or a single colormapped volume for grayscale. Live per-channel
 * updates avoid re-uploading the data.
 *
 * It knows nothing about where the voxels come from (HTTP tiles, decoded slices): the host builds
 * each {@link VolumeChannel.data}; this view owns the rendering orchestration that's identical
 * regardless of the data backend.
 */
export class MultiChannelVolumeView {
  private _mode: VolumeMode | null = null;
  private readonly _layers: VolumeLayer[] = [];
  private _rendering: VolumeRendering = 'mip';

  constructor(private readonly host: VolumeHost) {}

  get mode(): VolumeMode | null {
    return this._mode;
  }
  get layers(): readonly VolumeLayer[] {
    return this._layers;
  }
  get rendering(): VolumeRendering {
    return this._rendering;
  }

  /** Clear any existing volumes and build the layer set for `mode` from `channels`. Multichannel
   *  layers blend additively; grayscale uses the first channel only. Returns the new layers. */
  render(
    mode: VolumeMode,
    channels: readonly VolumeChannel[],
    opts: MultiChannelVolumeRenderOptions = {},
  ): VolumeLayer[] {
    if (opts.rendering) this._rendering = opts.rendering;
    const rendering = this._rendering;
    this.host.layers.clear();
    this._layers.length = 0;
    this._mode = mode;

    const list = mode === 'grayscale' ? channels.slice(0, 1) : channels;
    list.forEach((ch) => {
      const layerOpts: VolumeLayerOptions = {
        colormap: ch.colormap ?? (ch.tint != null ? tintColormap(ch.tint) : 'gray'),
        contrastLimits: ch.contrastLimits ?? [0, 255],
        gamma: ch.gamma ?? 1,
        visible: ch.visible ?? true,
        rendering,
        ...(ch.voxelSize ? { voxelSize: ch.voxelSize } : {}),
        ...(mode === 'multichannel' ? { blending: 'additive' as BlendMode } : {}),
      };
      this._layers.push(this.host.addVolume(ch.data, ch.width, ch.height, ch.depth, layerOpts));
    });

    this.host.requestRender();
    return [...this._layers];
  }

  /** Live-apply a display change to one channel's volume layer (no re-upload). `colormap` wins over
   *  `tint`. No-op for an out-of-range index. */
  updateChannel(index: number, patch: VolumeChannelUpdate): void {
    const layer = this._layers[index];
    if (!layer) return;
    if (patch.colormap !== undefined) layer.colormap = patch.colormap;
    else if (patch.tint !== undefined) layer.colormap = tintColormap(patch.tint);
    if (patch.contrastLimits !== undefined) layer.contrastLimits = patch.contrastLimits;
    if (patch.gamma !== undefined) layer.gamma = patch.gamma;
    if (patch.visible !== undefined) layer.visible = patch.visible;
    this.host.requestRender();
  }

  /** Switch rendering mode (mip / iso / translucent) on every current layer. */
  setRendering(rendering: VolumeRendering): void {
    this._rendering = rendering;
    for (const layer of this._layers) layer.rendering = rendering;
    this.host.requestRender();
  }

  /** Remove all volume layers and reset the mode. */
  clear(): void {
    this.host.layers.clear();
    this._layers.length = 0;
    this._mode = null;
    this.host.requestRender();
  }
}
