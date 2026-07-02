import type { VolumeLayer } from '../layers/volume-layer';
import type { BlendMode } from '../layers/layer';
import { DEPTH_FORMAT, type LayerVisual, type RenderView } from './layer-visual';
import { multiply, scale3d, translate3d, invert } from '../math/mat4';
import { buildLut, LUT_SIZE } from '../color/lut';
import { VOLUME_SHADER } from './volume-shader';
import { blendStateFor } from './blend';

const UNIFORM_FLOATS = 24; // mat4(16) + vec4 params + vec4 params2
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
const STEPS = 192;

/**
 * Renders a {@link VolumeLayer} by fragment raymarching a 3D texture (see volume-shader.ts).
 * Builds `invMVP` (clip → volume [0,1]^3 space) each frame from the 3D camera and a model that
 * centers the `[w,h,d]` box at the origin. NJ-5+ uploads uint8 volumes (r8unorm 3D).
 */
export class VolumeVisual implements LayerVisual {
  readonly ndisplay = 3 as 2 | 3;

  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly scratch = new Float32Array(UNIFORM_FLOATS);
  private readonly texture: GPUTexture;
  private readonly lutTexture: GPUTexture;
  private readonly volSampler: GPUSampler;
  private readonly lutSampler: GPUSampler;
  private readonly model: Float32Array;
  private bindGroup: GPUBindGroup;
  private pipeline: GPURenderPipeline;
  private currentBlend: BlendMode;
  private lutVersion: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly layer: VolumeLayer,
  ) {
    this.module = device.createShaderModule({ code: VOLUME_SHADER });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.texture = device.createTexture({
      size: [layer.width, layer.height, layer.depth],
      dimension: '3d',
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture: this.texture },
      layer.data as GPUAllowSharedBufferSource,
      { bytesPerRow: layer.width, rowsPerImage: layer.height },
      { width: layer.width, height: layer.height, depthOrArrayLayers: layer.depth },
    );

    this.lutTexture = device.createTexture({
      size: [LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.writeLut();
    this.lutVersion = layer.colormapVersion;

    this.volSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });
    this.lutSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    // Model: map volume [0,1]^3 → world box centered at origin, sized by voxel dims × per-axis
    // voxelSize. voxelSize lets an anisotropic stack (e.g. XY downsampled but Z not) keep its true
    // proportions instead of the raw voxel-count aspect — the raymarch samples in normalized
    // texture space, so the box scale is independent of the sampling resolution.
    const [sx, sy, sz] = layer.voxelSize;
    this.model = multiply(
      scale3d(layer.width * sx, layer.height * sy, layer.depth * sz),
      translate3d(-0.5, -0.5, -0.5),
    );

    this.currentBlend = layer.blending;
    this.pipeline = this.buildPipeline(layer.blending);
    this.bindGroup = this.buildBindGroup();
  }

  private buildPipeline(blend: BlendMode): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: this.module, entryPoint: 'vs' },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: blendStateFor(blend) }],
      },
      primitive: { topology: 'triangle-list' },
      // The volume is a full-screen raymarch quad: never depth-test or write, so it composites
      // exactly as before now that 3D passes carry a depth attachment.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
    });
  }

  private buildBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.volSampler },
        { binding: 2, resource: this.texture.createView() },
        { binding: 3, resource: this.lutSampler },
        { binding: 4, resource: this.lutTexture.createView() },
      ],
    });
  }

  private writeLut(): void {
    this.device.queue.writeTexture(
      { texture: this.lutTexture },
      buildLut(this.layer.colormap, LUT_SIZE),
      { bytesPerRow: LUT_SIZE * 4, rowsPerImage: 1 },
      { width: LUT_SIZE, height: 1 },
    );
  }

  sync(): void {
    if (this.layer.blending !== this.currentBlend) {
      this.currentBlend = this.layer.blending;
      this.pipeline = this.buildPipeline(this.currentBlend);
      this.bindGroup = this.buildBindGroup();
    }
    if (this.layer.colormapVersion !== this.lutVersion) {
      this.lutVersion = this.layer.colormapVersion;
      this.writeLut();
    }
  }

  draw(pass: GPURenderPassEncoder, view: RenderView): void {
    const mvp = multiply(view.camera3d.viewProjection(view.vw, view.vh), this.model);
    const invMvp = invert(mvp);

    const s = this.scratch;
    s.set(invMvp, 0);
    const [lo, hi] = this.layer.contrastLimits;
    s[16] = lo / 255;
    s[17] = hi / 255;
    s[18] = this.layer.gamma;
    s[19] = this.layer.opacity;
    s[20] = this.layer.renderingCode();
    s[21] = this.layer.isoThreshold;
    s[22] = STEPS;
    s[23] = 0;
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
