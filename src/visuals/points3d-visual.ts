import type { Points3DLayer } from '../layers/points3d-layer';
import { POINTS3D_DATA_FLOATS, POINTS3D_STYLE_FLOATS } from '../layers/points3d-layer';
import type { BlendMode } from '../layers/layer';
import { DEPTH_FORMAT, type LayerVisual, type RenderView } from './layer-visual';
import { buildLut, LUT_SIZE } from '../color/lut';
import { POINTS3D_SHADER } from './points3d-shader';
import { blendStateFor } from './blend';

// Two instance buffers on different clocks: the static half moves with the dataset, the
// style half with every selection click. See the note in points3d-layer.ts.
const DATA_STRIDE = POINTS3D_DATA_FLOATS * 4; // [x,y,z,value] → 16 bytes
const STYLE_STRIDE = POINTS3D_STYLE_FLOATS * 4; // [alpha,sizeScale] → 8 bytes
const UNIFORM_FLOATS = 24; // mat4(16) + params vec4 + window vec4
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;

/**
 * Renders a {@link Points3DLayer} as instanced, screen-facing billboards (see points3d-shader.ts):
 * one quad per point, sized in screen pixels, colored by its value through the LUT, depth-tested
 * against the renderer's 3D depth buffer so points occlude correctly under the orbit camera.
 */
export class Points3DVisual implements LayerVisual {
  readonly ndisplay = 3 as 2 | 3;

  private readonly module: GPUShaderModule;
  private readonly uniformBuffer: GPUBuffer;
  private readonly scratch = new Float32Array(UNIFORM_FLOATS);
  private readonly instanceBuffer: GPUBuffer;
  private readonly styleBuffer: GPUBuffer;
  private readonly lutTexture: GPUTexture;
  private readonly lutSampler: GPUSampler;
  private readonly count: number;
  private bindGroup: GPUBindGroup;
  private pipeline: GPURenderPipeline;
  private currentBlend: BlendMode;
  private lutVersion: number;
  private dataVersion: number;
  private styleVersion: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly format: GPUTextureFormat,
    private readonly layer: Points3DLayer,
  ) {
    this.module = device.createShaderModule({ code: POINTS3D_SHADER });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const data = layer.buildInstanceData();
    const style = layer.buildStyleData();
    this.count = layer.count;
    this.instanceBuffer = device.createBuffer({
      size: Math.max(DATA_STRIDE, data.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.styleBuffer = device.createBuffer({
      size: Math.max(STYLE_STRIDE, style.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    if (data.byteLength > 0) {
      device.queue.writeBuffer(this.instanceBuffer, 0, data as GPUAllowSharedBufferSource);
      device.queue.writeBuffer(this.styleBuffer, 0, style as GPUAllowSharedBufferSource);
    }

    this.lutTexture = device.createTexture({
      size: [LUT_SIZE, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.writeLut();
    this.lutVersion = layer.colormapVersion;
    this.lutSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    this.currentBlend = layer.blending;
    this.dataVersion = layer.dataVersion;
    this.styleVersion = layer.styleVersion;
    this.pipeline = this.buildPipeline(layer.blending);
    this.bindGroup = this.buildBindGroup();
  }

  /** Re-upload the static half after the geometry or the scalars changed. */
  private writeInstances(): void {
    const data = this.layer.buildInstanceData();
    if (data.byteLength === 0) return;
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data as GPUAllowSharedBufferSource);
  }

  /** Re-upload only the style half — what a selection change actually touches. */
  private writeStyle(): void {
    const style = this.layer.buildStyleData();
    if (style.byteLength === 0) return;
    this.device.queue.writeBuffer(this.styleBuffer, 0, style as GPUAllowSharedBufferSource);
  }

  private buildPipeline(blend: BlendMode): GPURenderPipeline {
    return this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.module,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: DATA_STRIDE,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
              { shaderLocation: 1, offset: 12, format: 'float32' }, // value
            ],
          },
          {
            arrayStride: STYLE_STRIDE,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 2, offset: 0, format: 'float32' }, // per-point alpha
              { shaderLocation: 3, offset: 4, format: 'float32' }, // per-point size scale
            ],
          },
        ],
      },
      fragment: {
        module: this.module,
        entryPoint: 'fs',
        targets: [{ format: this.format, blend: blendStateFor(blend) }],
      },
      primitive: { topology: 'triangle-list' },
      // Billboards write depth at the point's center so they occlude within the 3D pass.
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' },
    });
  }

  private buildBindGroup(): GPUBindGroup {
    return this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.lutSampler },
        { binding: 2, resource: this.lutTexture.createView() },
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
    // The buffer is sized from the layer's count, which cannot change, so a data change is
    // always a rewrite in place rather than a reallocation.
    if (this.layer.dataVersion !== this.dataVersion) {
      this.dataVersion = this.layer.dataVersion;
      this.writeInstances();
    }
    // Separately, so a selection click does not re-upload the positions with it.
    if (this.layer.styleVersion !== this.styleVersion) {
      this.styleVersion = this.layer.styleVersion;
      this.writeStyle();
    }
  }

  draw(pass: GPURenderPassEncoder, view: RenderView): void {
    if (this.count === 0) return;
    const s = this.scratch;
    s.set(view.camera3d.viewProjection(view.vw, view.vh), 0);
    s[16] = view.vw;
    s[17] = view.vh;
    s[18] = this.layer.size;
    s[19] = this.layer.opacity;
    const [lo, hi] = this.layer.contrastLimits;
    s[20] = lo;
    s[21] = hi;
    s[22] = this.layer.gamma;
    s[23] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, s);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.instanceBuffer);
    pass.setVertexBuffer(1, this.styleBuffer);
    pass.draw(6, this.count);
  }

  dispose(): void {
    this.instanceBuffer.destroy();
    this.styleBuffer.destroy();
    this.lutTexture.destroy();
    this.uniformBuffer.destroy();
  }
}
