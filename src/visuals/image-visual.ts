import type { ImageLayer, Interpolation } from '../layers/image-layer';
import type { BlendMode } from '../layers/layer';
import { multiply, scaleTranslate2d } from '../math/mat4';
import { buildLut, LUT_SIZE } from '../color/lut';
import { GRAY } from '../color/colormap';
import type { TextureSource } from '../io/texture-source';
import type { LayerVisual, RenderView } from './layer-visual';
import { formatPlanFor, toUploadData, type FormatPlan } from './format-plan';
import { IMAGE_COLORMAP_SHADER } from './image-colormap-shader';
import { blendStateFor } from './blend';

const UNIFORM_FLOATS = 28; // 112 bytes: mat4(16) + vec2+pad(4) + vec4(4) + vec4(4)
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
/** Floats in the image shader's uniform block (shared with the tiled visual). */
export const IMAGE_UNIFORM_FLOATS = UNIFORM_FLOATS;

/**
 * Pack the display half of the image uniforms — `params` and `flags`, floats 20..27 (layout
 * in image-colormap-shader.ts). Shared by {@link ImageVisual} and the tiled visual so the two
 * cannot disagree, and pure so it is testable without a device. `sampleScale` maps data
 * units to the texture's sample units (1/255 for unorm8, 1 for float).
 */
export function packImageDisplayUniforms(
  out: Float32Array,
  layer: ImageLayer,
  sampleScale: number,
  isRgba: boolean,
): void {
  const [lo, hi] = layer.contrastLimits;
  out[20] = lo * sampleScale;
  out[21] = hi * sampleScale;
  out[22] = layer.gamma;
  out[23] = layer.opacity;
  out[24] = isRgba ? 1 : 0;
  out[25] = layer.invert ? 1 : 0;
  out[26] = layer.transparentBelow ? 1 : 0;
  out[27] = 0;
}

/** A {@link FormatPlan} plus the bytes to upload (null = external image via copyExternalImage). */
type UploadPlan = FormatPlan & { data: Uint8Array | Uint16Array | Float32Array | null };

function planUpload(source: TextureSource, float32Filterable: boolean): UploadPlan {
  if (source.kind === 'external') {
    return {
      format: 'rgba8unorm',
      bytesPerPixel: 4,
      filterable: true,
      sampleScale: 1 / 255,
      isRgba: true,
      data: null,
    };
  }
  if (source.kind === 'tiled') {
    throw new Error('ImageVisual does not render tiled sources; use TiledImageVisual.');
  }
  const plan = formatPlanFor(source.channels, source.dtype, float32Filterable);
  return { ...plan, data: toUploadData(source.data, plan.format) };
}

/**
 * Binds one {@link ImageLayer} to a WebGPU pipeline: uploads the source texture and colormap
 * LUT, and draws the layer each frame with its current display uniforms (the napari
 * `Vispy*Layer` wrapper analog). Supports uint8 (r8unorm/rgba8unorm) and uint16/float32
 * (r32float, native-precision windowing). Uses an explicit bind-group layout so unfilterable
 * float textures render correctly when `float32-filterable` is unavailable.
 */
export class ImageVisual implements LayerVisual {
  readonly ndisplay = 2 as 2 | 3;
  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly scratch = new Float32Array(UNIFORM_FLOATS);
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly plan: UploadPlan;

  private texture!: GPUTexture;
  private lutTexture!: GPUTexture;
  private srcSampler!: GPUSampler;
  private lutSampler!: GPUSampler;
  private pipeline!: GPURenderPipeline;
  private bindGroup!: GPUBindGroup;

  private currentBlend: BlendMode;
  private currentInterp: Interpolation;
  private lutVersion: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly layer: ImageLayer,
    opts: { float32Filterable: boolean } = { float32Filterable: false },
  ) {
    this.plan = planUpload(layer.source, opts.float32Filterable);
    this.module = device.createShaderModule({ code: IMAGE_COLORMAP_SHADER });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.buildBindGroupLayout();
    this.pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });

    this.uploadTexture();
    this.lutTexture = this.createLutTexture();
    this.currentInterp = layer.interpolation;
    this.srcSampler = this.createSrcSampler(layer.interpolation);
    this.lutSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.currentBlend = layer.blending;
    this.pipeline = this.buildPipeline(layer.blending);
    this.bindGroup = this.buildBindGroup();
    this.lutVersion = layer.colormapVersion;
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

  private uploadTexture(): void {
    const src = this.layer.source;
    if (src.kind === 'external') {
      this.texture = this.device.createTexture({
        size: [src.width, src.height],
        format: this.plan.format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture(
        { source: src.image },
        { texture: this.texture },
        [src.width, src.height],
      );
      return;
    }

    this.texture = this.device.createTexture({
      size: [src.width, src.height],
      format: this.plan.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.texture },
      this.plan.data as GPUAllowSharedBufferSource,
      { bytesPerRow: src.width * this.plan.bytesPerPixel, rowsPerImage: src.height },
      { width: src.width, height: src.height },
    );
  }

  private createLutTexture(): GPUTexture {
    const tex = this.device.createTexture({
      size: [LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.writeLut(tex);
    return tex;
  }

  private writeLut(tex: GPUTexture): void {
    const cmap = this.layer.colormap ?? GRAY;
    this.device.queue.writeTexture(
      { texture: tex },
      buildLut(cmap, LUT_SIZE),
      { bytesPerRow: LUT_SIZE * 4, rowsPerImage: 1 },
      { width: LUT_SIZE, height: 1 },
    );
  }

  private createSrcSampler(interp: Interpolation): GPUSampler {
    // Unfilterable float textures must use nearest filtering.
    const filter: GPUFilterMode =
      !this.plan.filterable || interp === 'nearest' ? 'nearest' : 'linear';
    return this.device.createSampler({
      magFilter: filter,
      minFilter: filter,
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
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

  private buildBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.srcSampler },
        { binding: 2, resource: this.texture.createView() },
        { binding: 3, resource: this.lutSampler },
        { binding: 4, resource: this.lutTexture.createView() },
      ],
    });
  }

  /** Reconcile GPU state with the layer's current properties (cheap; called before draw). */
  sync(): void {
    if (this.layer.blending !== this.currentBlend) {
      this.currentBlend = this.layer.blending;
      this.pipeline = this.buildPipeline(this.currentBlend);
    }
    if (this.layer.interpolation !== this.currentInterp) {
      this.currentInterp = this.layer.interpolation;
      this.srcSampler = this.createSrcSampler(this.currentInterp);
      this.bindGroup = this.buildBindGroup();
    }
    if (this.layer.colormapVersion !== this.lutVersion) {
      this.lutVersion = this.layer.colormapVersion;
      this.writeLut(this.lutTexture); // same texture object → no bind-group rebuild
    }
  }

  /** Encode a draw of this layer for the current view. */
  draw(pass: GPURenderPassEncoder, view: RenderView): void {
    const src = this.layer.source;
    const model = scaleTranslate2d(
      this.layer.scale[0],
      this.layer.scale[1],
      this.layer.translate[0],
      this.layer.translate[1],
    );
    const mvp = multiply(view.camera2d.viewProjection(view.vw, view.vh), model);

    const s = this.scratch;
    s.set(mvp, 0);
    s[16] = src.width;
    s[17] = src.height;
    s[18] = 0;
    s[19] = 0;
    packImageDisplayUniforms(s, this.layer, this.plan.sampleScale, this.plan.isRgba);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, s);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6);
  }

  dispose(): void {
    this.texture.destroy();
    this.lutTexture.destroy();
    this.uniformBuffer.destroy();
  }
}
