import type { ImageLayer, Interpolation } from '../layers/image-layer';
import type { BlendMode } from '../layers/layer';
import type { LayerVisual, RenderView } from './layer-visual';
import type { TiledSource } from '../io/texture-source';
import { multiply, scaleTranslate2d } from '../math/mat4';
import { planTiles, selectLevel, worldViewport, type TileDraw, type TileRef } from '../io/pyramid';
import { LruCache } from '../cache/lru';
import { buildLut, LUT_SIZE } from '../color/lut';
import { GRAY } from '../color/colormap';
import { formatPlanFor, toUploadData, type FormatPlan } from './format-plan';
import { IMAGE_COLORMAP_SHADER } from './image-colormap-shader';
import { IMAGE_UNIFORM_FLOATS, packImageDisplayUniforms, packUvRect } from './image-visual';
import { blendStateFor } from './blend';

const UNIFORM_FLOATS = IMAGE_UNIFORM_FLOATS;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
const DEFAULT_TILE_CAPACITY = 192;

/** A uniform buffer and the bind group that draws the tile with it. */
interface DrawSlot {
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

interface TileEntry {
  texture: GPUTexture;
  /**
   * One per draw of the tile in a frame. A tile is usually drawn once, but a coarser tile
   * standing in for several finer ones still loading is drawn once per finer tile, each time a
   * different part of it — and `writeBuffer` lands before the pass runs, so draws sharing one
   * buffer would all see the last values written.
   */
  slots: DrawSlot[];
  /** The frame the tile was last drawn in, and how many slots that frame has used. */
  frame: number;
  used: number;
}

/**
 * Renders a pyramidal {@link TiledSource}: selects a pyramid level from zoom and draws the
 * visible tiles (fetched lazily and cached on the GPU with LRU eviction). A tile still loading
 * is filled from the tiles already loaded at other levels (see {@link planTiles}), so a zoom or
 * pan keeps the best resolution at hand, for every channel layer, additive ones included.
 * Fetches the view no longer needs are aborted. Z-scrubbing fetches the new slice's tiles
 * (cache keyed by z, so revisited slices are instant). Mirrors napari's tiled-image path.
 */
export class TiledImageVisual implements LayerVisual {
  readonly ndisplay = 2 as 2 | 3;
  private readonly source: TiledSource;
  private readonly plan: FormatPlan;
  private readonly module: GPUShaderModule;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly lutTexture: GPUTexture;
  private readonly lutSampler: GPUSampler;
  private readonly scratch = new Float32Array(UNIFORM_FLOATS);
  private readonly cache: LruCache<TileEntry>;
  /** Tiles being fetched, each with the controller that aborts it once the view moves on. */
  private readonly pending = new Map<string, AbortController>();
  /** Counts draws, so a tile's slots are reused from one frame to the next. */
  private frame = 0;

  private srcSampler: GPUSampler;
  private pipeline: GPURenderPipeline;
  private currentBlend: BlendMode;
  private currentInterp: Interpolation;
  private lutVersion: number;
  private disposed = false;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly layer: ImageLayer,
    private readonly opts: { float32Filterable: boolean; onNeedsRedraw: () => void },
  ) {
    if (layer.source.kind !== 'tiled') {
      throw new Error('TiledImageVisual requires a tiled source.');
    }
    this.source = layer.source;
    this.plan = formatPlanFor(this.source.channels, this.source.dtype, opts.float32Filterable);

    this.module = device.createShaderModule({ code: IMAGE_COLORMAP_SHADER });
    this.bindGroupLayout = this.buildBindGroupLayout();
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

    this.lutSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.lutTexture = device.createTexture({
      size: [LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.writeLut();
    this.lutVersion = layer.colormapVersion;

    this.currentInterp = layer.interpolation;
    this.srcSampler = this.createSrcSampler(layer.interpolation);
    this.currentBlend = layer.blending;
    this.pipeline = this.buildPipeline(layer.blending);

    this.cache = new LruCache<TileEntry>(DEFAULT_TILE_CAPACITY, (entry) => {
      entry.texture.destroy();
      for (const slot of entry.slots) slot.uniformBuffer.destroy();
    });
  }

  private buildBindGroupLayout(): GPUBindGroupLayout {
    const f = this.plan.filterable;
    return this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          sampler: { type: f ? 'filtering' : 'non-filtering' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: f ? 'float' : 'unfilterable-float' },
        },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
  }

  private buildPipeline(blend: BlendMode): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: this.pipelineLayout,
      vertex: { module: this.module, entryPoint: 'vs' },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: blendStateFor(blend) }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  private createSrcSampler(interp: Interpolation): GPUSampler {
    const filter: GPUFilterMode =
      !this.plan.filterable || interp === 'nearest' ? 'nearest' : 'linear';
    return this.device.createSampler({
      magFilter: filter,
      minFilter: filter,
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  private writeLut(): void {
    const cmap = this.layer.colormap ?? GRAY;
    this.device.queue.writeTexture(
      { texture: this.lutTexture },
      buildLut(cmap, LUT_SIZE),
      { bytesPerRow: LUT_SIZE * 4, rowsPerImage: 1 },
      { width: LUT_SIZE, height: 1 },
    );
  }

  private keyOf(level: number, col: number, row: number, z: number): string {
    return `${z}:${level}:${col}:${row}`;
  }

  /** Fetch a tile unless it is cached or already on its way. */
  private request(ref: TileRef, z: number): void {
    const key = this.keyOf(ref.level, ref.col, ref.row, z);
    if (this.cache.has(key) || this.pending.has(key)) return;

    const controller = new AbortController();
    this.pending.set(key, controller);
    this.source
      .fetchTile({ level: ref.level, col: ref.col, row: ref.row, z }, controller.signal)
      .then((chunk) => {
        const isBitmap = typeof ImageBitmap !== 'undefined' && chunk.data instanceof ImageBitmap;
        // Aborted (a source that ignores the signal still answers): the view moved on, and a
        // newer request for the same tile may be in flight.
        if (this.disposed || controller.signal.aborted) {
          if (isBitmap) (chunk.data as ImageBitmap).close?.();
          return;
        }
        this.pending.delete(key);
        const texture = this.device.createTexture({
          size: [chunk.width, chunk.height],
          format: this.plan.format,
          usage:
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_DST |
            // copyExternalImageToTexture requires RENDER_ATTACHMENT.
            (isBitmap ? GPUTextureUsage.RENDER_ATTACHMENT : 0),
        });
        if (isBitmap) {
          this.device.queue.copyExternalImageToTexture(
            { source: chunk.data as ImageBitmap },
            { texture },
            [chunk.width, chunk.height],
          );
        } else {
          this.device.queue.writeTexture(
            { texture },
            toUploadData(
              chunk.data as Uint8Array | Uint16Array | Float32Array,
              this.plan.format,
            ) as GPUAllowSharedBufferSource,
            { bytesPerRow: chunk.width * this.plan.bytesPerPixel, rowsPerImage: chunk.height },
            { width: chunk.width, height: chunk.height },
          );
        }
        this.cache.set(key, { texture, slots: [], frame: -1, used: 0 });
        this.opts.onNeedsRedraw();
      })
      .catch(() => {
        if (this.pending.get(key) === controller) this.pending.delete(key);
      });
  }

  /** Abort the fetches of tiles not in `wanted` (keys): the view has moved on from them. */
  private abortUnwanted(wanted: ReadonlySet<string>): void {
    for (const [key, controller] of this.pending) {
      if (wanted.has(key)) continue;
      controller.abort();
      this.pending.delete(key);
    }
  }

  /** The entry's next unused slot this frame, created on first need. */
  private slotFor(entry: TileEntry): DrawSlot {
    if (entry.frame !== this.frame) {
      entry.frame = this.frame;
      entry.used = 0;
    }
    let slot = entry.slots[entry.used];
    if (!slot) {
      const uniformBuffer = this.device.createBuffer({
        size: UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const bindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: this.srcSampler },
          { binding: 2, resource: entry.texture.createView() },
          { binding: 3, resource: this.lutSampler },
          { binding: 4, resource: this.lutTexture.createView() },
        ],
      });
      slot = { uniformBuffer, bindGroup };
      entry.slots.push(slot);
    }
    entry.used++;
    return slot;
  }

  private drawTile(
    pass: GPURenderPassEncoder,
    entry: TileEntry,
    mvp: Float32Array,
    tile: TileDraw,
  ): void {
    const slot = this.slotFor(entry);
    const s = this.scratch;
    s.set(mvp, 0);
    s[16] = tile.rect.width;
    s[17] = tile.rect.height;
    s[18] = tile.rect.x;
    s[19] = tile.rect.y;
    packImageDisplayUniforms(s, this.layer, this.plan.sampleScale, this.plan.isRgba);
    packUvRect(s, ...tile.uv);
    this.device.queue.writeBuffer(slot.uniformBuffer, 0, s);
    pass.setBindGroup(0, slot.bindGroup);
    pass.draw(6);
  }

  sync(): void {
    if (this.layer.blending !== this.currentBlend) {
      this.currentBlend = this.layer.blending;
      this.pipeline = this.buildPipeline(this.currentBlend);
    }
    if (this.layer.interpolation !== this.currentInterp) {
      this.currentInterp = this.layer.interpolation;
      this.srcSampler = this.createSrcSampler(this.currentInterp);
      this.cache.clear(); // tile bind groups reference the old sampler
    }
    if (this.layer.colormapVersion !== this.lutVersion) {
      this.lutVersion = this.layer.colormapVersion;
      this.writeLut();
    }
  }

  draw(pass: GPURenderPassEncoder, rv: RenderView): void {
    const { width, height, tileSize, levels, levelScales } = this.source;
    const cam = rv.camera2d;
    const z = rv.z;
    const view = worldViewport(cam.center[0], cam.center[1], cam.zoom, rv.vw, rv.vh);
    const target = selectLevel(cam.zoom, levels, levelScales);
    const mvp = multiply(
      cam.viewProjection(rv.vw, rv.vh),
      scaleTranslate2d(
        this.layer.scale[0],
        this.layer.scale[1],
        this.layer.translate[0],
        this.layer.translate[1],
      ),
    );

    pass.setPipeline(this.pipeline);
    this.frame++;

    const plan = planTiles(view, width, height, target, levels, tileSize, levelScales, (ref) =>
      this.cache.has(this.keyOf(ref.level, ref.col, ref.row, z)),
    );
    for (const d of plan.draws) {
      const entry = this.cache.get(this.keyOf(d.level, d.col, d.row, z));
      if (entry) this.drawTile(pass, entry, mvp, d);
    }
    const wanted = new Set<string>();
    for (const ref of plan.fetch) {
      wanted.add(this.keyOf(ref.level, ref.col, ref.row, z));
      this.request(ref, z);
    }
    this.abortUnwanted(wanted);
  }

  dispose(): void {
    this.disposed = true;
    this.abortUnwanted(new Set());
    this.cache.clear();
    this.lutTexture.destroy();
  }
}
