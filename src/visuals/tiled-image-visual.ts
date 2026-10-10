import type { ImageLayer, Interpolation } from '../layers/image-layer';
import type { BlendMode } from '../layers/layer';
import type { LayerVisual, RenderView } from './layer-visual';
import type { TiledSource } from '../io/texture-source';
import { multiply, scaleTranslate2d } from '../math/mat4';
import { selectLevel, visibleTiles, worldViewport, type VisibleTile } from '../io/pyramid';
import { LruCache } from '../cache/lru';
import { buildLut, LUT_SIZE } from '../color/lut';
import { GRAY } from '../color/colormap';
import { formatPlanFor, toUploadData, type FormatPlan } from './format-plan';
import { IMAGE_COLORMAP_SHADER } from './image-colormap-shader';
import { packImageDisplayUniforms } from './image-visual';
import { blendStateFor } from './blend';

const UNIFORM_FLOATS = 28;
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
const DEFAULT_TILE_CAPACITY = 192;

interface TileEntry {
  texture: GPUTexture;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
}

/**
 * Renders a pyramidal {@link TiledSource}: selects a pyramid level from zoom, draws the
 * visible tiles (fetched lazily and cached on the GPU with LRU eviction), and underlays the
 * coarsest level so pans/zooms never flash blank. Z-scrubbing fetches the new slice's tiles
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
  private readonly pending = new Set<string>();

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
      entry.uniformBuffer.destroy();
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

  /** Return a ready tile, or kick an async fetch and return undefined. */
  private ensureTile(level: number, col: number, row: number, z: number): TileEntry | undefined {
    const key = this.keyOf(level, col, row, z);
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.pending.has(key)) return undefined;

    this.pending.add(key);
    this.source
      .fetchTile({ level, col, row, z })
      .then((chunk) => {
        this.pending.delete(key);
        if (this.disposed) return;
        const isBitmap = typeof ImageBitmap !== 'undefined' && chunk.data instanceof ImageBitmap;
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
        const uniformBuffer = this.device.createBuffer({
          size: UNIFORM_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        const bindGroup = this.device.createBindGroup({
          layout: this.bindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: uniformBuffer } },
            { binding: 1, resource: this.srcSampler },
            { binding: 2, resource: texture.createView() },
            { binding: 3, resource: this.lutSampler },
            { binding: 4, resource: this.lutTexture.createView() },
          ],
        });
        this.cache.set(key, { texture, uniformBuffer, bindGroup });
        this.opts.onNeedsRedraw();
      })
      .catch(() => this.pending.delete(key));
    return undefined;
  }

  private drawTile(
    pass: GPURenderPassEncoder,
    entry: TileEntry,
    mvp: Float32Array,
    tile: VisibleTile,
  ): void {
    const s = this.scratch;
    s.set(mvp, 0);
    s[16] = tile.w;
    s[17] = tile.h;
    s[18] = tile.x;
    s[19] = tile.y;
    packImageDisplayUniforms(s, this.layer, this.plan.sampleScale, this.plan.isRgba);
    this.device.queue.writeBuffer(entry.uniformBuffer, 0, s);
    pass.setBindGroup(0, entry.bindGroup);
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

    // Coarse base underlay (skip for additive blending, where double-counting would be wrong).
    const coarse = levels - 1;
    if (this.layer.blending !== 'additive' && target !== coarse) {
      for (const tile of visibleTiles(view, width, height, coarse, tileSize, levelScales)) {
        const entry = this.ensureTile(coarse, tile.col, tile.row, z);
        if (entry) this.drawTile(pass, entry, mvp, tile);
      }
    }

    // Target level: draw ready tiles; kick fetches for the rest.
    for (const tile of visibleTiles(view, width, height, target, tileSize, levelScales)) {
      const entry = this.ensureTile(target, tile.col, tile.row, z);
      if (entry) this.drawTile(pass, entry, mvp, tile);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cache.clear();
    this.lutTexture.destroy();
  }
}
