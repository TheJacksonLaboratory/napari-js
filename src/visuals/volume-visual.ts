import type { VolumeLayer } from '../layers/volume-layer';
import type { BlendMode } from '../layers/layer';
import { DEPTH_FORMAT, type LayerVisual, type RenderView } from './layer-visual';
import { multiply, scale3d, translate3d, invert, type Mat4 } from '../math/mat4';
import { buildLut, LUT_SIZE } from '../color/lut';
import { VOLUME_SHADER } from './volume-shader';
import { blendStateFor } from './blend';
import { halfSpace } from '../layers/volume-plane';
import { MAX_CLIPPING_PLANES } from '../layers/clipping';

/**
 * mat4(16) + vec4 params + vec4 params2 + vec4 dims + vec4 plane + vec4 plane2 +
 * vec4 clip[MAX_CLIPPING_PLANES] + mat4 mvp(16) — the layout of `U` in volume-shader.ts.
 */
const MVP_OFFSET = 36 + 4 * MAX_CLIPPING_PLANES;
export const VOLUME_UNIFORM_FLOATS = MVP_OFFSET + 16;
const UNIFORM_BYTES = VOLUME_UNIFORM_FLOATS * 4;
const STEPS = 192;

/**
 * Pack the per-frame uniforms (layout in volume-shader.ts) into `out`. Pure, so the packing —
 * the normalized window, the mode and the flags — is testable without a device. `mvp` (volume
 * space → clip space, `invMvp`'s inverse) places the depth each pixel is written at.
 */
export function packVolumeUniforms(
  out: Float32Array,
  layer: VolumeLayer,
  invMvp: Mat4,
  mvp: Mat4 = invert(invMvp),
): void {
  out.set(invMvp, 0);
  // The texture is r8unorm, so the shader sees samples in 0..1: normalize the window to match.
  const [lo, hi] = layer.contrastLimits;
  out[16] = lo / 255;
  out[17] = hi / 255;
  out[18] = layer.gamma;
  out[19] = layer.opacity;
  out[20] = layer.renderingCode();
  out[21] = layer.isoThreshold;
  out[22] = STEPS;
  out[23] = layer.invert ? 1 : 0;
  // dims: the voxel grid (the shader maps texture space to data coordinates) and the depiction.
  out[24] = layer.width;
  out[25] = layer.height;
  out[26] = layer.depth;
  out[27] = layer.depiction === 'plane' ? 1 : 0;
  // plane: the depicted plane as a half-space (unit normal, −dot(normal, position)).
  const plane = layer.plane;
  out.set(halfSpace(plane), 28);
  // plane2: half the slab's thickness (voxels), the clipping plane count, unused.
  const clipping = layer.clippingPlanes;
  out[32] = (plane.thickness ?? 1) / 2;
  out[33] = clipping.length;
  out[34] = 0;
  out[35] = 0;
  // clip: each clipping plane as a half-space, the rest zero.
  out.fill(0, 36, MVP_OFFSET);
  clipping.forEach((p, i) => out.set(halfSpace(p), 36 + 4 * i));
  out.set(mvp, MVP_OFFSET);
}

/**
 * Renders a {@link VolumeLayer} by fragment raymarching a 3D texture (see volume-shader.ts).
 * Builds `invMVP` (clip → volume [0,1]^3 space) each frame from the 3D camera and a model that
 * centers the `[w,h,d]` box at the origin. NJ-5+ uploads uint8 volumes (r8unorm 3D).
 */
export class VolumeVisual implements LayerVisual {
  readonly ndisplay = 3 as 2 | 3;

  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly scratch = new Float32Array(VOLUME_UNIFORM_FLOATS);
  private readonly texture: GPUTexture;
  private readonly lutTexture: GPUTexture;
  private readonly volSampler: GPUSampler;
  private readonly lutSampler: GPUSampler;
  private model: Float32Array;
  private bindGroup: GPUBindGroup;
  private pipeline: GPURenderPipeline;
  private currentBlend: BlendMode;
  private lutVersion: number;
  private geometryVersion: number;

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

    this.model = this.buildModel();
    this.geometryVersion = layer.geometryVersion;

    this.currentBlend = layer.blending;
    this.pipeline = this.buildPipeline(layer.blending);
    this.bindGroup = this.buildBindGroup();
  }

  // Model: map volume [0,1]^3 → world box centered at origin, sized by voxel dims × per-axis
  // voxelSize. voxelSize lets an anisotropic stack (e.g. XY downsampled but Z not) keep its true
  // proportions instead of the raw voxel-count aspect — the raymarch samples in normalized texture
  // space, so the box scale is independent of the sampling resolution. Rebuilt live when voxelSize
  // changes (e.g. a Z-height gizmo) — see `sync`.
  private buildModel(): Float32Array {
    const [sx, sy, sz] = this.layer.voxelSize;
    return multiply(
      scale3d(this.layer.width * sx, this.layer.height * sy, this.layer.depth * sz),
      translate3d(-0.5, -0.5, -0.5),
    );
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
      // The volume is a full-screen raymarch quad that writes the depth of what it shows (see
      // volume-shader.ts), so surfaces and points drawn after it are hidden where it is in front of
      // them. It is not depth-tested itself: channels added over each other stay whole.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
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
    if (this.layer.geometryVersion !== this.geometryVersion) {
      this.geometryVersion = this.layer.geometryVersion;
      this.model = this.buildModel();
    }
  }

  draw(pass: GPURenderPassEncoder, view: RenderView): void {
    const mvp = multiply(view.camera3d.viewProjection(view.vw, view.vh), this.model);
    const invMvp = invert(mvp);

    packVolumeUniforms(this.scratch, this.layer, invMvp, mvp);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.scratch);

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
